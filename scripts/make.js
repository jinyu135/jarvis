'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const forge = require('../forge.config.cjs');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
const build = spawnSync(process.execPath, [cli, 'make', '--platform', 'win32', '--arch', 'x64'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);

const source = path.join(forge.outDir, 'make', 'squirrel.windows', 'x64', 'JarvisSetup.exe');
if (!fs.existsSync(source)) throw new Error(`설치 파일을 찾을 수 없습니다: ${source}`);
if (fs.statSync(source).size < 20 * 1024 * 1024) {
  throw new Error(`설치 파일에 앱 데이터가 포함되지 않았습니다: ${source}`);
}
const targetDir = path.join(root, 'dist');
fs.mkdirSync(targetDir, { recursive: true });
const target = path.join(targetDir, 'JarvisSetup.exe');
fs.copyFileSync(source, target);
const sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
fs.writeFileSync(path.join(targetDir, 'SHA256SUMS.txt'), `${sha256}  JarvisSetup.exe\n`, 'utf8');
process.stdout.write(`Jarvis installer: ${target}\nSHA-256: ${sha256}\n`);
