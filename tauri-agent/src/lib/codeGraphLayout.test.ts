import { describe, expect, it } from 'vitest';
import type { RichGraph } from './codeGraphTypes';
import { computeForceLayout } from './codeGraphLayout';

describe('computeForceLayout', () => {
  it('returns a finite position for every node', () => {
    const graph: Pick<RichGraph, 'nodes' | 'edges'> = {
      nodes: [
        { path: 'a.ts', lines: 10, exportCount: 1, complexity: 0.1, inDegree: 0, x: 0, y: 0 },
        { path: 'b.ts', lines: 20, exportCount: 2, complexity: 0.2, inDegree: 1, x: 0, y: 0 },
        { path: 'c.ts', lines: 5, exportCount: 0, complexity: 0.0, inDegree: 1, x: 0, y: 0 },
      ],
      edges: [
        { source: 'a.ts', target: 'b.ts', kind: 'import-value', weight: 2 },
        { source: 'b.ts', target: 'c.ts', kind: 'import-value', weight: 1 },
      ],
    };
    const pos = computeForceLayout(graph, { iterations: 60 });
    expect(pos.size).toBe(3);
    for (const id of ['a.ts', 'b.ts', 'c.ts']) {
      const p = pos.get(id)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('ignores edges that reference unknown nodes without throwing', () => {
    const graph: Pick<RichGraph, 'nodes' | 'edges'> = {
      nodes: [{ path: 'a.ts', lines: 5, exportCount: 0, complexity: 0.0, inDegree: 0, x: 0, y: 0 }],
      edges: [{ source: 'a.ts', target: 'ghost.ts', kind: 'import-value', weight: 1 }],
    };
    const pos = computeForceLayout(graph, { iterations: 10 });
    expect(pos.size).toBe(1);
    expect(pos.has('a.ts')).toBe(true);
  });

  it('handles an empty graph', () => {
    const pos = computeForceLayout({ nodes: [], edges: [] }, { iterations: 5 });
    expect(pos.size).toBe(0);
  });
});
