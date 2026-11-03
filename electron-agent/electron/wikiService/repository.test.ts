import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { assertCleanTarget, freezeRepository, repositoryInputs, pinPriorPublication, formatCommitMessages, formatFileChanges } from './repository';
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) { if (resolve(dirname(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('repowiki-source-')) throw new Error('UNSAFE_FIXTURE_CLEANUP'); rmSync(dir, { recursive: true, force: true }); } });
function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'repowiki-source-')); temporary.push(root);
  mkdirSync(join(root, 'src')); mkdirSync(join(root, '.qoder/rules'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Fixture\nSource repository.\n');
  writeFileSync(join(root, 'src/a.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, '.qoder/rules/project.md'), '# Authored rule\nKeep this source.\n');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Source fixture'); git('config', 'user.email', 'source@example.invalid'); git('add', '.'); git('commit', '-m', 'source fixture');
  for (const file of ['.qoder/repowiki/zh/content/previous.md', 'docs/repo-wiki/zh/author-config.qoder-v1.json']) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), '# Generated output\n'); }
  return { root, target: git('rev-parse', 'HEAD') };
}
describe('native source scope with existing Wiki output', () => {
  it('ignores only generated Wiki trees under the default source scope', async () => {
    const f = repositoryFixture(), repo = await repositoryInputs(f.root);
    expect(repo.manifest.map(file => file.path)).toEqual(expect.arrayContaining(['README.md', 'src/a.ts', '.qoder/rules/project.md']));
    expect(repo.manifest.some(file => file.path.startsWith('.qoder/repowiki/'))).toBe(false);
    expect(repo.manifest.some(file => file.path.startsWith('docs/repo-wiki/'))).toBe(false);
    await expect(assertCleanTarget(f.root, f.target, new Set(repo.manifest.map(file => file.path)))).resolves.toBeUndefined();
  });
  it('still rejects dirty source and ordinary untracked files', async () => {
    const f = repositoryFixture(); writeFileSync(join(f.root, 'src/a.ts'), 'export const value = 2;\n');
    let repo = await repositoryInputs(f.root);
    await expect(assertCleanTarget(f.root, f.target, new Set(repo.manifest.map(file => file.path)))).rejects.toThrow('DIRTY_WORKTREE_REQUIRES_REVIEW');
    writeFileSync(join(f.root, 'src/a.ts'), 'export const value = 1;\n'); writeFileSync(join(f.root, '.qoder/rules/new.md'), '# Unreviewed authored source\n');
    repo = await repositoryInputs(f.root);
    expect(repo.manifest.some(file => file.path === '.qoder/rules/new.md')).toBe(true);
    await expect(assertCleanTarget(f.root, f.target, new Set(repo.manifest.map(file => file.path)))).rejects.toThrow('DIRTY_WORKTREE_REQUIRES_REVIEW');
  });
  it('normalizes a preflight-only old source pin without reusing generated-output evidence', async () => {
    const f = repositoryFixture(), repo = await repositoryInputs(f.root);
    const oldManifest = [...repo.manifest, { path: '.qoder/repowiki/zh/content/old.md', hash: 'previous-output' }];
    const saved: any[] = [{ stage: 'source', itemId: '', disposition: 'done', raw: '', parsed: oldManifest }, { stage: 'prior-publication', itemId: 'parent', disposition: 'done', parsed: { sourceId: null, expectedId: null } }];
    const context: any = { signal: new AbortController().signal, checkpoints: () => saved, checkpoint: (value: any) => { saved[saved.findIndex(cp => cp.stage === value.stage && cp.itemId === value.itemId)] = value; } };
    const operation: any = { repositoryRoot: f.root, plan: {}, locale: 'zh', branch: 'main' };
    await expect(freezeRepository(operation, context)).resolves.toMatchObject({ manifest: repo.manifest });
    expect(saved[0].parsed.some((file: any) => file.path.startsWith('.qoder/repowiki/'))).toBe(false);
    for (const stage of ['overview', 'overview:attempt']) {
      saved[0].parsed = oldManifest; saved.push({ stage, itemId: '', disposition: 'done', parsed: 'already attempted source work' });
      await expect(freezeRepository(operation, context)).rejects.toThrow('SOURCE_SNAPSHOT_CHANGED'); saved.pop();
    }
    saved[0].parsed = repo.manifest.map(file => file.path === 'src/a.ts' ? { ...file, hash: 'changed-source' } : file);
    await expect(freezeRepository(operation, context)).rejects.toThrow('SOURCE_SNAPSHOT_CHANGED');
    expect(readFileSync(join(f.root, 'src/a.ts'), 'utf8')).toBe('export const value = 1;\n');
  });
});
describe('native publication identity', () => {
  it('keeps the original read baseline after the partition changes during resume', () => {
    const saved: any[] = []; let current: any = { id: 'old', operationId: 'prior' };
    const context: any = { checkpoints: () => saved, checkpoint: (cp: any) => saved.push(cp), published: () => current, publication: (id: string) => id === 'old' ? { id: 'old' } : undefined };
    const op: any = { id: 'run', action: 'update' };
    expect(pinPriorPublication(op, context)).toEqual({ source: { id: 'old' }, expectedId: 'old' });
    current = { id: 'new', operationId: 'other' };
    expect(pinPriorPublication(op, context)).toEqual({ source: { id: 'old' }, expectedId: 'old' });
  });
  it('refuses repair if a newer unrelated publication replaced the parent baseline', () => {
    const context: any = { checkpoints: () => [{ stage: 'prior-publication', itemId: 'parent', disposition: 'done', parsed: { sourceId: 'old', expectedId: 'old' } }], published: () => ({ id: 'new', operationId: 'other' }) };
    expect(() => pinPriorPublication({ id: 'repair', action: 'repair', parentOperationId: 'parent' } as never, context)).toThrow('BASELINE_CHANGED');
  });
});

describe('reference Git material', () => {
  it('distinguishes apply and drop with full author/date metadata', () => {
    const text = formatCommitMessages([{ hash: '1234567890', author: 'A', date: '2026-01-01', message: 'first\nbody', direction: 'apply' }], [{ hash: 'abcdef0123', author: 'B', date: '2026-01-02', message: 'reverted', direction: 'drop' }], { apply: 1, drop: 1 });
    expect(text).toContain('1. [APPLY] 12345678\n   Message: first\nbody\n   Author: A\n   Date: 2026-01-01');
    expect(text).toContain('1. [DROP] abcdef01\n   Message: reverted');
  });
  it('formats explicit changed-file status without treating files as page dependencies', () => {
    expect(formatFileChanges([{ status: 'R100', oldPath: 'old.ts', path: 'new.ts' }], '123456789', 'abcdef012')).toContain('Renamed: old.ts -> new.ts');
  });
});
