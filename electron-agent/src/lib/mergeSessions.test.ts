import { describe, expect, it } from 'vitest';
import { filterDeletedSessions, mergeAllSessions, pruneOptimisticSessions } from './mergeSessions';
import type { SessionInfo } from './pi';

const s = (path: string, cwd: string): SessionInfo => ({
  id: path,
  path,
  cwd,
  timestamp: '2026-01-01T00:00:00Z',
  name: null,
});

describe('mergeAllSessions', () => {
  it('appends optimistic sessions not yet on disk', () => {
    const disk = [s('/a/s1.jsonl', '/proj/a')];
    const opt = [s('/a/s2.jsonl', '/proj/a')];
    expect(mergeAllSessions(disk, opt)).toHaveLength(2);
  });

  it('dedupes by path', () => {
    const disk = [s('/a/s1.jsonl', '/proj/a')];
    const opt = [s('/a/s1.jsonl', '/proj/a')];
    expect(mergeAllSessions(disk, opt)).toHaveLength(1);
  });

  it('keeps the first-message title when disk has the same path but no name', () => {
    const disk = [s('/a/s1.jsonl', '/proj/a')];
    const opt = [{ ...s('/a/s1.jsonl', '/proj/a'), name: '帮我修一下登录页' }];
    expect(mergeAllSessions(disk, opt)).toEqual([
      { ...disk[0], name: '帮我修一下登录页' },
    ]);
  });

  it('does not overlay an optimistic title over a named disk session', () => {
    const disk = [{ ...s('/a/s1.jsonl', '/proj/a'), name: '修复登录页' }];
    const opt = [{ ...s('/a/s1.jsonl', '/proj/a'), name: '帮我修一下登录页' }];
    expect(mergeAllSessions(disk, opt)[0].name).toBe('修复登录页');
  });
});

describe('pruneOptimisticSessions', () => {
  it('drops optimistic entries once disk has the same path', () => {
    const disk = [s('/a/s1.jsonl', '/proj/a')];
    const opt = [s('/a/s1.jsonl', '/proj/a'), s('/a/s2.jsonl', '/proj/a')];
    expect(pruneOptimisticSessions(disk, opt)).toHaveLength(1);
    expect(pruneOptimisticSessions(disk, opt)[0].path).toBe('/a/s2.jsonl');
  });

  it('keeps an optimistic first-message title until disk names the session', () => {
    const disk = [s('/a/s1.jsonl', '/proj/a')];
    const opt = [{ ...s('/a/s1.jsonl', '/proj/a'), name: '帮我修一下登录页' }];
    expect(pruneOptimisticSessions(disk, opt)).toEqual(opt);
  });

  it('drops optimistic entries once disk has named the session', () => {
    const disk = [{ ...s('/a/s1.jsonl', '/proj/a'), name: '修复登录页' }];
    const opt = [{ ...s('/a/s1.jsonl', '/proj/a'), name: '帮我修一下登录页' }];
    expect(pruneOptimisticSessions(disk, opt)).toEqual([]);
  });
});

describe('filterDeletedSessions', () => {
  it('returns the same list when nothing is marked deleted', () => {
    const list = [s('/a/s1.jsonl', '/proj/a')];
    expect(filterDeletedSessions(list, [])).toBe(list);
  });

  it('removes sessions whose path is marked deleted', () => {
    const list = [s('/a/s1.jsonl', '/proj/a'), s('/a/s2.jsonl', '/proj/a')];
    const out = filterDeletedSessions(list, ['/a/s1.jsonl']);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('/a/s2.jsonl');
  });

  it('matches paths irrespective of separator/case differences', () => {
    const list = [s('C:\\proj\\a\\s1.jsonl', 'C:\\proj\\a')];
    expect(filterDeletedSessions(list, ['c:/proj/a/s1.jsonl'])).toHaveLength(0);
  });
});
