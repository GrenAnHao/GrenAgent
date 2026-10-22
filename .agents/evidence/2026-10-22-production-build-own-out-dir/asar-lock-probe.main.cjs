// 在 Electron 主进程里只对 .asar 文件做一次 lstat / stat，看文件是否从此被占用。
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = __dirname;
const who = (file) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, '..', 'who-locks.ps1'), '-Path', file], { encoding: 'utf8' }).trim() || '(none)';

app.whenReady().then(async () => {
 try {
  const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'lstat';
  const target = path.join(dir, `probe-${mode}.asar`);
  require('original-fs').copyFileSync(path.join(dir, 'source.asar'), target);
  const lib = mode === 'original' ? require('original-fs').promises : fs.promises;
  const st = await (mode === 'stat' ? lib.stat(target) : lib.lstat(target));
  console.log(`mode=${mode} isDirectory=${st.isDirectory()} pid=${process.pid}`);
  console.log(`holders: ${who(target)}`);
  let removed = 'ok';
  try { require('original-fs').unlinkSync(target); } catch (error) { removed = error.code; }
  console.log(`unlink while running: ${removed}`);
  } catch (e) { console.log('error', e.message); }
  app.exit(0);
});
