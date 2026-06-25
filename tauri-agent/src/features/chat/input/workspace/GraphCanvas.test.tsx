import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphCanvas } from './GraphCanvas';
import type { EdgeKind, GraphEdge, GraphNode, RichGraph } from '../../../../lib/codeGraphTypes';

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children, onPaneClick, edges, nodes }: any) => (
    <div
      data-testid="react-flow"
      data-edge-count={edges?.length ?? 0}
      data-node-count={nodes?.length ?? 0}
      onClick={onPaneClick}
    >
      {children}
    </div>
  ),
  ReactFlowProvider: ({ children }: any) => <>{children}</>,
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  useReactFlow: () => ({ setCenter: vi.fn() }),
  MarkerType: { ArrowClosed: 'arrowclosed' },
}));

const allKinds = new Set<EdgeKind>(['import-value', 'import-type', 'reexport', 'dynamic', 'call', 'circular']);

const smallGraph: RichGraph = {
  nodes: [
    { path: 'src/a.ts', lines: 10, exportCount: 1, complexity: 0.2, inDegree: 0, x: 0, y: 0 },
    { path: 'src/b.ts', lines: 20, exportCount: 2, complexity: 0.4, inDegree: 1, x: 0, y: 0 },
  ],
  edges: [{ source: 'src/a.ts', target: 'src/b.ts', kind: 'import-value', weight: 1 }],
  circularPaths: [],
};

// Chain of n+1 nodes / n edges with descending weights so skeleton ordering is deterministic.
function chainGraph(n: number): RichGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i <= n; i++) {
    nodes.push({ path: `src/n${i}.ts`, lines: 1, exportCount: 0, complexity: 0, inDegree: i === 0 ? 0 : 1, x: 0, y: 0 });
  }
  for (let i = 0; i < n; i++) {
    edges.push({ source: `src/n${i}.ts`, target: `src/n${i + 1}.ts`, kind: 'import-value', weight: n - i });
  }
  return { nodes, edges, circularPaths: [] };
}

const edgeCount = (el: HTMLElement) => Number(el.getAttribute('data-edge-count'));

describe('GraphCanvas', () => {
  it('renders without crashing', () => {
    const { getByTestId } = render(
      <GraphCanvas graph={smallGraph} highlightSet={new Set()} pathEdges={new Set()}
        visibleKinds={allKinds} searchQuery=""
        onNodeClick={vi.fn()} onPaneClick={vi.fn()} />,
    );
    expect(getByTestId('react-flow')).toBeTruthy();
  });

  it('caps the default view to a strongest-edges skeleton', () => {
    const { getByTestId } = render(
      <GraphCanvas graph={chainGraph(200)} highlightSet={new Set()} pathEdges={new Set()}
        visibleKinds={allKinds} searchQuery=""
        onNodeClick={vi.fn()} onPaneClick={vi.fn()} />,
    );
    const count = edgeCount(getByTestId('react-flow'));
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(80);
  });

  it('on selection renders only the focused neighborhood edges', () => {
    // Highlight two adjacent nodes -> only the edge between them has both endpoints in the set.
    const { getByTestId } = render(
      <GraphCanvas graph={chainGraph(200)} highlightSet={new Set(['src/n0.ts', 'src/n1.ts'])} pathEdges={new Set()}
        visibleKinds={allKinds} searchQuery=""
        onNodeClick={vi.fn()} onPaneClick={vi.fn()} />,
    );
    expect(edgeCount(getByTestId('react-flow'))).toBe(1);
  });
});
