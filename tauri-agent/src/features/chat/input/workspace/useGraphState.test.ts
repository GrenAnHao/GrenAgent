import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useGraphState } from './useGraphState';
import type { RichGraph } from '../../../../lib/codeGraphTypes';

const graph: RichGraph = {
  nodes: [
    { path: 'a.ts', lines: 10, exportCount: 1, complexity: 0.1, inDegree: 1, x: 0, y: 0 },
    { path: 'b.ts', lines: 20, exportCount: 2, complexity: 0.2, inDegree: 0, x: 0, y: 0 },
  ],
  edges: [{ source: 'a.ts', target: 'b.ts', kind: 'import-value', weight: 1 }],
  circularPaths: [],
};

describe('useGraphState', () => {
  it('starts with no selection', () => {
    const { result } = renderHook(() => useGraphState(graph));
    expect(result.current.state.selected).toBeNull();
  });

  it('selects node on click', () => {
    const { result } = renderHook(() => useGraphState(graph));
    act(() => result.current.onNodeClick('a.ts'));
    expect(result.current.state.selected).toBe('a.ts');
  });

  it('deselects on second click of same node', () => {
    const { result } = renderHook(() => useGraphState(graph));
    act(() => result.current.onNodeClick('a.ts'));
    act(() => result.current.onNodeClick('a.ts'));
    expect(result.current.state.selected).toBeNull();
  });

  it('sets pathSource on shift-click', () => {
    const { result } = renderHook(() => useGraphState(graph));
    act(() => result.current.onNodeClick('a.ts', true));
    expect(result.current.state.pathSource).toBe('a.ts');
  });

  it('sets pathTarget on second shift-click', () => {
    const { result } = renderHook(() => useGraphState(graph));
    act(() => result.current.onNodeClick('a.ts', true));
    act(() => result.current.onNodeClick('b.ts', true));
    expect(result.current.state.pathTarget).toBe('b.ts');
  });

  it('clears on pane click', () => {
    const { result } = renderHook(() => useGraphState(graph));
    act(() => result.current.onNodeClick('a.ts'));
    act(() => result.current.onPaneClick());
    expect(result.current.state.selected).toBeNull();
  });
});
