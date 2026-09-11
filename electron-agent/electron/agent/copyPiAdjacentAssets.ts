import { cpSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const PI_ADJACENT_ASSETS = [
  { from: 'extensions/code-exec/runner.py', to: 'runner.py' },
  { from: 'extensions/code-exec/runner.mjs', to: 'runner.mjs' },
  { from: 'extensions/fable-behavior/prompts', to: 'prompts', dir: true },
] as const;

function copyAssetsTo(repoRoot: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const asset of PI_ADJACENT_ASSETS) {
    const src = resolve(repoRoot, asset.from);
    const dest = resolve(destDir, asset.to);
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
