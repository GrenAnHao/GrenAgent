import { cpSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const PI_ADJACENT_ASSETS = [
  { from: 'extensions/code-exec/runner.py', to: 'runner.py' },
  { from: 'extensions/code-exec/runner.mjs', to: 'runner.mjs' },
  { from: 'extensions/fable-behavior/prompts', to: 'prompts', dir: true },
] as const;

export function copyPiAdjacentAssets(repoRoot: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const asset of PI_ADJACENT_ASSETS) {
    const src = resolve(repoRoot, asset.from);
    const dest = resolve(outDir, asset.to);
    if ('dir' in asset && asset.dir) cpSync(src, dest, { recursive: true });
    else copyFileSync(src, dest);
  }
}
