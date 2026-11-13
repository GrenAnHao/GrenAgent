import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { copyPiAdjacentAssets, PI_ADJACENT_ASSETS } from './copyPiAdjacentAssets.js';

describe('copyPiAdjacentAssets', () => {
  const repoRoot = resolve(__dirname, '../../..');

  it('copies only the HTML viewer assets needed by the bundled SDK, not its exporter source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-html-assets-'));
    try {
      mkdirSync(join(dir, 'chunks'));
      copyPiAdjacentAssets(repoRoot, dir);
      for (const parent of [dir, join(dir, 'chunks')]) {
        for (const name of ['template.html', 'template.css', 'template.js', 'vendor/marked.min.js', 'vendor/marked-cjk-friendly.min.js', 'vendor/highlight.min.js']) {
          expect(existsSync(join(parent, 'dist/core/export-html', name)), name).toBe(true);
        }
        expect(existsSync(join(parent, 'dist/core/export-html/index.js'))).toBe(false);
        for (const theme of ['dark', 'light']) expect(existsSync(join(parent, 'dist/modes/interactive/theme', `${theme}.json`))).toBe(true);
      }
    } finally { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe cleanup'); rmSync(dir, { recursive: true, force: true }); }
  });

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
    expect(readFileSync(join(dir, 'ultra-rules.md'), 'utf8')).toContain('# Ultra scheduling');
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
    expect(readFileSync(join(dir, 'chunks', 'ultra-rules.md'), 'utf8')).toContain('# Ultra scheduling');
    rmSync(dir, { recursive: true, force: true });
  });

  it('asarUnpack 列出生产产物 out-pkg/main 与 chunks 下的 helper', () => {
    const config = parse(readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8'));
    expect(config.asarUnpack).toContain('out-pkg/main/pi-sandbox-win.exe');
    expect(config.asarUnpack).toContain('out-pkg/main/pi-sandbox-launch.exe');
    expect(config.asarUnpack).toContain('out-pkg/main/chunks/pi-sandbox-win.exe');
    expect(config.asarUnpack).toContain('out-pkg/main/chunks/pi-sandbox-launch.exe');
    expect(config.asarUnpack).toContain('out-pkg/main/pi-job-guard.exe');
    expect(config.asarUnpack).toContain('out-pkg/main/dist/core/export-html/**');
    expect(config.asarUnpack).toContain('out-pkg/main/dist/modes/interactive/theme/*.json');
  });
});
