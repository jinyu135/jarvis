const os = require('node:os');
const path = require('node:path');

module.exports = {
  // Squirrel's rcedit cannot open a target under a non-ASCII path on Windows.
  outDir: process.env.JARVIS_BUILD_OUT_DIR || path.join(os.tmpdir(), 'jarvis-forge-out'),
  packagerConfig: {
    name: 'Jarvis',
    executableName: 'Jarvis',
    asar: false,
    prune: true,
    ignore: [/^\/(?:\.npm-cache|\.schema|dist|out|scripts)(?:\/|$)/, /^\/voice\/(?:bin|models)(?:\/|$)/]
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'Jarvis',
        setupExe: 'JarvisSetup.exe',
        loadingGif: undefined
      }
    }
  ]
};
