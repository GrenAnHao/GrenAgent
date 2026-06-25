import { describe, expect, it } from 'vitest';
import type { EdgeKind, GraphEdge, GraphNode, RichGraph } from './codeGraphTypes';

describe('codeGraphTypes', () => {
  it('constructs a valid RichGraph at runtime', () => {
    const node: GraphNode = { path: 'src/a.ts', lines: 100, exportCount: 3, complexity: 0.4, inDegree: 2, x: 0, y: 0 };
    const edge: GraphEdge = { source: 'src/a.ts', target: 'src/b.ts', kind: 'import-value', weight: 1 };
    const graph: RichGraph = { nodes: [node], edges: [edge], circularPaths: [] };
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges[0].kind).toBe('import-value');
    expect(graph.circularPaths).toEqual([]);
  });

  it('accepts all EdgeKind values', () => {
    const kinds: EdgeKind[] = ['import-value', 'import-type', 'reexport', 'dynamic', 'call', 'circular'];
    expect(kinds).toHaveLength(6);
  });
});
