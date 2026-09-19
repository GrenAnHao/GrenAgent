import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { presentFiles } from './present.js';

let cwd = '';
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

function workspace() {
  cwd = mkdtempSync(join(tmpdir(), 'present-'));
  writeFileSync(join(cwd, 'ok.txt'), 'x');
  mkdirSync(join(cwd, 'dir'));
  return cwd;
}

describe('presentFiles', () => {
  it('accepts 1-8 existing workspace files and keeps the model path', () => {
    const root = workspace();
    const out = presentFiles(root, [{ path: 'ok.txt', description: 'demo' }]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.files).toEqual([{ path: 'ok.txt', description: 'demo' }]);
  });

  it('rejects missing, directory, escape, empty, and overflow', () => {
    const root = workspace();
    expect(presentFiles(root, [{ path: 'missing.txt' }]).ok).toBe(false);
    expect(presentFiles(root, [{ path: 'dir' }]).ok).toBe(false);
    expect(presentFiles(root, [{ path: '../outside.txt' }]).ok).toBe(false);
    expect(presentFiles(root, []).ok).toBe(false);
    expect(presentFiles(root, Array.from({ length: 9 }, (_, i) => ({ path: 'ok.txt', description: String(i) }))).ok).toBe(false);
    expect(presentFiles(root, [{ path: '   ' }]).ok).toBe(false);
  });
});
