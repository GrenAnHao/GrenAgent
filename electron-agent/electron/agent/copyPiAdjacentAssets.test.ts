import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { copyPiAdjacentAssets, PI_ADJACENT_ASSETS } from './copyPiAdjacentAssets.js';

describe('copyPiAdjacentAssets', () => {
  const repoRoot = resolve(__dirname, '../../..');

  it('把 runner、Windows helper 与 fable prompts 拷到 outDir', () => {
    expect(PI_ADJACENT_ASSETS).toContainEqual({
      from: 'extensions/_shared/sandbox/windows/bin/pi-sandbox-win.exe',
      to: 'pi-sandbox-win.exe',
    });
    expect(PI_ADJACENT_ASSETS).toContainEqual({
      from: 'extensions/_shared/sandbox/windows/bin/pi-sandbox-launch.exe',
      to: 'pi-sandbox-launch.exe',
    });
    const dir = mkdtempSync(join(tmpdir(), 'pi-assets-'));
    copyPiAdjacentAssets(repoRoot, dir);
    expect(existsSync(join(dir, 'runner.py'))).toBe(true);
    expect(existsSync(join(dir, 'runner.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'pi-sandbox-win.exe'))).toBe(true);
    expect(existsSync(join(dir, 'pi-sandbox-launch.exe'))).toBe(true);
    expect(existsSync(join(dir, 'pi-job-guard.exe'))).toBe(true);
    expect(existsSync(join(dir, 'prompts/tier1/identity.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('若已有 chunks 目录则再拷一份到 chunk 旁', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-assets-chunks-'));
    mkdirSync(join(dir, 'chunks'));
    copyPiAdjacentAssets(repoRoot, dir);
    expect(existsSync(join(dir, 'chunks', 'runner.py'))).toBe(true);
    expect(existsSync(join(dir, 'chunks', 'pi-sandbox-win.exe'))).toBe(true);
    expect(existsSync(join(dir, 'chunks', 'pi-sandbox-launch.exe'))).toBe(true);
    expect(existsSync(join(dir, 'chunks', 'prompts/tier1/identity.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('asarUnpack 列出生产产物 out-pkg/main 与 chunks 下的 helper', () => {
    const config = parse(readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8'));
    expect(config.asarUnpack).toContain('out-pkg/main/pi-sandbox-win.exe');
    expect(config.asarUnpack).toContain('out-pkg/main/pi-sandbox-launch.exe');
    expect(config.asarUnpack).toContain('out-pkg/main/chunks/pi-sandbox-win.exe');
    expect(config.asarUnpack).toContain('out-pkg/main/chunks/pi-sandbox-launch.exe');
    expect(config.asarUnpack).toContain('out-pkg/main/pi-job-guard.exe');
  });
});
