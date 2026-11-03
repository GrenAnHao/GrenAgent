import { describe, expect, it } from 'vitest';
import {
  canonicalOwnerKey,
  draftOwnerKey,
  emptyPreferences,
  isDraftOwnerKey,
  isSessionOwnerKey,
  mergePreferences,
  pickDefinedPreferences,
  sessionPathFromOwnerKey,
} from './sessionPreferences';

describe('owner keys', () => {
  it('tags drafts with a stable prefix and keeps them distinct from sessions', () => {
    const key = draftOwnerKey('abc');
    expect(key).toBe('draft:abc');
    expect(draftOwnerKey(key)).toBe('draft:abc');
    expect(isDraftOwnerKey(key)).toBe(true);
    expect(isSessionOwnerKey(key)).toBe(false);
    expect(sessionPathFromOwnerKey(key)).toBeNull();
  });

  it('keeps the original session path untouched so the host can route to it', () => {
    const path = 'D:\\Repo\\.pi\\sessions\\A.JSONL';
    expect(isSessionOwnerKey(path)).toBe(true);
    expect(sessionPathFromOwnerKey(path)).toBe(path);
    // 比较用归一化键可以折叠大小写/分隔符，但原路径不能被替换。
    expect(canonicalOwnerKey(path)).toBe('d:/repo/.pi/sessions/a.jsonl');
  });

  it('treats a bare workspace as a non-session owner', () => {
    expect(isSessionOwnerKey('/ws')).toBe(false);
    expect(isDraftOwnerKey('/ws')).toBe(false);
    expect(sessionPathFromOwnerKey('/ws')).toBeNull();
  });
});

describe('preference merging', () => {
  it('applies only defined fields and never touches revision', () => {
    const base = { revision: 4, thinkingLevel: 'high', mode: 'agent' as const };
    const next = mergePreferences(base, { thinkingLevel: 'low', model: undefined });
    expect(next).toEqual({ revision: 4, thinkingLevel: 'low', mode: 'agent' });
  });

  it('does not clear fields with empty strings in a receipt', () => {
    expect(pickDefinedPreferences({ revision: 2, thinkingLevel: '', mode: undefined })).toEqual({ revision: 2 });
  });

  it('accepts a complete receipt and rejects malformed models', () => {
    expect(
      pickDefinedPreferences({
        model: { provider: 'anthropic', id: 'opus' },
        thinkingLevel: 'high',
        mode: 'ask',
        approval: 'workspace',
        revision: 7,
      }),
    ).toEqual({
      model: { provider: 'anthropic', id: 'opus' },
      thinkingLevel: 'high',
      mode: 'ask',
      approval: 'workspace',
      revision: 7,
    });
    expect(pickDefinedPreferences({ model: { provider: '', id: 'x' } })).toEqual({ revision: 0 });
  });

  it('starts empty with revision 0', () => {
    expect(emptyPreferences()).toEqual({ revision: 0 });
  });

  it('merges fastMode true and false without advancing revision', () => {
    const base = { revision: 4, thinkingLevel: 'high' as const };
    expect(mergePreferences(base, { fastMode: true })).toEqual({ revision: 4, thinkingLevel: 'high', fastMode: true });
    const on = mergePreferences(base, { fastMode: true });
    // false 是有效值，不能被 truthy 过滤吃掉。
    expect(mergePreferences(on, { fastMode: false })).toEqual({ revision: 4, thinkingLevel: 'high', fastMode: false });
  });

  it('drops a non-boolean fastMode instead of coercing it', () => {
    expect(mergePreferences({ revision: 1 }, { fastMode: 'true' as never })).toEqual({ revision: 1 });
    expect(mergePreferences({ revision: 1 }, { fastMode: 0 as never })).toEqual({ revision: 1 });
  });
});
