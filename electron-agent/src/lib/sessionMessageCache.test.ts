import { describe, expect, it } from 'vitest';
import {
  getCachedSession,
  invalidateCachedSession,
  setCachedSession,
} from './sessionMessageCache';

describe('invalidateCachedSession', () => {
  it('evicts the entry for a path', () => {
    setCachedSession('/p/a.jsonl', [], '0');
    expect(getCachedSession('/p/a.jsonl')).toBeDefined();
    invalidateCachedSession('/p/a.jsonl');
    expect(getCachedSession('/p/a.jsonl')).toBeUndefined();
  });

  it('is a no-op for an unknown path', () => {
    expect(() => invalidateCachedSession('/p/missing.jsonl')).not.toThrow();
  });
});

describe('equivalent session paths', () => {
  it('finds, replaces and evicts an entry written under another spelling of the path', () => {
    setCachedSession('C:\\Sessions\\A.jsonl', [], '0');
    expect(getCachedSession('c:/sessions/a.jsonl')).toEqual({ messages: [], sig: '0' });
    setCachedSession('c:/sessions/a.jsonl', [], '1');
    expect(getCachedSession('C:\\Sessions\\A.jsonl')?.sig).toBe('1');
    invalidateCachedSession('C:/Sessions/A.jsonl');
    expect(getCachedSession('c:/sessions/a.jsonl')).toBeUndefined();
  });
});
