import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyPiAdjacentAssets } from './copyPiAdjacentAssets.js';

describe('copyPiAdjacentAssets', () => {
  const repoRoot = resolve(__dirname, '../../..');

  it('把 runner 与 fable prompts 拷到 outDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-assets-'));
    copyPiAdjacentAssets(repoRoot, dir);
    expect(existsSync(join(dir, 'runner.py'))).toBe(true);
    expect(existsSync(join(dir, 'runner.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'prompts/tier1/identity.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('若已有 chunks 目录则再拷一份到 chunk 旁', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-assets-chunks-'));
    mkdirSync(join(dir, 'chunks'));
    copyPiAdjacentAssets(repoRoot, dir);
    expect(existsSync(join(dir, 'chunks', 'runner.py'))).toBe(true);
    expect(existsSync(join(dir, 'chunks', 'prompts/tier1/identity.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
