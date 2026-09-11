import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyPiAdjacentAssets } from './copyPiAdjacentAssets.js';

describe('copyPiAdjacentAssets', () => {
  it('把 runner 与 fable prompts 拷到 outDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-assets-'));
    const repoRoot = resolve(__dirname, '../../..');
    copyPiAdjacentAssets(repoRoot, dir);
    expect(existsSync(join(dir, 'runner.py'))).toBe(true);
    expect(existsSync(join(dir, 'runner.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'prompts/tier1/identity.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
