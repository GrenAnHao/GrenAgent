import { useMemo, useState } from 'react';
import type { EdgeKind, RichGraph } from '../../../../lib/codeGraphTypes';
import { findPaths } from '../../../../lib/codeGraphPath';

export interface GraphState {
  searchQuery: string;
  selected: string | null;
  depth: 1 | 2 | 3 | 4;
  pathSource: string | null;
  pathTarget: string | null;
  collapsed: boolean;
  expandedDirs: Set<string>;
  visibleKinds: Set<EdgeKind>;
}

const ALL_KINDS: EdgeKind[] = ['import-value', 'import-type', 'reexport', 'dynamic', 'call', 'circular'];

const INIT: GraphState = {
  searchQuery: '',
  selected: null,
  depth: 1,
  pathSource: null,
  pathTarget: null,
  collapsed: false,
  expandedDirs: new Set(),
  visibleKinds: new Set(ALL_KINDS),
};

export function useGraphState(graph: RichGraph | null) {
  const [state, setState] = useState<GraphState>(INIT);

  const onNodeClick = (id: string, shiftKey = false) =>
    setState((s) => {
      if (!shiftKey) return { ...s, selected: s.selected === id ? null : id, pathSource: null, pathTarget: null };
      if (s.pathSource === null) return { ...s, pathSource: id };
      return { ...s, pathTarget: id };
    });

  const onPaneClick = () =>
    setState((s) => ({ ...s, selected: null, pathSource: null, pathTarget: null }));

  const setSearch = (searchQuery: string) => setState((s) => ({ ...s, searchQuery }));
  const setDepth = (depth: 1 | 2 | 3 | 4) => setState((s) => ({ ...s, depth }));
  const setCollapsed = (collapsed: boolean) => setState((s) => ({ ...s, collapsed }));
  const expandDir = (dir: string) =>
    setState((s) => { const d = new Set(s.expandedDirs); d.add(dir); return { ...s, expandedDirs: d }; });
  const toggleKind = (k: EdgeKind) =>
    setState((s) => {
      const v = new Set(s.visibleKinds);
      v.has(k) ? v.delete(k) : v.add(k);
      return { ...s, visibleKinds: v };
    });

  const highlightSet = useMemo<Set<string>>(() => {
    if (!graph || (!state.selected && !state.pathSource)) return new Set();
    const focus = state.selected ?? state.pathSource!;
    const visited = new Set<string>([focus]);
    let frontier = [focus];
    for (let i = 0; i < state.depth; i++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const e of graph.edges) {
          if (e.source === n && !visited.has(e.target)) { visited.add(e.target); next.push(e.target); }
          if (e.target === n && !visited.has(e.source)) { visited.add(e.source); next.push(e.source); }
        }
      }
      frontier = next;
    }
    return visited;
  }, [graph, state.selected, state.pathSource, state.depth]);

  const pathEdges = useMemo<Set<string>>(() => {
    if (!graph || !state.pathSource || !state.pathTarget) return new Set();
    const nodeIds = graph.nodes.map((n) => n.path);
    const paths = findPaths(nodeIds, graph.edges, state.pathSource, state.pathTarget);
    const edgeIds = new Set<string>();
    for (const path of paths) {
      for (let i = 0; i < path.length - 1; i++) edgeIds.add(`${path[i]}=>${path[i + 1]}`);
    }
    return edgeIds;
  }, [graph, state.pathSource, state.pathTarget]);

  return { state, onNodeClick, onPaneClick, setSearch, setDepth, setCollapsed, expandDir, toggleKind, highlightSet, pathEdges };
}
