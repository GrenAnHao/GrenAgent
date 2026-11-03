import { describe, expect, it } from 'vitest';
import { deltaDecision, descendantIds } from './incremental';
describe('native incremental gate', () => {
  it('rejects an oversized explicit update instead of silently regenerating', () => {
    expect(deltaDecision('update', { files: Array.from({ length: 1001 }, (_, i) => String(i)), applyCommits: 1, dropCommits: 0, changedCommits: 1 }, false)).toBe('reject');
  });
  it('takes the zero-model advance path only for an empty delta', () => {
    expect(deltaDecision('sync', { files: [], applyCommits: 1, dropCommits: 0, changedCommits: 1 }, false)).toBe('advance');
  });
  it('cascades an explicit deletion to descendants only', () => {
    expect(descendantIds([{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'd', parentId: null }], ['a'])).toEqual(['a', 'b', 'c']);
  });
});
