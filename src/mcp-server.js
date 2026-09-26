'use strict';

// A small MCP stdio server. Keep stdout reserved for JSON-RPC messages.
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const SCRIPT = path.join(__dirname, 'desktop.ps1');
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 80000;
const APPROVAL_TIMEOUT_MS = 75000;
let nextElicitationId = 1;
const pendingElicitations = new Map();

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});
const integer = (description) => ({ type: 'integer', description });
const string = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'desktop_screenshot',
    description: 'Capture the entire interactive Windows desktop, including all monitors. The image is at native resolution; use its virtual-screen origin when choosing click coordinates.',
    inputSchema: objectSchema()
  },
  {
    name: 'desktop_list_windows',
    description: 'List visible, titled top-level Windows windows with titles, process IDs, names, handles, and foreground state.',
    inputSchema: objectSchema()
  },
  {
    name: 'desktop_click',
    description: 'Move the pointer to a virtual-screen coordinate and click once. Inspect a fresh screenshot before acting on an unfamiliar screen.',
    inputSchema: objectSchema({
      x: integer('Virtual-screen X coordinate; may be negative on a monitor left of the primary display.'),
      y: integer('Virtual-screen Y coordinate; may be negative on a monitor above the primary display.'),
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button, default left.' }
    }, ['x', 'y'])
  },
  {
    name: 'desktop_double_click',
    description: 'Move the pointer to a virtual-screen coordinate and double-click the left mouse button.',
    inputSchema: objectSchema({
      x: integer('Virtual-screen X coordinate.'),
      y: integer('Virtual-screen Y coordinate.')
    }, ['x', 'y'])
  },
  {
    name: 'desktop_type_text',
    description: 'Type Unicode text into the currently focused control using Windows Unicode keyboard input. Supports Korean and other non-ASCII text.',
    inputSchema: objectSchema({
      text: string('Text to type into the focused control, up to 20,000 UTF-16 code units.')
    }, ['text'])
  },
  {
    name: 'desktop_hotkey',
    description: 'Press one key or a combination such as ["CTRL", "SHIFT", "ESC"] or ["WIN", "E"]. Modifiers are pressed before the final key.',
    inputSchema: objectSchema({
      keys: {
        type: 'array', minItems: 1, maxItems: 5,
        items: { type: 'string' },
        description: 'Modifier names CTRL, ALT, SHIFT, WIN, followed by one key name, letter, digit, or F1-F24.'
      }
    }, ['keys'])
  },
  {
    name: 'desktop_scroll',
    description: 'Scroll the Windows desktop at the current pointer position, or move to x/y first. Positive ticks scroll up; negative ticks scroll down.',
    inputSchema: objectSchema({
      ticks: integer('Signed number of wheel notches, from -20 to 20.'),
      x: integer('Optional virtual-screen X coordinate. Provide both x and y.'),
      y: integer('Optional virtual-screen Y coordinate. Provide both x and y.')
    }, ['ticks'])
  },
  {
    name: 'desktop_top_memory_processes',
    description: 'Show Windows processes using the most physical memory, including process IDs, names, memory totals, and whether each has a main window. backgroundOnly filters to processes without a main window.',
    inputSchema: objectSchema({
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of processes, default 10.' },
      backgroundOnly: { type: 'boolean', description: 'Only processes without a main window, default false.' }
    })
  },
  {
    name: 'desktop_search_files',
    description: 'Search files on demand inside one requested folder. Defaults to the current user profile. Never search a drive root or scan the whole disk. Skips directory links and stops after the result/scan limit.',
    inputSchema: objectSchema({
      rootPath: string('The specific folder named by the user. Defaults to the current Windows user profile.'),
      namePattern: string('A file name or wildcard pattern such as *.pdf. Do not include folder separators.'),
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum matching files to return, default 30.' }
    })
  },
  {
    name: 'desktop_get_file_info',
    description: 'Read basic metadata for one exact file or folder path. Does not read file contents.',
    inputSchema: objectSchema({ path: string('Exact existing file or folder path.') }, ['path'])
  },
  {
    name: 'desktop_copy_file',
    description: 'Copy one file to an exact destination path. Refuses to overwrite any existing file.',
    inputSchema: objectSchema({
      sourcePath: string('Exact existing source file path.'),
      destinationPath: string('Exact destination file path, including its new file name. It must not already exist.')
    }, ['sourcePath', 'destinationPath'])
  },
  {
    name: 'desktop_move_file',
    description: 'Move one file to an exact destination path. Refuses to overwrite any existing file.',
    inputSchema: objectSchema({
      sourcePath: string('Exact existing source file path.'),
      destinationPath: string('Exact destination file path, including its new file name. It must not already exist.')
    }, ['sourcePath', 'destinationPath'])
  },
  {
    name: 'desktop_rename_file',
    description: 'Rename one file in its current folder. The new name must be a single file name and must not already exist.',
    inputSchema: objectSchema({
      path: string('Exact existing file path.'),
      newName: string('New file name only, with no path separators.')
    }, ['path', 'newName'])
  },
  {
    name: 'desktop_recycle_file',
    description: 'Move one exact file or folder to the Windows Recycle Bin. This tool has a per-call user approval prompt. Permanent deletion is not available.',
    inputSchema: objectSchema({ path: string('Exact existing file or folder path to place in the Recycle Bin.') }, ['path'])
  },
  {
    name: 'desktop_launch_app',
    description: 'Launch one already-installed Windows application executable by its exact path. Does not accept command-line arguments. Do not launch installers; ask for approval first using confirm_high_impact.',
    inputSchema: objectSchema({ path: string('Exact path to an installed .exe application.') }, ['path'])
  },
  {
    name: 'desktop_focus_window',
    description: 'Bring a visible window to the foreground using the exact handle returned by desktop_list_windows.',
    inputSchema: objectSchema({ handle: string('Exact window handle returned by desktop_list_windows.') }, ['handle'])
  },
  {
    name: 'desktop_system_resources',
    description: 'Show a current snapshot of processor load, memory, and fixed-drive capacity.',
    inputSchema: objectSchema()
  },
  {
    name: 'desktop_list_processes',
    description: 'List running processes sorted by physical memory use, optionally filtered by a process name substring.',
    inputSchema: objectSchema({
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum processes to return, default 30.' },
      nameContains: string('Optional process name substring filter.')
    })
  },
  {
    name: 'desktop_terminate_process',
    description: 'Terminate one process by PID and exact process name. A per-call user approval prompt is required before it runs.',
    inputSchema: objectSchema({
      processId: integer('Exact process ID from a fresh desktop_list_processes result.'),
      processName: string('Exact process name from that same result, without an .exe suffix.')
    }, ['processId', 'processName'])
  },
  {
    name: 'confirm_high_impact',
    description: 'Approval checkpoint before an irreversible or consequential desktop action, such as deleting files, installing software, sending a message, or changing system settings. This tool performs no action. State the exact action in the arguments. Configure this tool with approval_mode="prompt" in Codex.',
    inputSchema: objectSchema({
      action: string('Precise action the assistant intends to take after approval.'),
      target: string('Files, app, recipient, or setting affected by the action.')
    }, ['action', 'target'])
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function rpcError(id, code, message) {
  send({ id, error: { code, message } });
}

function invalid(message) {
  throw new Error(`Invalid tool arguments: ${message}`);
}

function requiredObject(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('expected an object');
  return value;
}

function coordinate(value, name) {
  if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
    invalid(`${name} must be a 32-bit integer`);
  }
  return value;
}

