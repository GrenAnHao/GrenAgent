import { describe, expect, it } from 'vitest';
import { digestArgs, MAX_COMMAND_LENGTH, MAX_DIGEST_LENGTH } from './argsDigest';

describe('digestArgs', () => {
  it('keeps the full command for bash', () => {
    expect(digestArgs('bash', { command: 'npm run build' })).toBe('{"command":"npm run build"}');
  });

  it('keeps only the path for write and drops the content', () => {
    const digest = digestArgs('write', { path: 'D:/repo/a.ts', content: 'x'.repeat(50_000) });
    expect(digest).toBe('{"path":"D:/repo/a.ts"}');
  });

  it('keeps only the path for edit and drops old and new text', () => {
    const digest = digestArgs('edit', { path: 'D:/repo/a.ts', oldText: 'a', newText: 'b' });
    expect(digest).toBe('{"path":"D:/repo/a.ts"}');
  });

  it('falls back to the alternative path keys', () => {
    expect(digestArgs('write', { file_path: 'D:/repo/a.ts' })).toBe('{"path":"D:/repo/a.ts"}');
    expect(digestArgs('write', { filePath: 'D:/repo/a.ts' })).toBe('{"path":"D:/repo/a.ts"}');
    expect(digestArgs('write', { target_file: 'D:/repo/a.ts' })).toBe('{"path":"D:/repo/a.ts"}');
  });

  it('serialises ast_edit whole because its parameters carry no path key', () => {
    // ast_edit 的参数是 { ops, paths, dryRun, maxFiles }：paths 是复数数组，
    // 四个候选路径键一个都命中不了，列入 PATH_ONLY_TOOLS 只会写下 {"path":""}。
    const digest = digestArgs('ast_edit', { ops: [{ pat: 'a', out: 'b' }], paths: ['src/a.ts'] });
    expect(digest).toContain('"paths":["src/a.ts"]');
    expect(digest).toContain('"pat":"a"');
  });

  it('serialises hl_edit whole because its path lives inside the patch text', () => {
    const digest = digestArgs('hl_edit', { patch: '[src/a.ts#1a2b]\n-1 old\n+1 new' });
    expect(digest).toContain('src/a.ts');
  });

  it('serialises unknown tools whole but truncates oversized payloads', () => {
    const digest = digestArgs('some_tool', { blob: 'y'.repeat(MAX_DIGEST_LENGTH * 2) });
    expect(digest.length).toBeLessThanOrEqual(MAX_DIGEST_LENGTH);
    expect(digest.endsWith('…')).toBe(true);
  });

  it('never truncates in the middle of a surrogate pair', () => {
    // 让切点（MAX_DIGEST_LENGTH - 1）正好落在一个 emoji 的两个码元之间：
    // 前缀 {"blob":" 占 9 个码元，补足到切点前一位即可。
    const padding = 'a'.repeat(MAX_DIGEST_LENGTH - 2 - '{"blob":"'.length);
    const digest = digestArgs('some_tool', { blob: `${padding}${'\u{1F600}'.repeat(4)}` });
    expect(digest.length).toBeLessThanOrEqual(MAX_DIGEST_LENGTH);
    expect(digest.endsWith('…')).toBe(true);
    expect(digest.isWellFormed()).toBe(true);
  });

  it('lets a bash command exceed the generic limit but caps it at the command limit', () => {
    const long = 'x'.repeat(MAX_DIGEST_LENGTH * 2);
    expect(digestArgs('bash', { command: long })).toContain(long);

    const oversized = 'x'.repeat(MAX_COMMAND_LENGTH * 2);
    const digest = digestArgs('bash', { command: oversized });
    expect(digest.length).toBeLessThanOrEqual(MAX_COMMAND_LENGTH);
    expect(digest.endsWith('…')).toBe(true);
  });

  it('returns an empty object for missing args', () => {
    expect(digestArgs('bash', undefined)).toBe('{}');
  });

  it('survives values that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(digestArgs('some_tool', cyclic)).toBe('{"_unserializable":true}');
  });
});
