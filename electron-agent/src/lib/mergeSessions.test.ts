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
});

describe('pruneOptimisticSessions', () => {
  it('drops optimistic entries once disk has the same path', () => {
    const disk = [s('/a/s1.jsonl', '/proj/a')];
    const opt = [s('/a/s1.jsonl', '/proj/a'), s('/a/s2.jsonl', '/proj/a')];
    expect(pruneOptimisticSessions(disk, opt)).toHaveLength(1);
    expect(pruneOptimisticSessions(disk, opt)[0].path).toBe('/a/s2.jsonl');
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