function runDesktop(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, '-Action', action
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${action} timed out`));
    }, TOOL_TIMEOUT_MS);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error(`${action} returned too much data`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => finish(error));
    // Stdin avoids Windows' command-line length limit for long Unicode text.
    child.stdin.on('error', (error) => finish(error));
    child.stdin.end(encoded);
    child.on('close', (code) => {
      const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
      if (diagnostic) process.stderr.write(`[desktop.ps1] ${diagnostic}\n`);
      if (code !== 0) {
        finish(new Error(diagnostic || `${action} failed with exit code ${code}`));
        return;
      }
      try {
        finish(null, JSON.parse(Buffer.concat(stdout).toString('utf8').trim()));
      } catch (error) {
        finish(new Error(`${action} returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function requestUserApproval(message) {
  const id = `jarvis-approval-${nextElicitationId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingElicitations.delete(id);
      reject(new Error('사용자 승인 대기 시간이 지났습니다. 작업은 실행하지 않았습니다.'));
    }, APPROVAL_TIMEOUT_MS);
    pendingElicitations.set(id, (response) => {
      clearTimeout(timer);
      if (response?.error) reject(new Error(response.error.message || '승인 응답을 받지 못했습니다.'));
      else resolve(response?.result);
    });
    send({ id, method: 'elicitation/create', params: {
      mode: 'form',
      message,
      requestedSchema: { type: 'object', properties: {} }
    } });
  });
}

async function callTool(name, rawArgs, desktopRunner = runDesktop, approvalRequester = requestUserApproval) {
  const args = requiredObject(rawArgs);
  switch (name) {
    case 'desktop_screenshot': {
      const image = await desktopRunner('screenshot');
      if (typeof image.data !== 'string' || !image.data) throw new Error('Screenshot data was missing');
      return { content: [
        { type: 'text', text: JSON.stringify({
          originX: image.originX, originY: image.originY,
          width: image.width, height: image.height,
          coordinateSystem: 'virtual Windows desktop pixels'
        }) },
        { type: 'image', data: image.data, mimeType: 'image/png' }
      ] };
    }
    case 'desktop_list_windows':
      return textResult(await desktopRunner('list_windows'));
    case 'desktop_click': {
      const x = coordinate(args.x, 'x');
      const y = coordinate(args.y, 'y');
      const button = args.button === undefined ? 'left' : args.button;
      if (!['left', 'right', 'middle'].includes(button)) invalid('button must be left, right, or middle');
      return textResult(await desktopRunner('click', { x, y, button, count: 1 }));
    }
    case 'desktop_double_click':
      return textResult(await desktopRunner('click', {
        x: coordinate(args.x, 'x'), y: coordinate(args.y, 'y'), button: 'left', count: 2
      }));
    case 'desktop_type_text':
      if (typeof args.text !== 'string' || args.text.length > 20000) invalid('text must be a string up to 20,000 UTF-16 code units');
      return textResult(await desktopRunner('type_text', { text: args.text }));
    case 'desktop_hotkey':
      if (!Array.isArray(args.keys) || args.keys.length < 1 || args.keys.length > 5 ||
          args.keys.some((key) => typeof key !== 'string' || key.length < 1 || key.length > 20)) {
        invalid('keys must contain 1 to 5 short key names');
      }
      return textResult(await desktopRunner('hotkey', { keys: args.keys }));
    case 'desktop_scroll': {
      const ticks = args.ticks;
      if (!Number.isInteger(ticks) || ticks < -20 || ticks > 20 || ticks === 0) invalid('ticks must be a nonzero integer from -20 to 20');
      if ((args.x === undefined) !== (args.y === undefined)) invalid('x and y must be provided together');
      const payload = { ticks };
      if (args.x !== undefined) {
        payload.x = coordinate(args.x, 'x');
        payload.y = coordinate(args.y, 'y');
      }
      return textResult(await desktopRunner('scroll', payload));
    }
    case 'desktop_top_memory_processes': {
      const limit = args.limit === undefined ? 10 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid('limit must be from 1 to 50');
      const backgroundOnly = args.backgroundOnly === undefined ? false : args.backgroundOnly;
      if (typeof backgroundOnly !== 'boolean') invalid('backgroundOnly must be boolean');
      return textResult(await desktopRunner('top_memory_processes', { limit, backgroundOnly }));
    }
    case 'desktop_search_files': {
      const rootPath = args.rootPath === undefined ? '' : args.rootPath;
      if (typeof rootPath !== 'string' || rootPath.length > 1000) invalid('rootPath must be a path under 1,000 characters');
      const namePattern = args.namePattern === undefined ? '*' : args.namePattern;
      if (typeof namePattern !== 'string' || !namePattern.trim() || namePattern.length > 260 || /[\\/]/.test(namePattern)) {
        invalid('namePattern must be a file name pattern without folder separators');
      }
      const limit = args.limit === undefined ? 30 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be from 1 to 100');
      return textResult(await desktopRunner('search_files', { rootPath, namePattern, limit }));
    }
    case 'desktop_get_file_info':
      if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 1000) invalid('path must be non-empty and under 1,000 characters');
      return textResult(await desktopRunner('get_file_info', { path: args.path }));
    case 'desktop_copy_file':
    case 'desktop_move_file': {
      if (typeof args.sourcePath !== 'string' || !args.sourcePath.trim() || args.sourcePath.length > 1000 ||
          typeof args.destinationPath !== 'string' || !args.destinationPath.trim() || args.destinationPath.length > 1000) {
        invalid('sourcePath and destinationPath must be non-empty paths under 1,000 characters');
      }
      const action = name === 'desktop_copy_file' ? 'copy_file' : 'move_file';
      return textResult(await desktopRunner(action, { sourcePath: args.sourcePath, destinationPath: args.destinationPath }));
    }
    case 'desktop_rename_file':
      if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 1000 ||
          typeof args.newName !== 'string' || !args.newName.trim() || args.newName.length > 260 || /[\\/]/.test(args.newName)) {
        invalid('path must be a file path and newName must be a single file name');
      }
      return textResult(await desktopRunner('rename_file', { path: args.path, newName: args.newName }));
    case 'desktop_recycle_file': {
      if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 1000) invalid('path must be non-empty and under 1,000 characters');
      const approval = await approvalRequester(`휴지통으로 이동할까요?\n대상: ${args.path}\n영향: 파일 또는 폴더가 휴지통으로 이동합니다. 이 베타에서는 영구 삭제를 할 수 없습니다.`);
      if (approval?.action !== 'accept') throw new Error('사용자가 작업을 허용하지 않았습니다. 파일은 이동하지 않았습니다.');
      return textResult(await desktopRunner('recycle_file', { path: args.path }));
    }
    case 'desktop_launch_app':
      if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 1000 || !/\.exe$/i.test(args.path)) {
        invalid('path must identify one .exe application file');
      }
      return textResult(await desktopRunner('launch_app', { path: args.path }));
    case 'desktop_focus_window':
      if (typeof args.handle !== 'string' || !/^0x[0-9a-f]+$/i.test(args.handle)) invalid('handle must be a hexadecimal window handle from desktop_list_windows');
      return textResult(await desktopRunner('focus_window', { handle: args.handle }));
    case 'desktop_system_resources':
      return textResult(await desktopRunner('system_resources'));
    case 'desktop_list_processes': {
      const limit = args.limit === undefined ? 30 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be from 1 to 100');
      const nameContains = args.nameContains === undefined ? '' : args.nameContains;
      if (typeof nameContains !== 'string' || nameContains.length > 100) invalid('nameContains must be a string under 100 characters');
      return textResult(await desktopRunner('list_processes', { limit, nameContains }));
    }
    case 'desktop_terminate_process': {
      if (!Number.isSafeInteger(args.processId) || args.processId < 1 || args.processId > 2147483647 ||
          typeof args.processName !== 'string' || !/^[\w.-]{1,100}$/.test(args.processName)) {
        invalid('processId and exact processName are required');
      }
      const approval = await approvalRequester(`이 프로세스를 종료할까요?\n대상: ${args.processName} (PID ${args.processId})\n영향: 이 프로그램의 현재 작업이 저장되지 않은 상태라면 손실될 수 있습니다.`);
      if (approval?.action !== 'accept') throw new Error('사용자가 프로세스 종료를 허용하지 않았습니다. 프로세스는 계속 실행 중입니다.');
      return textResult(await desktopRunner('terminate_process', { processId: args.processId, processName: args.processName }));
    }
    case 'confirm_high_impact':
      if (typeof args.action !== 'string' || !args.action.trim() || args.action.length > 1000 ||
          typeof args.target !== 'string' || !args.target.trim() || args.target.length > 1000) {
        invalid('action and target must be non-empty strings under 1,000 characters');
      }
      return textResult({ checkpointCalled: true, action: args.action, target: args.target, performed: false });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handle(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    rpcError(null, -32600, 'Invalid Request');
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // MCP notifications do not have responses.
  if (typeof method !== 'string' && (message.result !== undefined || message.error !== undefined)) {
    const resolveApproval = pendingElicitations.get(id);
    if (resolveApproval) {
      pendingElicitations.delete(id);
      resolveApproval(message);
      return;
    }
    return;
  }
  if (typeof method !== 'string') {
    rpcError(id, -32600, 'Invalid Request');
    return;
  }
  switch (method) {
    case 'initialize':
      send({ id, result: {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jarvis_desktop', version: '0.1.0-beta.3' }
      } });
      return;
    case 'ping':
      send({ id, result: {} });
      return;
    case 'tools/list':
      send({ id, result: { tools: TOOLS } });
      return;
    case 'resources/list':
      send({ id, result: { resources: [] } });
      return;
    case 'resources/templates/list':
      send({ id, result: { resourceTemplates: [] } });
      return;
    case 'tools/call':
      try {
        if (typeof params?.name !== 'string') invalid('tool name must be a string');
        send({ id, result: await callTool(params.name, params.arguments) });
      } catch (error) {
        process.stderr.write(`[mcp-server] ${error.stack || error}\n`);
        send({ id, result: { isError: true, content: [{ type: 'text', text: error.message || String(error) }] } });
      }
      return;
    default:
      rpcError(id, -32601, `Method not found: ${method}`);
  }
}

if (require.main === module) {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rpcError(null, -32700, 'Parse error');
      return;
    }
    // Approval replies must be handled while a serialized desktop call is waiting.
    if (message && typeof message === 'object' && typeof message.method !== 'string' && message.id !== undefined) {
      void handle(message).catch((error) => process.stderr.write(`[mcp-server] ${error.stack || error}\n`));
      return;
    }
    // Desktop input calls must run in order so a click cannot overtake typing.
    queue = queue.then(() => handle(message)).catch((error) => {
      process.stderr.write(`[mcp-server] ${error.stack || error}\n`);
      if (message?.id !== undefined) rpcError(message.id, -32603, 'Internal error');
    });
  });
}

module.exports = { TOOLS, callTool, handle, pendingElicitations, requestUserApproval, runDesktop };
