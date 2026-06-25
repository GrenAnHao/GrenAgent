import { describe, expect, it } from 'vitest';
import { detectCycles, findPaths } from './codeGraphPath';

const nodes = ['a', 'b', 'c', 'd'];
const acyclicEdges = [
  { source: 'a', target: 'b' },
  { source: 'b', target: 'c' },
  { source: 'a', target: 'c' },
  { source: 'c', target: 'd' },
];

describe('findPaths', () => {
  it('finds direct path', () => {
    expect(findPaths(nodes, acyclicEdges, 'a', 'b')).toEqual([['a', 'b']]);
  });

  it('finds all multi-hop paths', () => {
    const paths = findPaths(nodes, acyclicEdges, 'a', 'd');
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual(['a', 'b', 'c', 'd']);
    expect(paths).toContainEqual(['a', 'c', 'd']);
  });

  it('returns empty when no path exists', () => {
    expect(findPaths(nodes, acyclicEdges, 'd', 'a')).toEqual([]);
  });
});

describe('detectCycles', () => {
  it('detects a simple cycle', () => {
    const cycleEdges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }];
    const cycles = detectCycles(['a', 'b'], cycleEdges);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain('a');
  });

  it('returns empty array when no cycle exists', () => {
    expect(detectCycles(nodes, acyclicEdges)).toEqual([]);
  });
});
