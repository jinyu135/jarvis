'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TOOLS, callTool, handle, requestUserApproval } = require('../src/mcp-server');
const { CodexClient } = require('../src/codex-client');

function textFrom(result) {
  return JSON.parse(result.content[0].text);
}

test('MCP exposes the expanded desktop tool set', () => {
  const names = new Set(TOOLS.map((tool) => tool.name));
  for (const name of [
    'desktop_search_files', 'desktop_get_file_info', 'desktop_copy_file', 'desktop_move_file',
    'desktop_rename_file', 'desktop_recycle_file', 'desktop_launch_app', 'desktop_focus_window',
    'desktop_system_resources', 'desktop_list_processes', 'desktop_terminate_process'
  ]) assert.ok(names.has(name), `missing ${name}`);
});

test('Recycle Bin action cannot run unless the user accepts the exact target', async () => {
  const calls = [];
  const runner = async (...args) => { calls.push(args); return { recycled: true }; };
  let prompt = '';
  await assert.rejects(callTool('desktop_recycle_file', { path: 'C:\\temp\\old.exe' }, runner, async (message) => {
    prompt = message;
    return { action: 'decline' };
  }), /허용하지 않았습니다/);
  assert.match(prompt, /C:\\temp\\old\.exe/);
  assert.equal(calls.length, 0);

  const result = await callTool('desktop_recycle_file', { path: 'C:\\temp\\old.exe' }, runner, async () => ({ action: 'accept' }));
  assert.deepEqual(textFrom(result), { recycled: true });
  assert.deepEqual(calls, [['recycle_file', { path: 'C:\\temp\\old.exe' }]]);
});

test('process termination cannot run unless the user accepts the exact PID and name', async () => {
  const calls = [];
  const runner = async (...args) => { calls.push(args); return { terminated: true }; };
  await assert.rejects(callTool('desktop_terminate_process', { processId: 1234, processName: 'example' }, runner, async (message) => {
    assert.match(message, /example \(PID 1234\)/);
    return { action: 'cancel' };
  }), /계속 실행 중입니다/);
  assert.equal(calls.length, 0);
  await callTool('desktop_terminate_process', { processId: 1234, processName: 'example' }, runner, async () => ({ action: 'accept' }));
  assert.deepEqual(calls, [['terminate_process', { processId: 1234, processName: 'example' }]]);
});

test('the MCP server waits for the App Server elicitation reply before continuing', async () => {
  const originalWrite = process.stdout.write;
  let requestLine = '';
  process.stdout.write = function captureApprovalRequest(chunk, ...args) {
    if (String(chunk).includes('elicitation/create')) {
      requestLine = String(chunk).trim();
      return true;
    }
    return originalWrite.call(this, chunk, ...args);
  };
  try {
    const waiting = requestUserApproval('휴지통 대상: C:\\temp\\test.txt');
    const request = JSON.parse(requestLine);
    assert.equal(request.method, 'elicitation/create');
    assert.match(request.params.message, /C:\\temp\\test\.txt/);
    assert.equal(request.params.mode, 'form');
    await handle({ jsonrpc: '2.0', id: request.id, result: { action: 'accept', content: {} } });
    assert.deepEqual(await waiting, { action: 'accept', content: {} });
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('overwrite attempts are rejected by the Windows file operation instead of changing the target', async () => {
  let ran = false;
  await assert.rejects(callTool('desktop_copy_file', {
    sourcePath: 'C:\\temp\\source.txt',
    destinationPath: 'C:\\temp\\existing.txt'
  }, async () => { ran = true; throw new Error('Destination already exists. Overwriting is disabled.'); }), /Overwriting is disabled/);
  assert.equal(ran, true);
  await assert.rejects(callTool('desktop_rename_file', { path: 'C:\\temp\\source.txt', newName: '..\\victim.txt' }, async () => {
    throw new Error('runner should not be reached');
  }), /newName must be a single file name/);
});

test('MCP stdio handshake advertises beta 3 tools', () => {
  const serverPath = path.join(__dirname, '..', 'src', 'mcp-server.js');
  const run = spawnSync(process.execPath, [serverPath], {
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    ].join('\n') + '\n',
    encoding: 'utf8',
    timeout: 5000
  });
  assert.equal(run.status, 0, run.stderr);
  const messages = run.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(messages[0].result.serverInfo.version, '0.1.0-beta.3');
  assert.ok(messages[1].result.tools.some((tool) => tool.name === 'desktop_recycle_file'));
});

test('Codex config keeps Luna and the explicit high impact checkpoint', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-config-'));
  try {
    const client = new CodexClient({ appPath: '', electronPath: 'electron.exe', codexHome: temporaryDirectory, desktopToolPath: 'mcp-server.js' });
    client.writeConfig();
    const config = fs.readFileSync(path.join(temporaryDirectory, 'config.toml'), 'utf8');
    assert.match(config, /model = "gpt-6-luna"/);
    assert.match(config, /\[mcp_servers\.jarvis_desktop\.tools\.confirm_high_impact\]/);
    assert.match(config, /default_tools_approval_mode = "auto"/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
