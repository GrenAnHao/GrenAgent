import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIndexed, probeProjects } from './indexProbe';

describe('CodeGraph index probe', () => {
  it('requires a database file, not just a .codegraph directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-probe-'));
    expect(isIndexed(root)).toBe(false);
    mkdirSync(join(root, '.codegraph'));
    expect(isIndexed(root)).toBe(false);
    writeFileSync(join(root, '.codegraph', 'codegraph.db'), 'database presence only; SDK validates contents');
    expect(isIndexed(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('treats a .codegraph file (not directory) as not indexed', () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-probe-file-'));
    writeFileSync(join(root, '.codegraph'), 'not a directory');
    expect(isIndexed(root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports indexed state for every supplied workspace', () => {
    const indexed = mkdtempSync(join(tmpdir(), 'cg-probe-a-'));
    const bare = mkdtempSync(join(tmpdir(), 'cg-probe-b-'));
    mkdirSync(join(indexed, '.codegraph'));
    writeFileSync(join(indexed, '.codegraph', 'codegraph.db'), 'database');

    expect(probeProjects([indexed, bare, '  '])).toEqual([
      { workspace: indexed, indexed: true },
      { workspace: bare, indexed: false },
    ]);

    rmSync(indexed, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });
});
