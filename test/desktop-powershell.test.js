'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runDesktop(action, payload = {}) {
  const script = path.join(__dirname, '..', 'src', 'desktop.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Action', action
  ], {
    input: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${action} exited ${result.status}`);
  return JSON.parse(result.stdout.trim());
}

test('Windows PowerShell safely searches and edits only temporary test files and reports resources', {
  skip: process.platform !== 'win32'
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-desktop-test-'));
  let testProcess;
  try {
    const driveRoot = `${process.env.SystemDrive || 'C:'}\\`;
    assert.throws(() => runDesktop('search_files', { rootPath: driveRoot, namePattern: '*', limit: 10 }), /whole drive is disabled/);

    const nested = path.join(directory, 'nested');
    fs.mkdirSync(nested);
    const sourcePath = path.join(nested, 'sample.txt');
    fs.writeFileSync(sourcePath, 'Jarvis temporary test', 'utf8');

    const search = runDesktop('search_files', { rootPath: directory, namePattern: '*.txt', limit: 10 });
    assert.equal(search.count, 1);
    assert.equal(path.normalize(search.files[0].path), path.normalize(sourcePath));

    const info = runDesktop('get_file_info', { path: sourcePath });
    assert.equal(info.name, 'sample.txt');
    assert.equal(info.sizeBytes, Buffer.byteLength('Jarvis temporary test'));

    const copiedPath = path.join(directory, 'copy.txt');
    runDesktop('copy_file', { sourcePath, destinationPath: copiedPath });
    assert.equal(fs.readFileSync(copiedPath, 'utf8'), 'Jarvis temporary test');

    const overwrite = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, '..', 'src', 'desktop.ps1'), '-Action', 'copy_file'
    ], {
      input: Buffer.from(JSON.stringify({ sourcePath, destinationPath: copiedPath }), 'utf8').toString('base64'),
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true
    });
    assert.notEqual(overwrite.status, 0);
    assert.equal(fs.readFileSync(copiedPath, 'utf8'), 'Jarvis temporary test');

    const movedPath = path.join(directory, 'moved.txt');
    runDesktop('move_file', { sourcePath: copiedPath, destinationPath: movedPath });
    assert.equal(fs.existsSync(copiedPath), false);
    const renamedPath = path.join(directory, 'renamed.txt');
    runDesktop('rename_file', { path: movedPath, newName: 'renamed.txt' });
    assert.equal(fs.readFileSync(renamedPath, 'utf8'), 'Jarvis temporary test');

    const resources = runDesktop('system_resources');
    assert.ok(resources.memoryTotalBytes > 0);
    assert.ok(Array.isArray(resources.drives));

    testProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    await new Promise((resolve, reject) => {
      testProcess.once('spawn', resolve);
      testProcess.once('error', reject);
    });
    const processes = runDesktop('list_processes', { limit: 100, nameContains: 'node' });
    assert.ok(processes.processes.some((process) => process.processId === testProcess.pid));
    runDesktop('terminate_process', { processId: testProcess.pid, processName: 'node' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test process did not terminate')), 5000);
      testProcess.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    if (testProcess && testProcess.exitCode === null && testProcess.signalCode === null) testProcess.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
