import { cpSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// 选 A 预编译入仓：helper exe 与 runner.py 同模式。extensions 打进
// chunk 后 import.meta.url 会漂，必须再拷到 out/main 与 chunks 旁。
export const PI_ADJACENT_ASSETS = [
  { from: 'extensions/code-exec/runner.py', to: 'runner.py' },
  { from: 'extensions/code-exec/runner.mjs', to: 'runner.mjs' },
  { from: 'extensions/_shared/sandbox/windows/bin/pi-sandbox-win.exe', to: 'pi-sandbox-win.exe' },
  { from: 'extensions/_shared/sandbox/windows/bin/pi-sandbox-launch.exe', to: 'pi-sandbox-launch.exe' },
  // agent-host 的进程树守卫（electron-agent/native/job-guard.c），主进程按 out/main 旁找它。
  { from: 'electron-agent/native/bin/pi-job-guard.exe', to: 'pi-job-guard.exe' },
  { from: 'extensions/fable-behavior/prompts', to: 'prompts', dir: true },
  { from: 'extensions/agent-mode/ultra-rules.md', to: 'ultra-rules.md' },
  // The bundled SDK resolves its HTML viewer relative to the emitted package root.
  { from: 'electron-agent/node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html', to: 'dist/core/export-html/template.html' },
  { from: 'electron-agent/node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.css', to: 'dist/core/export-html/template.css' },
  { from: 'electron-agent/node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js', to: 'dist/core/export-html/template.js' },
  { from: 'electron-agent/node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor', to: 'dist/core/export-html/vendor', dir: true },
  { from: 'electron-agent/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', to: 'dist/modes/interactive/theme/dark.json' },
  { from: 'electron-agent/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json', to: 'dist/modes/interactive/theme/light.json' },
] as const;

function copyAssetsTo(repoRoot: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const asset of PI_ADJACENT_ASSETS) {
    const src = resolve(repoRoot, asset.from);
    const dest = resolve(destDir, asset.to);
    mkdirSync(dirname(dest), { recursive: true });
    if ('dir' in asset && asset.dir) cpSync(src, dest, { recursive: true });
    else copyFileSync(src, dest);
  }
}

export function copyPiAdjacentAssets(repoRoot: string, outDir: string): void {
  copyAssetsTo(repoRoot, outDir);
  // extensions 打进 out/main/chunks/*.js 后，import.meta.url 指向 chunk 而不是 main.js。
  const chunksDir = resolve(outDir, 'chunks');
  if (existsSync(chunksDir)) copyAssetsTo(repoRoot, chunksDir);
}
