import { describe, expect, it } from 'vitest';
import { digestArgs, MAX_DIGEST_LENGTH } from './argsDigest';

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

  it('serialises unknown tools whole but truncates oversized payloads', () => {
    const digest = digestArgs('some_tool', { blob: 'y'.repeat(MAX_DIGEST_LENGTH * 2) });
    expect(digest.length).toBeLessThanOrEqual(MAX_DIGEST_LENGTH);
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
