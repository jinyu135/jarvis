'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

function handleSquirrelEvent({ args = process.argv, platform = process.platform, executablePath = process.execPath, spawnChild = spawn } = {}) {
  if (platform !== 'win32') return false;
  const event = args.find((argument) => /^--squirrel-(install|updated|uninstall|obsolete)$/.test(argument));
  if (!event) return false;

  if (event === '--squirrel-install' || event === '--squirrel-updated' || event === '--squirrel-uninstall') {
    const updateExe = path.resolve(path.dirname(executablePath), '..', 'Update.exe');
    const operation = event === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut';
    try {
      const child = spawnChild(updateExe, [operation, path.basename(executablePath)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref?.();
    } catch (error) {
      process.stderr.write(`[squirrel] ${error.message || error}\n`);
    }
  }
  return true;
}

function initializeAppLifecycle(app, squirrelEventHandled, scheduleExit = setTimeout) {
  if (squirrelEventHandled) {
    // Squirrel waits for its hook process; give the detached shortcut helper a
    // moment to start before quitting, matching electron-winstaller guidance.
    scheduleExit(() => app.quit(), 1000);
    return false;
  }

  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) app.quit();
  return hasSingleInstanceLock;
}

module.exports = { handleSquirrelEvent, initializeAppLifecycle };
