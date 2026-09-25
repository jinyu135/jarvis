$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$voiceDir = Join-Path $env:LOCALAPPDATA 'Jarvis\voice'
$exePath = Join-Path $voiceDir 'whisper-cli.exe'
$modelPath = Join-Path $voiceDir 'ggml-base.bin'
New-Item -ItemType Directory -Path $voiceDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $exePath)) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-cpu-arm64' } else { 'x64' }
    $archiveName = "whisper-bin-$arch.zip"
    $archiveUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/b5130/$archiveName"
    $archiveSha256 = if ($arch -eq 'win-cpu-arm64') {
        '799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc'
    } else {
        'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
    }
    $temporaryDir = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-whisper-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporaryDir -Force | Out-Null
    try {
        $archivePath = Join-Path $temporaryDir $archiveName
        Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing
        $actualArchiveSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualArchiveSha256 -ne $archiveSha256) { throw '음성 엔진 압축 파일의 해시가 일치하지 않습니다.' }
        $extractPath = Join-Path $temporaryDir 'unpacked'
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
        $foundExe = Get-ChildItem -LiteralPath $extractPath -Filter 'whisper-cli.exe' -Recurse -File | Select-Object -First 1
        if (-not $foundExe) { throw '다운로드한 압축 파일에서 whisper-cli.exe를 찾을 수 없습니다.' }
        Copy-Item -Path (Join-Path $foundExe.DirectoryName '*') -Destination $voiceDir -Recurse -Force
    }
    finally {
        Remove-Item -LiteralPath $temporaryDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath $modelPath)) {
    $downloadPath = "$modelPath.download"
    try {
        Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' -OutFile $downloadPath -UseBasicParsing
        $expectedSha1 = '465707469ff3a37a2b9b8d8f89f2f99de7299dac'
        $actualSha1 = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA1).Hash.ToLowerInvariant()
        if ($actualSha1 -ne $expectedSha1) { throw '음성 인식 모델의 해시가 일치하지 않습니다.' }
        Move-Item -LiteralPath $downloadPath -Destination $modelPath -Force
    }
    finally {
        Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath $exePath) -or -not (Test-Path -LiteralPath $modelPath)) {
    throw '음성 엔진 설치가 완료되지 않았습니다.'
}
