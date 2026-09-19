import { describe, expect, it } from 'vitest';
import { buildGraph, cx0, ROW_H, rowSegments, type GraphCommit } from './gitGraphLayout';

function commit(hash: string, parents: string[]): GraphCommit {
  return { hash, parents };
}

/** Two sequential one-commit merges, matching the Git 图谱 screenshot topology. */
const sequentialMerges = [
  commit('M1', ['M2', 'A']),
  commit('A', ['M2']),
  commit('M2', ['C', 'B']),
  commit('B', ['C']),
  commit('C', ['D']),
  commit('D', []),
];

describe('buildGraph', () => {
  it('reuses the side lane after a one-commit branch merges, then forks the next branch on that lane', () => {
    const { rows } = buildGraph(sequentialMerges);
    expect(rows.map((row) => ({ hash: row.commit.hash, col: row.col, mergedFrom: row.mergedFrom, parentCols: row.parentCols }))).toEqual([
      { hash: 'M1', col: 0, mergedFrom: [], parentCols: [0, 1] },
      { hash: 'A', col: 1, mergedFrom: [], parentCols: [1] },
      { hash: 'M2', col: 0, mergedFrom: [1], parentCols: [0, 1] },
      { hash: 'B', col: 1, mergedFrom: [], parentCols: [1] },
      { hash: 'C', col: 0, mergedFrom: [1], parentCols: [0] },
      { hash: 'D', col: 0, mergedFrom: [], parentCols: [] },
    ]);
  });
});

describe('rowSegments', () => {
  const mid = ROW_H / 2;
  const x0 = cx0(0);
  const x1 = cx0(1);

  it('does not punch a through-line when a side lane merges in and immediately forks out', () => {
    const { rows } = buildGraph(sequentialMerges);
    const segs = rowSegments(rows[2]!);

    expect(segs.filter((seg) => seg.x1 === x1 && seg.x2 === x1)).toEqual([]);
    expect(segs.filter((seg) => seg.y1 === mid && seg.y2 === mid)).toEqual([]);
    expect(segs).toContainEqual({ key: 'm1', colorCol: 1, x1: x1, y1: 0, x2: x0, y2: mid });
    expect(segs).toContainEqual({ key: 'p1', colorCol: 1, x1: x0, y1: mid, x2: x1, y2: ROW_H });
  });

  it('joins a finished branch with a top-half diagonal instead of a mid-line stub', () => {
    const { rows } = buildGraph(sequentialMerges);
    const segs = rowSegments(rows[4]!);

    expect(segs).toContainEqual({ key: 'm1', colorCol: 1, x1: x1, y1: 0, x2: x0, y2: mid });
    expect(segs.filter((seg) => seg.x1 === x1 && seg.x2 === x1)).toEqual([]);
    expect(segs.filter((seg) => seg.y1 === mid && seg.y2 === mid)).toEqual([]);
  });

  it('keeps a passing lane vertical when a merge forks onto a new column', () => {
    const log = [
      commit('M1', ['M2', 'A']),
      commit('A', ['C']),
      commit('M2', ['C', 'B']),
      commit('B', ['C']),
      commit('C', []),
    ];
    const { rows } = buildGraph(log);
    const m2 = rows[2]!;
    expect(m2.parentCols).toEqual([0, 2]);
    const segs = rowSegments(m2);
    const x2 = cx0(2);
    expect(segs).toContainEqual({ key: 'i1', colorCol: 1, x1: x1, y1: 0, x2: x1, y2: mid });
    expect(segs).toContainEqual({ key: 'o1', colorCol: 1, x1: x1, y1: mid, x2: x1, y2: ROW_H });
    expect(segs).toContainEqual({ key: 'p2', colorCol: 2, x1: x0, y1: mid, x2: x2, y2: ROW_H });
    expect(segs.filter((seg) => seg.x1 === x2 && seg.x2 === x2)).toEqual([]);
  });
});
