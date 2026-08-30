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
