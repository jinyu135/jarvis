'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { handleSquirrelEvent, initializeAppLifecycle } = require('../src/squirrel-events');

test('Squirrel install and update create a Start menu shortcut and exit event mode', () => {
  for (const event of ['--squirrel-install', '--squirrel-updated']) {
    const calls = [];
    const handled = handleSquirrelEvent({
      args: ['Jarvis.exe', event],
      platform: 'win32',
      executablePath: 'C:\\Users\\test\\AppData\\Local\\Jarvis\\app-0.1.0\\Jarvis.exe',
      spawnChild: (file, args, options) => {
        calls.push({ file, args, options });
        return { unref() {} };
      }
    });
    assert.equal(handled, true);
    assert.deepEqual(calls[0].args, ['--createShortcut', 'Jarvis.exe']);
    assert.equal(path.basename(calls[0].file), 'Update.exe');
  }
});

test('Squirrel uninstall removes its shortcut but first run continues into Jarvis', () => {
  const calls = [];
  assert.equal(handleSquirrelEvent({
    args: ['Jarvis.exe', '--squirrel-uninstall'],
    platform: 'win32',
    executablePath: 'C:\\Users\\test\\AppData\\Local\\Jarvis\\app-0.1.0\\Jarvis.exe',
    spawnChild: (_file, args) => { calls.push(args); return { unref() {} }; }
  }), true);
  assert.deepEqual(calls, [['--removeShortcut', 'Jarvis.exe']]);
  assert.equal(handleSquirrelEvent({ args: ['Jarvis.exe', '--squirrel-firstrun'], platform: 'win32' }), false);
  assert.equal(handleSquirrelEvent({ args: ['Jarvis.exe', '--squirrel-install'], platform: 'darwin' }), false);
});

test('Squirrel hook schedules exit after shortcut setup and skips normal app startup', () => {
  let callback;
  const calls = [];
  const app = {
    requestSingleInstanceLock() { calls.push('lock'); return true; },
    quit() { calls.push('quit'); }
  };
  const hasLock = initializeAppLifecycle(app, true, (next, delay) => {
    callback = next;
    calls.push(`schedule:${delay}`);
  });

  assert.equal(hasLock, false);
  assert.deepEqual(calls, ['schedule:1000']);
  callback();
  assert.deepEqual(calls, ['schedule:1000', 'quit']);
});

test('normal startup takes the single-instance lock and quits duplicate launches', () => {
  const calls = [];
  const app = {
    requestSingleInstanceLock() { calls.push('lock'); return false; },
    quit() { calls.push('quit'); }
  };

  assert.equal(initializeAppLifecycle(app, false, () => calls.push('schedule')), false);
  assert.deepEqual(calls, ['lock', 'quit']);
});
