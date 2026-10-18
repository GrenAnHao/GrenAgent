import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { presentFiles } from './present.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function workspace() {
  const cwd = tempDir('present-');
  writeFileSync(join(cwd, 'ok.txt'), 'x');
  mkdirSync(join(cwd, 'dir'));
  return cwd;
}

describe('presentFiles', () => {
  it('accepts 1-8 existing files and records the resolved absolute path', () => {
    const root = workspace();
    const out = presentFiles(root, [{ path: 'ok.txt', description: 'demo' }]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.files).toEqual([{ path: resolve(root, 'ok.txt'), description: 'demo' }]);
  });

  it('rejects missing, directory, empty, and overflow', () => {
    const root = workspace();
    expect(presentFiles(root, [{ path: 'missing.txt' }]).ok).toBe(false);
    expect(presentFiles(root, [{ path: 'dir' }]).ok).toBe(false);
    expect(presentFiles(root, []).ok).toBe(false);
    expect(presentFiles(root, Array.from({ length: 9 }, (_, i) => ({ path: 'ok.txt', description: String(i) }))).ok).toBe(false);
    expect(presentFiles(root, [{ path: '   ' }]).ok).toBe(false);
  });

  it('accepts an absolute path outside the working directory', () => {
    const root = workspace();
    const other = tempDir('present-other-');
    writeFileSync(join(other, 'report.md'), '# r');
    const out = presentFiles(root, [{ path: join(other, 'report.md') }]);
    expect(out).toEqual({ ok: true, files: [{ path: join(other, 'report.md') }] });
  });

  it('accepts a relative path that climbs out of the working directory when the file exists', () => {
    const parent = tempDir('present-parent-');
    const root = join(parent, 'work');
    mkdirSync(root);
    writeFileSync(join(parent, 'sibling.txt'), 'x');
    const out = presentFiles(root, [{ path: '../sibling.txt' }]);
    expect(out).toEqual({ ok: true, files: [{ path: join(parent, 'sibling.txt') }] });
    expect(presentFiles(root, [{ path: '../nope.txt' }]).ok).toBe(false);
  });

  it('keeps pointing at the same file after the working directory changes', () => {
    const first = workspace();
    const second = tempDir('present-second-');
    writeFileSync(join(second, 'ok.txt'), 'other');
    const out = presentFiles(first, [{ path: 'ok.txt' }]);
    expect(out.ok && out.files[0]?.path).toBe(resolve(first, 'ok.txt'));
    expect(out.ok && out.files[0]?.path).not.toBe(resolve(second, 'ok.txt'));
  });

  it('says how to recover when the file is missing', () => {
    const out = presentFiles(workspace(), [{ path: 'missing.txt' }]);
    expect(out).toEqual({ ok: false, error: expect.stringContaining('file not found') });
  });
});
