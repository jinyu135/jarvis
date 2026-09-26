param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('screenshot', 'list_windows', 'click', 'type_text', 'hotkey', 'scroll', 'top_memory_processes', 'search_files', 'get_file_info', 'copy_file', 'move_file', 'rename_file', 'recycle_file', 'launch_app', 'focus_window', 'system_resources', 'list_processes', 'terminate_process')]
    [string]$Action,

    [string]$Payload = ''
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    if (-not $Payload) {
        $Payload = [Console]::In.ReadToEnd().Trim()
    }
    if ($Payload) {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
        $request = ConvertFrom-Json -InputObject $json
    } else {
        $request = [pscustomobject]@{}
    }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DesktopBridge
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSE_LEFTDOWN = 0x0002;
    private const uint MOUSE_LEFTUP = 0x0004;
    private const uint MOUSE_RIGHTDOWN = 0x0008;
    private const uint MOUSE_RIGHTUP = 0x0010;
    private const uint MOUSE_MIDDLEDOWN = 0x0020;
    private const uint MOUSE_MIDDLEUP = 0x0040;
    private const uint MOUSE_WHEEL = 0x0800;
    private const uint KEY_EXTENDED = 0x0001;
    private const uint KEY_UP = 0x0002;
    private const uint KEY_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    public sealed class WindowInfo
    {
        public string handle { get; set; }
        public string title { get; set; }
        public uint processId { get; set; }
        public string processName { get; set; }
        public bool isForeground { get; set; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileTime
    {
        public uint low;
        public uint high;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint length;
        public uint load;
        public ulong totalPhysical;
        public ulong availablePhysical;
        public ulong totalPageFile;
        public ulong availablePageFile;
        public ulong totalVirtual;
        public ulong availableVirtual;
        public ulong availableExtendedVirtual;
    }

    public sealed class ResourceInfo
    {
        public double? cpuLoadPercent { get; set; }
        public long memoryTotalBytes { get; set; }
        public long memoryFreeBytes { get; set; }
        public double memoryUsedPercent { get; set; }
    }

    private delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximum);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr handle, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(out NativeFileTime idle, out NativeFileTime kernel, out NativeFileTime user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    private static void Submit(INPUT input)
    {
        if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows rejected the desktop input");
    }

    private static void Mouse(uint flags, uint data)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.data.mouse = new MOUSEINPUT { flags = flags, mouseData = data };
        Submit(input);
    }

    private static void Key(ushort virtualKey, ushort scanCode, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.data.keyboard = new KEYBDINPUT {
            virtualKey = virtualKey, scanCode = scanCode, flags = flags
        };
        Submit(input);
    }

    public static void MovePointer(int x, int y)
    {
        if (!SetCursorPos(x, y))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not move the pointer");
    }

    public static void Click(int x, int y, string button, int count)
    {
        if (count < 1 || count > 2) throw new ArgumentOutOfRangeException("count");
        uint down;
        uint up;
        switch (button.ToLowerInvariant()) {
            case "left": down = MOUSE_LEFTDOWN; up = MOUSE_LEFTUP; break;
            case "right": down = MOUSE_RIGHTDOWN; up = MOUSE_RIGHTUP; break;
            case "middle": down = MOUSE_MIDDLEDOWN; up = MOUSE_MIDDLEUP; break;
            default: throw new ArgumentException("Unsupported mouse button");
        }
        MovePointer(x, y);
        Thread.Sleep(35);
        for (int i = 0; i < count; i++) {
            Mouse(down, 0);
            Mouse(up, 0);
            if (i + 1 < count) Thread.Sleep(80);
        }
    }

    public static void Scroll(int ticks)
    {
        if (ticks == 0 || ticks < -20 || ticks > 20)
            throw new ArgumentOutOfRangeException("ticks");
        Mouse(MOUSE_WHEEL, unchecked((uint)(ticks * 120)));
    }

    public static void TypeUnicode(string text)
    {
        if (text == null) throw new ArgumentNullException("text");
        // SendInput's Unicode mode accepts UTF-16 code units, including Korean
        // and surrogate pairs, without using the clipboard or keyboard layout.
        foreach (char character in text) {
            Key(0, character, KEY_UNICODE);
            Key(0, character, KEY_UNICODE | KEY_UP);
        }
    }

    private static bool IsModifier(string key)
    {
        switch (key) {
            case "CTRL": case "CONTROL": case "ALT": case "SHIFT":
            case "WIN": case "WINDOWS": return true;
            default: return false;
        }
    }

    private static ushort VirtualKey(string key)
    {
        if (key.Length == 1) {
            char value = key[0];
            if ((value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9'))
                return (ushort)value;
        }
        if (key.Length >= 2 && key[0] == 'F') {
            int functionNumber;
            if (int.TryParse(key.Substring(1), out functionNumber) && functionNumber >= 1 && functionNumber <= 24)
                return (ushort)(0x70 + functionNumber - 1);
        }
        switch (key) {
            case "CTRL": case "CONTROL": return 0x11;
            case "ALT": return 0x12;
            case "SHIFT": return 0x10;
            case "WIN": case "WINDOWS": return 0x5B;
            case "ENTER": case "RETURN": return 0x0D;
            case "ESC": case "ESCAPE": return 0x1B;
            case "TAB": return 0x09;
            case "SPACE": return 0x20;
            case "BACKSPACE": return 0x08;
            case "DELETE": case "DEL": return 0x2E;
            case "INSERT": case "INS": return 0x2D;
            case "UP": return 0x26;
            case "DOWN": return 0x28;
            case "LEFT": return 0x25;
            case "RIGHT": return 0x27;
            case "HOME": return 0x24;
            case "END": return 0x23;
            case "PAGEUP": case "PGUP": return 0x21;
            case "PAGEDOWN": case "PGDN": return 0x22;
            case "PRINTSCREEN": return 0x2C;
            case "CAPSLOCK": return 0x14;
            default: throw new ArgumentException("Unsupported key: " + key);
        }
    }

    private static uint KeyFlags(ushort key)
    {
        switch (key) {
            case 0x21: case 0x22: case 0x23: case 0x24:
            case 0x25: case 0x26: case 0x27: case 0x28:
            case 0x2D: case 0x2E: case 0x5B: case 0x2C:
                return KEY_EXTENDED;
            default: return 0;
        }
    }

    public static void Hotkey(string[] rawKeys)
    {
        if (rawKeys == null || rawKeys.Length < 1 || rawKeys.Length > 5)
            throw new ArgumentException("Expected 1 to 5 keys");
        ushort[] keys = new ushort[rawKeys.Length];
        for (int i = 0; i < rawKeys.Length; i++) {
            string name = rawKeys[i].Trim().ToUpperInvariant();
            if (i < rawKeys.Length - 1 && !IsModifier(name))
                throw new ArgumentException("Only modifiers may precede the final key");
            keys[i] = VirtualKey(name);
        }
        int pressed = 0;
        try {
            for (int i = 0; i < keys.Length; i++) {
                Key(keys[i], 0, KeyFlags(keys[i]));
                pressed++;
            }
        } finally {
            for (int i = pressed - 1; i >= 0; i--)
                Key(keys[i], 0, KeyFlags(keys[i]) | KEY_UP);
        }
    }

    public static WindowInfo[] ListWindows()
    {
        List<WindowInfo> windows = new List<WindowInfo>();
        IntPtr foreground = GetForegroundWindow();
        EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
            if (!IsWindowVisible(handle)) return true;
            int length = GetWindowTextLength(handle);
            if (length <= 0) return true;
            StringBuilder title = new StringBuilder(length + 1);
            GetWindowText(handle, title, title.Capacity);
            if (title.Length == 0) return true;
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            string processName = "";
            try {
                using (Process process = Process.GetProcessById((int)processId))
                    processName = process.ProcessName;
            } catch { }
            windows.Add(new WindowInfo {
                handle = "0x" + handle.ToInt64().ToString("X"),
                title = title.ToString(), processId = processId,
                processName = processName, isForeground = handle == foreground
            });
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static bool FocusWindow(long rawHandle)
    {
        IntPtr handle = new IntPtr(rawHandle);
        if (!IsWindow(handle)) throw new ArgumentException("The window handle is no longer valid");
        ShowWindow(handle, 9); // SW_RESTORE
        if (!SetForegroundWindow(handle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows did not allow that window to become foreground");
        return true;
    }

    private static ulong FileTimeValue(NativeFileTime time)
    {
        return ((ulong)time.high << 32) | time.low;
    }

    public static double? MeasureCpuLoad()
    {
        NativeFileTime idleBefore, kernelBefore, userBefore;
        NativeFileTime idleAfter, kernelAfter, userAfter;
        if (!GetSystemTimes(out idleBefore, out kernelBefore, out userBefore)) return null;
        Thread.Sleep(300);
        if (!GetSystemTimes(out idleAfter, out kernelAfter, out userAfter)) return null;
        ulong idleDelta = FileTimeValue(idleAfter) - FileTimeValue(idleBefore);
        ulong totalDelta = FileTimeValue(kernelAfter) - FileTimeValue(kernelBefore) + FileTimeValue(userAfter) - FileTimeValue(userBefore);
        if (totalDelta == 0) return null;
        double load = 100.0 * (1.0 - (double)idleDelta / totalDelta);
        return Math.Round(Math.Max(0.0, Math.Min(100.0, load)), 1);
    }

    public static ResourceInfo ReadMemory()
    {
        MemoryStatus status = new MemoryStatus();
        status.length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
        if (!GlobalMemoryStatusEx(ref status)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read Windows memory status");
        return new ResourceInfo {
            memoryTotalBytes = (long)status.totalPhysical,
            memoryFreeBytes = (long)status.availablePhysical,
            memoryUsedPercent = Math.Round(100.0 * (status.totalPhysical - status.availablePhysical) / status.totalPhysical, 1)
        };
    }
}
'@

    switch ($Action) {
        'screenshot' {
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
            if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
                throw 'No interactive desktop is available for a screenshot.'
            }
            $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $stream = New-Object System.IO.MemoryStream
            try {
                $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
                $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                $result = @{
                    originX = $bounds.Left
                    originY = $bounds.Top
                    width = $bounds.Width
                    height = $bounds.Height
                    data = [Convert]::ToBase64String($stream.ToArray())
                }
            } finally {
                $stream.Dispose()
                $graphics.Dispose()
                $bitmap.Dispose()
            }
        }
        'list_windows' {
            $windows = @([DesktopBridge]::ListWindows())
            $result = @{ windows = $windows; count = $windows.Count }
        }
        'click' {
            [DesktopBridge]::Click([int]$request.x, [int]$request.y, [string]$request.button, [int]$request.count)
            $result = @{ clicked = $true; x = [int]$request.x; y = [int]$request.y; button = [string]$request.button; count = [int]$request.count }
        }
        'type_text' {
            [DesktopBridge]::TypeUnicode([string]$request.text)
            $result = @{ typed = $true; characters = ([string]$request.text).Length }
        }
        'hotkey' {
            $keys = [string[]]@($request.keys)
            [DesktopBridge]::Hotkey($keys)
            $result = @{ pressed = $true; keys = $keys }
        }
        'scroll' {
            if ($null -ne $request.x -and $null -ne $request.y) {
                [DesktopBridge]::MovePointer([int]$request.x, [int]$request.y)
            }
            [DesktopBridge]::Scroll([int]$request.ticks)
            $result = @{ scrolled = $true; ticks = [int]$request.ticks }
        }
        'top_memory_processes' {
            $processes = @(
                Get-Process | ForEach-Object {
                    try {
                        $hasWindow = $_.MainWindowHandle.ToInt64() -ne 0
                        if (-not $request.backgroundOnly -or -not $hasWindow) {
                            [pscustomobject]@{
                                processId = $_.Id
                                name = $_.ProcessName
                                workingSetBytes = [long]$_.WorkingSet64
                                privateBytes = [long]$_.PrivateMemorySize64
                                workingSetMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
                                hasMainWindow = $hasWindow
                                windowTitle = $_.MainWindowTitle
                            }
                        }
                    } catch {
                        # Some protected system processes do not expose every property.
                    }
                } | Sort-Object -Property workingSetBytes -Descending | Select-Object -First ([int]$request.limit)
            )
            $result = @{ processes = $processes; count = $processes.Count; backgroundOnly = [bool]$request.backgroundOnly }
        }
        'search_files' {
            $rootPath = [string]$request.rootPath
            if ([string]::IsNullOrWhiteSpace($rootPath)) { $rootPath = $env:USERPROFILE }
            $root = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($rootPath))
            if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Search folder does not exist.' }
            $volumeRoot = [IO.Path]::GetPathRoot($root)
            if ($root.TrimEnd('\') -eq $volumeRoot.TrimEnd('\')) { throw 'Searching a whole drive is disabled. Choose a specific folder.' }
            $pattern = [string]$request.namePattern
            if ([string]::IsNullOrWhiteSpace($pattern)) { $pattern = '*' }
            if ($pattern -match '[\\/]') { throw 'Search pattern must be a file name, not a path.' }
            $limit = [Math]::Max(1, [Math]::Min(100, [int]$request.limit))
            $pending = [System.Collections.Generic.Stack[string]]::new()
            $pending.Push($root)
            $found = [System.Collections.Generic.List[object]]::new()
            $scanned = 0
            $maxScanned = 50000
            while ($pending.Count -gt 0 -and $found.Count -lt $limit -and $scanned -lt $maxScanned) {
                $folder = $pending.Pop()
                try { $entries = @(Get-ChildItem -LiteralPath $folder -Force -ErrorAction Stop) }
                catch { if ($folder -eq $root) { throw }; continue }
                foreach ($entry in $entries) {
                    $scanned++
                    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                    if ($entry.PSIsContainer) {
                        $pending.Push($entry.FullName)
                        continue
                    }
                    if ($entry.Name -like $pattern) {
                        $found.Add([pscustomobject]@{
                            path = $entry.FullName
                            name = $entry.Name
                            extension = $entry.Extension
                            sizeBytes = [long]$entry.Length
                            modifiedAt = $entry.LastWriteTimeUtc.ToString('o')
                        })
                        if ($found.Count -ge $limit) { break }
                    }
                    if ($scanned -ge $maxScanned) { break }
                }
            }
            $result = @{ rootPath = $root; files = @($found); count = $found.Count; scannedEntries = $scanned; partial = ($pending.Count -gt 0 -or $scanned -ge $maxScanned) }
        }
        'get_file_info' {
            $target = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$request.path))
            $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
            $size = if ($item.PSIsContainer) { $null } else { [long]$item.Length }
            $result = @{ path = $item.FullName; name = $item.Name; isDirectory = [bool]$item.PSIsContainer; sizeBytes = $size; extension = $item.Extension; modifiedAt = $item.LastWriteTimeUtc.ToString('o'); attributes = [string]$item.Attributes }
        }
        'copy_file' {
            $source = Get-Item -LiteralPath ([IO.Path]::GetFullPath([string]$request.sourcePath)) -Force -ErrorAction Stop
            if ($source.PSIsContainer -or (($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Only regular files can be copied.' }
            $destination = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$request.destinationPath))
            $parent = [IO.Path]::GetDirectoryName($destination)
            if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Destination folder does not exist.' }
            if (Test-Path -LiteralPath $destination) { throw 'Destination already exists. Overwriting is disabled.' }
            [IO.File]::Copy($source.FullName, $destination, $false)
            $result = @{ copied = $true; sourcePath = $source.FullName; destinationPath = $destination; sizeBytes = [long]$source.Length }
        }
        'move_file' {
            $source = Get-Item -LiteralPath ([IO.Path]::GetFullPath([string]$request.sourcePath)) -Force -ErrorAction Stop
            if ($source.PSIsContainer -or (($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Only regular files can be moved.' }
            $destination = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$request.destinationPath))
            $parent = [IO.Path]::GetDirectoryName($destination)
            if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Destination folder does not exist.' }
            if (Test-Path -LiteralPath $destination) { throw 'Destination already exists. Overwriting is disabled.' }
            [IO.File]::Move($source.FullName, $destination)
            $result = @{ moved = $true; sourcePath = $source.FullName; destinationPath = $destination; sizeBytes = [long]$source.Length }
        }
        'rename_file' {
            $source = Get-Item -LiteralPath ([IO.Path]::GetFullPath([string]$request.path)) -Force -ErrorAction Stop
            if ($source.PSIsContainer -or (($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Only regular files can be renamed.' }
            $newName = [string]$request.newName
            if ([string]::IsNullOrWhiteSpace($newName) -or [IO.Path]::GetFileName($newName) -ne $newName -or $newName -match '[\\/:*?"<>|]') { throw 'New name must be a single valid file name.' }
            $destination = Join-Path -Path $source.DirectoryName -ChildPath $newName
            if (Test-Path -LiteralPath $destination) { throw 'Destination already exists. Overwriting is disabled.' }
            [IO.File]::Move($source.FullName, $destination)
            $result = @{ renamed = $true; oldPath = $source.FullName; newPath = $destination }
        }
        'recycle_file' {
            $target = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$request.path))
            $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
            Add-Type -AssemblyName Microsoft.VisualBasic
            $ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
            $recycle = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
            if ($item.PSIsContainer) {
                [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($item.FullName, $ui, $recycle)
            } else {
                [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($item.FullName, $ui, $recycle)
            }
            $result = @{ recycled = $true; path = $item.FullName; permanentDelete = $false }
        }
        'launch_app' {
            $target = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$request.path))
            if ([IO.Path]::GetExtension($target) -ne '.exe' -or -not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Application executable does not exist.' }
            $process = Start-Process -FilePath $target -PassThru -ErrorAction Stop
            $result = @{ launched = $true; path = $target; processId = $process.Id; processName = $process.ProcessName }
        }
        'focus_window' {
            $rawHandle = [Convert]::ToInt64(([string]$request.handle).Substring(2), 16)
            [void][DesktopBridge]::FocusWindow($rawHandle)
            $result = @{ focused = $true; handle = [string]$request.handle }
        }
        'system_resources' {
            $memory = [DesktopBridge]::ReadMemory()
            $drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [IO.DriveType]::Fixed -and $_.IsReady } | ForEach-Object {
                try { [pscustomobject]@{ name = $_.Name; sizeBytes = [long]$_.TotalSize; freeBytes = [long]$_.AvailableFreeSpace; usedPercent = if ($_.TotalSize) { [math]::Round(100 * ($_.TotalSize - $_.AvailableFreeSpace) / $_.TotalSize, 1) } else { $null } } } catch { }
            })
            $result = @{ cpuLoadPercent = [DesktopBridge]::MeasureCpuLoad(); memoryTotalBytes = $memory.memoryTotalBytes; memoryFreeBytes = $memory.memoryFreeBytes; memoryUsedPercent = $memory.memoryUsedPercent; drives = $drives; sampledAt = [DateTime]::UtcNow.ToString('o') }
        }
        'list_processes' {
            $limit = [Math]::Max(1, [Math]::Min(100, [int]$request.limit))
            $nameContains = [string]$request.nameContains
            $processes = @(Get-Process | ForEach-Object {
                try {
                    if (-not $nameContains -or $_.ProcessName.IndexOf($nameContains, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                        [pscustomobject]@{ processId = $_.Id; name = $_.ProcessName; workingSetBytes = [long]$_.WorkingSet64; privateBytes = [long]$_.PrivateMemorySize64; workingSetMB = [math]::Round($_.WorkingSet64 / 1MB, 1); hasMainWindow = ($_.MainWindowHandle.ToInt64() -ne 0); windowTitle = $_.MainWindowTitle }
                    }
                } catch { }
            } | Sort-Object -Property workingSetBytes -Descending | Select-Object -First $limit)
            $result = @{ processes = $processes; count = $processes.Count; nameContains = $nameContains }
        }
        'terminate_process' {
            $processId = [int]$request.processId
            $process = Get-Process -Id $processId -ErrorAction Stop
            $expectedName = [string]$request.processName
            if (-not [string]::Equals($process.ProcessName, $expectedName, [StringComparison]::OrdinalIgnoreCase)) { throw 'Process ID now belongs to a different process. Refresh the process list.' }
            if ($processId -in @(0, 4, $PID) -or $process.ProcessName -in @('System', 'Idle', 'Registry', 'smss', 'csrss', 'wininit', 'services', 'lsass')) { throw 'Windows core and current tool processes are protected.' }
            Stop-Process -Id $processId -ErrorAction Stop
            $result = @{ terminated = $true; processId = $processId; processName = $expectedName }
        }
    }

    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
