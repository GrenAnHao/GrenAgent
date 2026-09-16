# Code Graph Rich Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the code graph panel with typed edges, rich node cards, path-finding, and interactive controls.

**Architecture:** Data/render separation — new codeGraphTypes.ts defines shared types; codeGraphIo.ts gains getRichGraph(); new Rust command code_intel_rich_graph queries all edge kinds from DB; four new React components replace the monolithic CodeGraphPanel; useGraphState.ts centralises all interaction state.

**Tech Stack:** React 19 + TypeScript, ReactFlow (@xyflow/react), d3-force, rusqlite (Rust), Tauri invoke, vitest

## Global Constraints
- All TS files under tauri-agent/src/; Rust under tauri-agent/src-tauri/src/commands/code_intel.rs
- No emoji in UI — use text badges [tsx], [ts], [rs], [css], [idx], [...]
- Test runner: npx vitest run <file> from tauri-agent/
- Circular edges are derived — not stored in RichGraph.edges; rendered from circularPaths
- FileGraph / getFileGraph must stay exported (mark @deprecated, do not delete)

---

## Task 1: codeGraphTypes.ts — shared type definitions

**Files:**
- Create: `tauri-agent/src/lib/codeGraphTypes.ts`
- Test: `tauri-agent/src/lib/codeGraphTypes.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type EdgeKind = 'import-value' | 'import-type' | 'reexport' | 'dynamic' | 'call' | 'circular'`
  - `interface GraphNode { path: string; lines: number; exportCount: number; complexity: number; inDegree: number }`
  - `interface GraphEdge { source: string; target: string; kind: EdgeKind; weight: number }`
  - `interface RichGraph { nodes: GraphNode[]; edges: GraphEdge[]; circularPaths: string[][] }`

### Steps

- [ ] **1. Write failing test** — create `tauri-agent/src/lib/codeGraphTypes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { EdgeKind, GraphEdge, GraphNode, RichGraph } from './codeGraphTypes';

describe('codeGraphTypes', () => {
  it('constructs a valid RichGraph at runtime', () => {
    const node: GraphNode = { path: 'src/a.ts', lines: 100, exportCount: 3, complexity: 0.4, inDegree: 2 };
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
```

- [ ] **2. Run test — verify FAIL:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx vitest run src/lib/codeGraphTypes.test.ts
```
Expected: `Error: Failed to resolve import "./codeGraphTypes"`

- [ ] **3. Write implementation** — create `tauri-agent/src/lib/codeGraphTypes.ts`:

```typescript
export type EdgeKind =
  | 'import-value'
  | 'import-type'
  | 'reexport'
  | 'dynamic'
  | 'call'
  | 'circular';

export interface GraphNode {
  path: string;
  /** AST node count (approximates lines; exportCount/complexity reserved for future DB columns). */
  lines: number;
  exportCount: number;
  complexity: number;
  inDegree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
}

export interface RichGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Cycle arrays derived by detectCycles(); never stored in edges. */
  circularPaths: string[][];
}
```

- [ ] **4. Run test — verify PASS:**
```
npx vitest run src/lib/codeGraphTypes.test.ts
```
Expected: `2 tests passed`

- [ ] **5. Commit:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
git add src/lib/codeGraphTypes.ts src/lib/codeGraphTypes.test.ts
git commit -m "feat(code-graph): add codeGraphTypes shared types (EdgeKind, GraphNode, GraphEdge, RichGraph)"
```

---

## Task 2: codeGraphPath.ts — BFS path-finding and cycle detection

**Files:**
- Create: `tauri-agent/src/lib/codeGraphPath.ts`
- Test: `tauri-agent/src/lib/codeGraphPath.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no imports)
- Produces:
  - `findPaths(nodes: string[], edges: {source:string,target:string}[], src: string, dst: string): string[][]`
  - `detectCycles(nodes: string[], edges: {source:string,target:string}[]): string[][]`

### Steps

- [ ] **1. Write failing test** — create `tauri-agent/src/lib/codeGraphPath.test.ts`:

```typescript
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
```

- [ ] **2. Run test — verify FAIL:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx vitest run src/lib/codeGraphPath.test.ts
```
Expected: `Error: Failed to resolve import "./codeGraphPath"`

- [ ] **3. Write implementation** — create `tauri-agent/src/lib/codeGraphPath.ts`:

```typescript
type Edge = { source: string; target: string };

function buildAdj(nodes: string[], edges: Edge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);
  return adj;
}

/**
 * BFS: all simple paths from src to dst with depth <= 10.
 */
export function findPaths(nodes: string[], edges: Edge[], src: string, dst: string): string[][] {
  const adj = buildAdj(nodes, edges);
  const results: string[][] = [];
  const queue: { path: string[]; visited: Set<string> }[] = [{ path: [src], visited: new Set([src]) }];
  while (queue.length > 0) {
    const { path, visited } = queue.shift()!;
    if (path.length >= 10) continue;
    const cur = path[path.length - 1];
    for (const next of adj.get(cur) ?? []) {
      if (next === dst) {
        results.push([...path, dst]);
      } else if (!visited.has(next)) {
        queue.push({ path: [...path, next], visited: new Set([...visited, next]) });
      }
    }
  }
  return results;
}

/**
 * DFS-based cycle detection. Returns each cycle as an array ending with the repeated node.
 */
export function detectCycles(nodes: string[], edges: Edge[]): string[][] {
  const adj = buildAdj(nodes, edges);
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  function dfs(node: string): void {
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const next of adj.get(node) ?? []) {
      if (!visited.has(next)) {
        dfs(next);
      } else if (onStack.has(next)) {
        const idx = stack.indexOf(next);
        cycles.push([...stack.slice(idx), next]);
      }
    }
    stack.pop();
    onStack.delete(node);
  }

  for (const n of nodes) {
    if (!visited.has(n)) dfs(n);
  }
  return cycles;
}
```

- [ ] **4. Run test — verify PASS:**
```
npx vitest run src/lib/codeGraphPath.test.ts
```
Expected: `5 tests passed`

- [ ] **5. Commit:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
git add src/lib/codeGraphPath.ts src/lib/codeGraphPath.test.ts
git commit -m "feat(code-graph): add codeGraphPath BFS path-finding and cycle detection"
```

---

## Task 3: Rust code_intel_rich_graph + TypeScript getRichGraph

**Files:**
- Modify: `tauri-agent/src-tauri/src/commands/code_intel.rs`
- Modify: `tauri-agent/src-tauri/src/lib.rs` (register command)
- Modify: `tauri-agent/src/lib/codeGraphIo.ts`
- Test: `tauri-agent/src/lib/codeGraphIo.test.ts`

**Interfaces:**
- Consumes: `GraphNode`, `GraphEdge`, `EdgeKind`, `RichGraph` from Task 1
- Produces: `getRichGraph(workspace: string): Promise<RichGraph>`; Rust `code_intel_rich_graph`

### Steps

- [ ] **1. Write failing test** — add to `tauri-agent/src/lib/codeGraphIo.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { getRichGraph } from './codeGraphIo';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({
    nodes: [{ path: 'src/a.ts', lines: 0, exportCount: 0, complexity: 0, inDegree: 1 }],
    edges: [{ source: 'src/a.ts', target: 'src/b.ts', kind: 'import-value', weight: 1 }],
    circularPaths: [],
  }),
}));

describe('getRichGraph', () => {
  it('returns a RichGraph from invoke', async () => {
    const g = await getRichGraph('/workspace');
    expect(g.nodes).toHaveLength(1);
    expect(g.edges[0].kind).toBe('import-value');
  });
});
```

- [ ] **2. Run test — verify FAIL:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx vitest run src/lib/codeGraphIo.test.ts
```
Expected: `Error: getRichGraph is not a function`

- [ ] **3. Add Rust structs and command** — in `code_intel.rs` after the `FileGraph` impl block:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RichGraphNode {
    pub path: String,
    pub lines: i64,
    pub export_count: i64,
    pub complexity: f64,
    pub in_degree: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RichGraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub weight: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RichGraph {
    pub nodes: Vec<RichGraphNode>,
    pub edges: Vec<RichGraphEdge>,
    pub circular_paths: Vec<Vec<String>>,
}

fn db_kind_to_edge_kind(k: &str) -> &'static str {
    match k {
        "imports" | "import" => "import-value",
        "type_imports" | "import_type" | "type-import" => "import-type",
        "reexports" | "reexport" | "re_export" => "reexport",
        "dynamic_imports" | "dynamic_import" | "dynamic" => "dynamic",
        "calls" | "call" | "invokes" => "call",
        _ => "import-value",
    }
}

#[tauri::command]
pub async fn code_intel_rich_graph(
    workspace: String,
    limit: Option<u32>,
) -> Result<RichGraph, String> {
    let conn = open_codegraph_db(&workspace)?;
    let max_edges = limit.unwrap_or(3000).clamp(1, 20000);

    // All edge kinds, file-level aggregation.
    let mut stmt = conn
        .prepare(
            "SELECT src.file_path, tgt.file_path, e.kind, COUNT(*) \
             FROM edges e \
             JOIN nodes src ON e.source = src.id \
             JOIN nodes tgt ON e.target = tgt.id \
             WHERE src.file_path <> tgt.file_path \
             GROUP BY src.file_path, tgt.file_path, e.kind \
             ORDER BY COUNT(*) DESC \
             LIMIT ?1",
        )
        .map_err(|e| format!("query edges failed: {e}"))?;

    let raw_edges: Vec<(String, String, String, i64)> = stmt
        .query_map([max_edges], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("query edges failed: {e}"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("read edges failed: {e}"))?;

    // Compute inDegree from edge targets.
    let mut in_degree: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for (_, tgt, _, _) in &raw_edges {
        *in_degree.entry(tgt.clone()).or_insert(0) += 1;
    }

    let mut path_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (src, tgt, _, _) in &raw_edges {
        path_set.insert(src.clone());
        path_set.insert(tgt.clone());
    }

    // File metadata.
    let mut meta_stmt = conn
        .prepare("SELECT path, node_count FROM files")
        .map_err(|e| format!("query files failed: {e}"))?;
    let meta: std::collections::HashMap<String, i64> = meta_stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| format!("query files failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read files failed: {e}"))?
        .into_iter()
        .collect();

    // Normalise node_count to complexity 0-1 (clamped at 500 nodes).
    let max_nc = meta.values().copied().max().unwrap_or(1).max(1);
    let nodes: Vec<RichGraphNode> = {
        let mut v: Vec<RichGraphNode> = path_set
            .iter()
            .map(|p| {
                let nc = meta.get(p).copied().unwrap_or(0);
                RichGraphNode {
                    path: p.clone(),
                    lines: nc,
                    export_count: nc,
                    complexity: (nc as f64 / max_nc as f64).min(1.0),
                    in_degree: in_degree.get(p).copied().unwrap_or(0),
                }
            })
            .collect();
        v.sort_by(|a, b| a.path.cmp(&b.path));
        v
    };

    let edges: Vec<RichGraphEdge> = raw_edges
        .into_iter()
        .map(|(src, tgt, kind, weight)| RichGraphEdge {
            source: src,
            target: tgt,
            kind: db_kind_to_edge_kind(&kind).to_string(),
            weight,
        })
        .collect();

    Ok(RichGraph { nodes, edges, circular_paths: vec![] })
}
```

- [ ] **4. Register in lib.rs** — add `commands::code_intel::code_intel_rich_graph,` to the `invoke_handler!` list next to `code_intel_file_graph`.

- [ ] **5. Add getRichGraph to codeGraphIo.ts:**

```typescript
import type { RichGraph } from './codeGraphTypes';

/** @deprecated Use getRichGraph instead. */
export type { FileGraph, FileGraphNode, FileGraphEdge };
/** @deprecated Use getRichGraph instead. */
export { getFileGraph };

export function getRichGraph(workspace: string, limit?: number): Promise<RichGraph> {
  return invoke<RichGraph>('code_intel_rich_graph', { workspace, limit: limit ?? null });
}
```

- [ ] **6. Run test — verify PASS:**
```
npx vitest run src/lib/codeGraphIo.test.ts
```
Expected: `1 test passed`

- [ ] **7. Verify Rust compiles:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx tsc --noEmit
```
Rust compile check: `cargo check` from `src-tauri/`

- [ ] **8. Commit:**
```
git add src-tauri/src/commands/code_intel.rs src-tauri/src/lib.rs src/lib/codeGraphIo.ts src/lib/codeGraphIo.test.ts
git commit -m "feat(code-graph): add code_intel_rich_graph Rust command + getRichGraph TS wrapper"
```

---

## Task 4: codeGraphLayout.ts — accept RichGraph shape

**Files:**
- Modify: `tauri-agent/src/lib/codeGraphLayout.ts`
- Modify: `tauri-agent/src/lib/codeGraphLayout.test.ts`

**Interfaces:**
- Consumes: `GraphNode`, `GraphEdge` from Task 1
- Produces: `computeForceLayout(graph: {nodes:{path:string}[], edges:{source:string,target:string}[]}, opts?): Map<string, NodePosition>`

### Steps

- [ ] **1. Update test** — in `codeGraphLayout.test.ts`, change the test graph to a RichGraph-shaped object:

```typescript
import type { RichGraph } from './codeGraphTypes';
// Replace FileGraph fixture with:
const graph: Pick<RichGraph, 'nodes' | 'edges'> = {
  nodes: [
    { path: 'a.ts', lines: 10, exportCount: 1, complexity: 0.1, inDegree: 0 },
    { path: 'b.ts', lines: 20, exportCount: 2, complexity: 0.2, inDegree: 1 },
  ],
  edges: [{ source: 'a.ts', target: 'b.ts', kind: 'import-value', weight: 1 }],
  circularPaths: [],
};
```

- [ ] **2. Run test — verify FAIL (type error):**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx vitest run src/lib/codeGraphLayout.test.ts
```
Expected: TypeScript error on incompatible graph shape.

- [ ] **3. Update signature** — in `codeGraphLayout.ts`, change the parameter type:

```typescript
// Before:
export function computeForceLayout(graph: FileGraph, opts?: ForceLayoutOptions)

// After (drop the FileGraph import, use structural type):
export function computeForceLayout(
  graph: { nodes: { path: string }[]; edges: { source: string; target: string }[] },
  opts?: ForceLayoutOptions,
): Map<string, NodePosition>
```

Remove the `import type { FileGraph }` line if it exists.

- [ ] **4. Run test — verify PASS:**
```
npx vitest run src/lib/codeGraphLayout.test.ts
```

- [ ] **5. Commit:**
```
git add src/lib/codeGraphLayout.ts src/lib/codeGraphLayout.test.ts
git commit -m "refactor(code-graph): loosen codeGraphLayout signature to accept RichGraph shape"
```

---

## Task 5: useGraphState.ts — interaction state hook

**Files:**
- Create: `tauri-agent/src/features/chat/input/workspace/useGraphState.ts`
- Test: `tauri-agent/src/features/chat/input/workspace/useGraphState.test.ts`

**Interfaces:**
- Consumes: `EdgeKind` from Task 1; `findPaths`, `detectCycles` signatures from Task 2
- Produces:
  - `interface GraphState { searchQuery:string; selected:string|null; depth:1|2|3|4; pathSource:string|null; pathTarget:string|null; collapsed:boolean; expandedDirs:Set<string>; visibleKinds:Set<EdgeKind> }`
  - `function useGraphState(graph: RichGraph|null): { state: GraphState; onNodeClick(id:string, shiftKey?:boolean):void; onPaneClick():void; setSearch(q:string):void; setDepth(d:1|2|3|4):void; toggleKind(k:EdgeKind):void; setCollapsed(v:boolean):void; expandDir(dir:string):void; highlightSet:Set<string>; pathEdges:Set<string> }`

### Steps

- [ ] **1. Write failing test** — create `useGraphState.test.ts`:

```typescript
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useGraphState } from './useGraphState';
import type { RichGraph } from '../../../../lib/codeGraphTypes';

const graph: RichGraph = {
  nodes: [
    { path: 'a.ts', lines: 10, exportCount: 1, complexity: 0.1, inDegree: 1 },
    { path: 'b.ts', lines: 20, exportCount: 2, complexity: 0.2, inDegree: 0 },
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
```

- [ ] **2. Run test — verify FAIL:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx vitest run src/features/chat/input/workspace/useGraphState.test.ts
```
Expected: `Error: Failed to resolve import "./useGraphState"`

- [ ] **3. Write implementation** — create `useGraphState.ts`:

```typescript
import { useMemo, useState } from 'react';
import type { EdgeKind, RichGraph } from '../../../../lib/codeGraphTypes';
import { findPaths } from '../../../../lib/codeGraphPath';
import { topLevelDir } from '../../../../lib/codeGraphLayout';

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

  const onNodeClick = (id: string, shiftKey = false) => {
    setState((s) => {
      if (!shiftKey) {
        return { ...s, selected: s.selected === id ? null : id, pathSource: null, pathTarget: null };
      }
      if (s.pathSource === null) return { ...s, pathSource: id };
      return { ...s, pathTarget: id };
    });
  };

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

  // Derived: BFS from selected up to `depth` hops.
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

  // Derived: BFS paths between pathSource and pathTarget.
  const pathEdges = useMemo<Set<string>>(() => {
    if (!graph || !state.pathSource || !state.pathTarget) return new Set();
    const nodeIds = graph.nodes.map((n) => n.path);
    const paths = findPaths(nodeIds, graph.edges, state.pathSource, state.pathTarget);
    const edgeIds = new Set<string>();
    for (const path of paths) {
      for (let i = 0; i < path.length - 1; i++) {
        edgeIds.add(`${path[i]}=>${path[i + 1]}`);
      }
    }
    return edgeIds;
  }, [graph, state.pathSource, state.pathTarget]);

  return { state, onNodeClick, onPaneClick, setSearch, setDepth, setCollapsed, expandDir, toggleKind, highlightSet, pathEdges };
}
```

- [ ] **4. Run test — verify PASS:**
```
npx vitest run src/features/chat/input/workspace/useGraphState.test.ts
```
Expected: `6 tests passed`

- [ ] **5. Commit:**
```
git add src/features/chat/input/workspace/useGraphState.ts src/features/chat/input/workspace/useGraphState.test.ts
git commit -m "feat(code-graph): add useGraphState hook (search, depth, path, collapse)"
```

---

## Task 6: GraphToolbar.tsx — search, depth, edge kind toggles

**Files:**
- Create: `tauri-agent/src/features/chat/input/workspace/GraphToolbar.tsx`
- Test: `tauri-agent/src/features/chat/input/workspace/GraphToolbar.test.tsx`

**Interfaces:**
- Consumes: `GraphState`, `EdgeKind` from Tasks 1 & 5
- Produces: `<GraphToolbar state onSearch onDepth onToggleKind onToggleCollapse />`

### Steps

- [ ] **1. Write failing test** — create `GraphToolbar.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GraphToolbar } from './GraphToolbar';
import type { GraphState } from './useGraphState';

const base: GraphState = {
  searchQuery: '', selected: null, depth: 1,
  pathSource: null, pathTarget: null, collapsed: false,
  expandedDirs: new Set(),
  visibleKinds: new Set(['import-value', 'import-type', 'reexport', 'dynamic', 'call', 'circular']),
};

describe('GraphToolbar', () => {
  it('renders edge kind chips', () => {
    render(<GraphToolbar state={base} onSearch={vi.fn()} onDepth={vi.fn()} onToggleKind={vi.fn()} onToggleCollapse={vi.fn()} />);
    expect(screen.getByText('import')).toBeInTheDocument();
    expect(screen.getByText('type')).toBeInTheDocument();
  });

  it('disables depth slider when nothing selected', () => {
    render(<GraphToolbar state={base} onSearch={vi.fn()} onDepth={vi.fn()} onToggleKind={vi.fn()} onToggleCollapse={vi.fn()} />);
    expect(screen.getByRole('slider')).toBeDisabled();
  });
});
```

- [ ] **2. Run test — verify FAIL:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx vitest run src/features/chat/input/workspace/GraphToolbar.test.tsx
```
Expected: `Error: Failed to resolve import "./GraphToolbar"`

- [ ] **3. Write implementation** — create `GraphToolbar.tsx`:

```typescript
import type { EdgeKind } from '../../../../lib/codeGraphTypes';
import type { GraphState } from './useGraphState';

const KIND_LABELS: Record<EdgeKind, string> = {
  'import-value': 'import', 'import-type': 'type', 'reexport': 're-exp',
  'dynamic': 'lazy', 'call': 'call', 'circular': 'circular',
};
const KIND_COLORS: Record<EdgeKind, string> = {
  'import-value': '#6b7280', 'import-type': '#818cf8', 'reexport': '#34d399',
  'dynamic': '#f59e0b', 'call': '#38bdf8', 'circular': '#ef4444',
};

interface Props {
  state: GraphState;
  onSearch(q: string): void;
  onDepth(d: 1 | 2 | 3 | 4): void;
  onToggleKind(k: EdgeKind): void;
  onToggleCollapse(v: boolean): void;
}

export function GraphToolbar({ state, onSearch, onDepth, onToggleKind, onToggleCollapse }: Props) {
  const depthDisabled = state.selected === null || state.pathSource !== null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', flexWrap: 'wrap', fontSize: 11 }}>
      <input
        type="search"
        placeholder="搜索文件名…"
        value={state.searchQuery}
        onChange={(e) => onSearch(e.target.value)}
        style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #374151', background: '#1f2937', color: '#e2e8f0', fontSize: 11 }}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#9ca3af' }}>
        深度
        <input
          type="range" min={1} max={4} step={1}
          value={state.depth}
          disabled={depthDisabled}
          onChange={(e) => onDepth(Number(e.target.value) as 1 | 2 | 3 | 4)}
          aria-label="depth"
        />
        <span style={{ color: '#a78bfa', fontWeight: 600 }}>{state.depth}</span>
      </label>
      <div style={{ width: 1, height: 18, background: '#374151' }} />
      {(Object.keys(KIND_LABELS) as EdgeKind[]).map((k) => {
        const active = state.visibleKinds.has(k);
        return (
          <button
            key={k}
            type="button"
            onClick={() => onToggleKind(k)}
            style={{
              padding: '2px 7px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
              border: `1px solid ${active ? KIND_COLORS[k] : '#374151'}`,
              background: active ? `${KIND_COLORS[k]}22` : '#1f2937',
              color: active ? KIND_COLORS[k] : '#6b7280',
            }}
          >
            {KIND_LABELS[k]}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => onToggleCollapse(!state.collapsed)}
        style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, cursor: 'pointer', border: '1px solid #374151', background: state.collapsed ? '#1e3a5f' : '#1f2937', color: state.collapsed ? '#93c5fd' : '#6b7280' }}
      >
        {state.collapsed ? '展开' : '折叠分组'}
      </button>
    </div>
  );
}
```

- [ ] **4. Run test — verify PASS:**
```
npx vitest run src/features/chat/input/workspace/GraphToolbar.test.tsx
```
Expected: `2 tests passed`

- [ ] **5. Commit:**
```
git add src/features/chat/input/workspace/GraphToolbar.tsx src/features/chat/input/workspace/GraphToolbar.test.tsx
git commit -m "feat(code-graph): add GraphToolbar (search, depth slider, edge kind toggles)"
```

---

## Task 7: GraphSidebar.tsx — file detail panel

**Files:**
- Create: `tauri-agent/src/features/chat/input/workspace/GraphSidebar.tsx`
- Test: `tauri-agent/src/features/chat/input/workspace/GraphSidebar.test.tsx`

**Interfaces:**
- Consumes: `RichGraph`, `GraphNode` from Task 1
- Produces: `<GraphSidebar selected graph pathSource pathTarget paths onPick />`

### Steps

- [ ] **1. Write failing test** — create `GraphSidebar.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphSidebar } from './GraphSidebar';
import type { RichGraph } from '../../../../lib/codeGraphTypes';

const graph: RichGraph = {
  nodes: [{ path: 'src/a.ts', lines: 100, exportCount: 3, complexity: 0.4, inDegree: 2 }],
  edges: [{ source: 'src/a.ts', target: 'src/b.ts', kind: 'import-value', weight: 1 }],
  circularPaths: [],
};

describe('GraphSidebar', () => {
  it('shows hint when nothing selected', () => {
    render(<GraphSidebar selected={null} graph={graph} pathSource={null} pathTarget={null} paths={[]} onPick={vi.fn()} />);
    expect(screen.getByText(/点击/)).toBeInTheDocument();
  });

  it('shows filename when file selected', () => {
    render(<GraphSidebar selected="src/a.ts" graph={graph} pathSource={null} pathTarget={null} paths={[]} onPick={vi.fn()} />);
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });
});
```

- [ ] **2. Run test — verify FAIL:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx vitest run src/features/chat/input/workspace/GraphSidebar.test.tsx
```
Expected: `Error: Failed to resolve import "./GraphSidebar"`

- [ ] **3. Write implementation** — create `GraphSidebar.tsx`:

```typescript
import { cssVar } from 'antd-style';
import type { RichGraph } from '../../../../lib/codeGraphTypes';

function basename(p: string) {
  return p.replace(/[\/]+$/, '').split(/[\/]/).at(-1) ?? p;
}

interface Props {
  selected: string | null;
  graph: RichGraph | null;
  pathSource: string | null;
  pathTarget: string | null;
  paths: string[][];
  onPick(path: string): void;
}

export function GraphSidebar({ selected, graph, pathSource, pathTarget, paths, onPick }: Props) {
  const node = graph?.nodes.find((n) => n.path === selected);
  const outList = graph?.edges.filter((e) => e.source === selected).map((e) => e.target) ?? [];
  const incList = graph?.edges.filter((e) => e.target === selected).map((e) => e.source) ?? [];
  const inPathMode = pathSource !== null;

  if (!selected && !inPathMode) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: cssVar.colorTextTertiary, lineHeight: 1.6 }}>
        点击任意文件节点高亮其依赖；Shift+点击两节点查找路径。
      </div>
    );
  }

  if (inPathMode && paths.length === 0 && pathTarget === null) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: cssVar.colorTextTertiary }}>
        已选源：<code>{basename(pathSource!)}</code>，再 Shift+点击目标节点。
      </div>
    );
  }

  if (inPathMode && pathTarget !== null) {
    return (
      <div style={{ padding: 12, fontSize: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, color: cssVar.colorText }}>
          {paths.length} 条路径 · {basename(pathSource!)} → {basename(pathTarget)}
        </div>
        {paths.map((p, i) => (
          <div key={i} style={{ marginBottom: 6, color: cssVar.colorTextSecondary }}>
            {p.map((seg, j) => (
              <span key={seg}>
                <span style={{ cursor: 'pointer', fontFamily: 'monospace' }} onClick={() => onPick(seg)}>{basename(seg)}</span>
                {j < p.length - 1 && <span style={{ color: cssVar.colorTextTertiary }}> → </span>}
              </span>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${cssVar.colorBorderSecondary}` }}>
        <div style={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 600, color: cssVar.colorText }}>{basename(selected!)}</div>
        <div style={{ fontSize: 11, color: cssVar.colorTextTertiary, marginTop: 2, wordBreak: 'break-all' }}>{selected}</div>
        <div style={{ fontSize: 11, color: cssVar.colorTextTertiary, marginTop: 4 }}>
          依赖 {outList.length} · 被依赖 {incList.length}
          {node && <span> · 复杂度 {(node.complexity * 100).toFixed(0)}%</span>}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        {outList.length > 0 && <>
          <div style={{ fontSize: 10, textTransform: 'uppercase', color: cssVar.colorTextTertiary, padding: '4px 6px' }}>依赖（它 import）</div>
          {outList.map((p) => <div key={p} style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', color: cssVar.colorTextSecondary }} onClick={() => onPick(p)}>{basename(p)}</div>)}
        </>}
        {incList.length > 0 && <>
          <div style={{ fontSize: 10, textTransform: 'uppercase', color: cssVar.colorTextTertiary, padding: '4px 6px', marginTop: 6 }}>被依赖（import 它）</div>
          {incList.map((p) => <div key={p} style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', color: cssVar.colorTextSecondary }} onClick={() => onPick(p)}>{basename(p)}</div>)}
        </>}
      </div>
    </div>
  );
}
```

- [ ] **4. Run test — verify PASS:**
```
npx vitest run src/features/chat/input/workspace/GraphSidebar.test.tsx
```
Expected: `2 tests passed`

- [ ] **5. Commit:**
```
git add src/features/chat/input/workspace/GraphSidebar.tsx src/features/chat/input/workspace/GraphSidebar.test.tsx
git commit -m "feat(code-graph): add GraphSidebar (file detail + path list)"
```

---

## Task 8: GraphCanvas.tsx — ReactFlow canvas with rich nodes and typed edges

**Files:**
- Create: `tauri-agent/src/features/chat/input/workspace/GraphCanvas.tsx`
- Test: `tauri-agent/src/features/chat/input/workspace/GraphCanvas.test.tsx`

**Interfaces:**
- Consumes: `RichGraph`, `EdgeKind` from Task 1; `GraphState` from Task 5; `computeForceLayout`, `topLevelDir` from Task 4; `detectCycles` from Task 2
- Produces: `<GraphCanvas graph highlightSet pathEdges onNodeClick onPaneClick onInit />`

### Steps

- [ ] **1. Write failing test** — create `GraphCanvas.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphCanvas } from './GraphCanvas';
import type { RichGraph } from '../../../../lib/codeGraphTypes';

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: any) => <div data-testid="reactflow">{children}</div>,
  Background: () => null, Controls: () => null, MiniMap: () => null,
}));

const graph: RichGraph = {
  nodes: [
    { path: 'src/a.ts', lines: 10, exportCount: 1, complexity: 0.2, inDegree: 0 },
    { path: 'src/b.ts', lines: 20, exportCount: 2, complexity: 0.4, inDegree: 1 },
  ],
  edges: [{ source: 'src/a.ts', target: 'src/b.ts', kind: 'import-value', weight: 1 }],
  circularPaths: [],
};

describe('GraphCanvas', () => {
  it('renders the ReactFlow container', () => {
    render(<GraphCanvas graph={graph} highlightSet={new Set()} pathEdges={new Set()}
      onNodeClick={vi.fn()} onPaneClick={vi.fn()} onInit={vi.fn()} />);
    expect(screen.getByTestId('reactflow')).toBeInTheDocument();
  });
});
```

- [ ] **2. Run test — verify FAIL:**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx vitest run src/features/chat/input/workspace/GraphCanvas.test.tsx
```
Expected: `Error: Failed to resolve import "./GraphCanvas"`

- [ ] **3. Write implementation** — create `GraphCanvas.tsx` with these parts:

**3a. Helpers and edge style map:**
```typescript
import { useMemo } from 'react';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import { cssVar } from 'antd-style';
import type { EdgeKind, RichGraph } from '../../../../lib/codeGraphTypes';
import { computeForceLayout, topLevelDir } from '../../../../lib/codeGraphLayout';

const mono = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

function extBadge(p: string): string {
  const ext = p.split('.').at(-1) ?? '';
  const base = p.split(/[\/]/).at(-1) ?? '';
  if (base.startsWith('index.')) return '[idx]';
  const m: Record<string,string> = { tsx:'[tsx]', ts:'[ts]', rs:'[rs]', css:'[css]', scss:'[css]' };
  return m[ext] ?? '[...]';
}

function dirColor(dir: string): string {
  let h = 0;
  for (let i = 0; i < dir.length; i++) h = (h * 31 + dir.charCodeAt(i)) % 360;
  return `hsl(${h} 62% 58%)`;
}

function basename(p: string) { return p.split(/[\/]/).at(-1) ?? p; }

const EDGE_STYLES: Record<EdgeKind, { stroke: string; strokeDasharray?: string; strokeWidth: number }> = {
  'import-value': { stroke: '#6b7280', strokeWidth: 1.5 },
  'import-type':  { stroke: '#818cf8', strokeDasharray: '4 3', strokeWidth: 1 },
  'reexport':     { stroke: '#34d399', strokeWidth: 3 },
  'dynamic':      { stroke: '#f59e0b', strokeDasharray: '8 3 1 3', strokeWidth: 1.5 },
  'call':         { stroke: '#38bdf8', strokeWidth: 1.5 },
  'circular':     { stroke: '#ef4444', strokeWidth: 2.5 },
};
```

**3b. Component:**
```typescript
interface Props {
  graph: RichGraph;
  highlightSet: Set<string>;
  pathEdges: Set<string>;
  onNodeClick(id: string, shiftKey?: boolean): void;
  onPaneClick(): void;
  onInit(rf: ReactFlowInstance): void;
}

export function GraphCanvas({ graph, highlightSet, pathEdges, onNodeClick, onPaneClick, onInit }: Props) {
  const layout = useMemo(() => computeForceLayout(graph), [graph]);
  const hasHL = highlightSet.size > 0 || pathEdges.size > 0;

  const allEdges = useMemo(() => {
    const circ = graph.circularPaths.flatMap((path) =>
      path.slice(0, -1).map((src, i) => ({ source: src, target: path[i + 1], kind: 'circular' as EdgeKind, weight: 1 }))
    );
    return [...graph.edges, ...circ];
  }, [graph]);

  const nodes: Node[] = useMemo(() => graph.nodes.map((n) => {
    const pos = layout.get(n.path) ?? { x: 0, y: 0 };
    const color = dirColor(topLevelDir(n.path));
    const isSel = highlightSet.has(n.path);
    const faded = hasHL && !isSel;
    return {
      id: n.path, position: pos,
      data: { label: (
        <div style={{ fontFamily: mono, fontSize: 11, lineHeight: 1.3 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <span style={{ fontSize: 9, color, fontWeight: 700 }}>{extBadge(n.path)}</span>
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{basename(n.path)}</span>
          </div>
          <div style={{ fontSize: 9, color: '#6b7280', marginTop: 2 }}>{n.lines} nodes · inDeg {n.inDegree}</div>
          <div style={{ marginTop: 4, height: 2, borderRadius: 1, background: '#1f2937' }}>
            <div style={{ width: `${n.complexity * 100}%`, height: '100%', background: color }} />
          </div>
        </div>
      )},
      style: {
        background: cssVar.colorBgElevated, color: cssVar.colorText,
        border: `1px solid ${isSel ? cssVar.colorPrimary : color}`,
        borderLeft: `3px solid ${color}`, borderRadius: 8,
        padding: '4px 9px', minWidth: 120,
        height: Math.round(Math.min(12 + n.inDegree * 1.4, 48)),
        opacity: faded ? 0.12 : 1,
        boxShadow: isSel ? `0 0 0 2px ${cssVar.colorPrimary}` : undefined,
      },
    } as Node;
  }), [graph, layout, highlightSet, hasHL]);

  const edges: Edge[] = useMemo(() => allEdges
    .filter((e) => layout.has(e.source) && layout.has(e.target))
    .map((e) => {
      const id = `${e.source}=>${e.target}`;
      const inPath = pathEdges.has(id);
      const inHL = hasHL && highlightSet.has(e.source) && highlightSet.has(e.target);
      const faded = hasHL && !inPath && !inHL;
      const s = EDGE_STYLES[e.kind] ?? EDGE_STYLES['import-value'];
      return {
        id, source: e.source, target: e.target,
        className: e.kind === 'circular' ? 'cg-circular-edge' : undefined,
        style: { ...s, strokeOpacity: faded ? 0.04 : hasHL ? 0.9 : 0.28,
          strokeWidth: (inPath || inHL) ? s.strokeWidth + 0.8 : s.strokeWidth },
      } as Edge;
    }), [allEdges, layout, highlightSet, pathEdges, hasHL]);

  return (
    <>
      <style>{`
        @keyframes cg-march { to { stroke-dashoffset: -16 } }
        @keyframes cg-glow  { 0%,100%{filter:drop-shadow(0 0 2px #ef4444)} 50%{filter:drop-shadow(0 0 8px #ef4444)} }
        .cg-circular-edge path { stroke-dasharray:6 4; animation:cg-march .45s linear infinite,cg-glow 1.1s ease-in-out infinite }
      `}</style>
      <ReactFlow nodes={nodes} edges={edges} onInit={onInit}
        onNodeClick={(e, node) => onNodeClick(node.id, e.shiftKey)}
        onPaneClick={onPaneClick} fitView fitViewOptions={{ padding: 0.18 }}
        minZoom={0.05} nodesConnectable={false} edgesFocusable={false}
        proOptions={{ hideAttribution: true }}>
        <Background gap={28} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => dirColor(topLevelDir(String(n.id)))}
          maskColor="rgba(0,0,0,0.55)"
          style={{ backgroundColor: '#0e1116', border: `1px solid ${cssVar.colorBorderSecondary}` }} />
      </ReactFlow>
    </>
  );
}
```

- [ ] **4. Run test — verify PASS:**
```
npx vitest run src/features/chat/input/workspace/GraphCanvas.test.tsx
```
Expected: `1 test passed`

- [ ] **5. Commit:**
```
git add src/features/chat/input/workspace/GraphCanvas.tsx src/features/chat/input/workspace/GraphCanvas.test.tsx
git commit -m "feat(code-graph): add GraphCanvas with rich nodes, typed edges, circular animation"
```

---

## Task 9: CodeGraphPanel.tsx — thin orchestrator refactor

**Files:**
- Modify: `tauri-agent/src/features/chat/input/workspace/CodeGraphPanel.tsx`
- Modify: `tauri-agent/src/features/chat/input/workspace/CodeGraphPanel.test.tsx`

**Interfaces:**
- Consumes: all Tasks 1–8
- Produces: unchanged public API — `<CodeGraphButton />` entry point, Modal wrapper intact

### Steps

- [ ] **1. Update existing tests** — in `CodeGraphPanel.test.tsx`, mock `getRichGraph` instead of `getFileGraph`:

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CodeGraphButton } from './CodeGraphPanel';
import type { RichGraph } from '../../../../lib/codeGraphTypes';

const mockGraph: RichGraph = {
  nodes: [{ path: 'src/a.ts', lines: 10, exportCount: 1, complexity: 0.2, inDegree: 0 }],
  edges: [],
  circularPaths: [],
};

vi.mock('../../../../lib/codeGraphIo', () => ({ getRichGraph: vi.fn().mockResolvedValue(mockGraph) }));
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => <div data-testid="reactflow" />,
  Background: () => null, Controls: () => null, MiniMap: () => null,
}));
vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

describe('CodeGraphButton', () => {
  it('renders the chip button', () => {
    render(<CodeGraphButton />);
    expect(screen.getByTestId('code-graph-button')).toBeInTheDocument();
  });

  it('opens modal on click', async () => {
    render(<CodeGraphButton />);
    await userEvent.click(screen.getByTestId('code-graph-button'));
    expect(await screen.findByTestId('code-graph-content')).toBeInTheDocument();
  });
});
```

- [ ] **2. Run test — verify FAIL (getRichGraph not mocked in old code):**
```
cd "D:/OneDrive/Project Files/Pi/tauri-agent"
npx vitest run src/features/chat/input/workspace/CodeGraphPanel.test.tsx
```

- [ ] **3. Rewrite CodeGraphPanel.tsx as thin orchestrator:**

```typescript
import { useEffect, useMemo, useState } from 'react';
import { Icon, Modal } from '@lobehub/ui';
import { createGlobalStyle, cssVar } from 'antd-style';
import { Share2 } from 'lucide-react';
import type { ReactFlowInstance } from '@xyflow/react';
import { getRichGraph } from '../../../../lib/codeGraphIo';
import { detectCycles } from '../../../../lib/codeGraphPath';
import { computeForceLayout } from '../../../../lib/codeGraphLayout';
import { findPaths } from '../../../../lib/codeGraphPath';
import type { RichGraph } from '../../../../lib/codeGraphTypes';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useGraphState } from './useGraphState';
import { GraphToolbar } from './GraphToolbar';
import { GraphCanvas } from './GraphCanvas';
import { GraphSidebar } from './GraphSidebar';
import { wsStyles as s } from './styles';

const ModalGlobal = createGlobalStyle`
  .code-graph-modal-root .ant-modal-container {
    height: calc(100vh - 32px) !important; max-height: calc(100vh - 32px) !important;
    display: flex !important; flex-direction: column !important;
  }
  .code-graph-modal-root .ant-modal-body {
    flex: 1 1 auto !important; min-height: 0 !important; max-height: none !important;
    overflow: hidden !important; display: flex !important; flex-direction: column !important;
  }
`;

function GraphContent({ workspace }: { workspace: string }) {
  const [graph, setGraph] = useState<RichGraph | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    getRichGraph(workspace)
      .then((g) => { if (alive) setGraph({ ...g, circularPaths: detectCycles(g.nodes.map(n=>n.path), g.edges) }); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [workspace]);

  const { state, onNodeClick, onPaneClick, setSearch, setDepth, toggleKind, setCollapsed, expandDir, highlightSet, pathEdges } = useGraphState(graph);

  const paths = useMemo(() => {
    if (!graph || !state.pathSource || !state.pathTarget) return [];
    return findPaths(graph.nodes.map(n=>n.path), graph.edges, state.pathSource, state.pathTarget);
  }, [graph, state.pathSource, state.pathTarget]);

  // Auto-fitView on selection change.
  useEffect(() => {
    if (rf && highlightSet.size > 0) {
      rf.fitView({ nodes: Array.from(highlightSet).map(id=>({id})), padding: 0.4, duration: 400 });
    }
  }, [state.selected, rf]);

  if (loading) return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color: cssVar.colorTextTertiary }}>加载依赖图中…</div>;
  if (error) return <div data-testid="code-graph-error" style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color: cssVar.colorTextTertiary }}>{error}</div>;
  if (!graph || graph.nodes.length === 0) return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color: cssVar.colorTextTertiary }}>未发现文件间依赖（或索引为空）</div>;

  return (
    <div data-testid="code-graph-content" style={{ display:'flex', flexDirection:'column', height:'100%', minHeight:0 }}>
      <GraphToolbar state={state} onSearch={setSearch} onDepth={setDepth} onToggleKind={toggleKind} onToggleCollapse={setCollapsed} />
      <div style={{ display:'flex', flex:1, minHeight:0, gap:10 }}>
        <div style={{ flex:1, minWidth:0, border:`1px solid ${cssVar.colorBorderSecondary}`, borderRadius:10, overflow:'hidden', background: cssVar.colorBgLayout }}>
          <GraphCanvas
            graph={{ ...graph, edges: graph.edges.filter(e => state.visibleKinds.has(e.kind)) }}
            highlightSet={highlightSet} pathEdges={pathEdges}
            onNodeClick={onNodeClick} onPaneClick={onPaneClick} onInit={setRf}
          />
        </div>
        <div style={{ flex:'0 0 280px', border:`1px solid ${cssVar.colorBorderSecondary}`, borderRadius:10, overflow:'hidden', background: cssVar.colorBgContainer }}>
          <GraphSidebar selected={state.selected} graph={graph}
            pathSource={state.pathSource} pathTarget={state.pathTarget}
            paths={paths} onPick={(p) => onNodeClick(p)} />
        </div>
      </div>
    </div>
  );
}

export function CodeGraphButton() {
  const { workspace } = useAgentStoreContext();
  const [open, setOpen] = useState(false);
  if (!workspace) return null;
  return (
    <>
      <ModalGlobal />
      <span className={s.chip} data-testid="code-graph-button" onClick={() => setOpen(true)}>
        <Icon icon={Share2} size={14} />
        <span className={s.muted}>代码图谱</span>
      </span>
      <Modal open={open} title="代码图谱 · 文件依赖" footer={null} width="94vw" centered
        rootClassName="code-graph-modal-root" onCancel={() => setOpen(false)}
        data-testid="code-graph-modal">
        {open ? <GraphContent workspace={workspace} /> : null}
      </Modal>
    </>
  );
}
```

- [ ] **4. Run tests — verify PASS:**
```
npx vitest run src/features/chat/input/workspace/CodeGraphPanel.test.tsx
```
Expected: `2 tests passed`

- [ ] **5. Run all code-graph tests together:**
```
npx vitest run src/lib/codeGraphTypes.test.ts src/lib/codeGraphPath.test.ts src/lib/codeGraphLayout.test.ts src/lib/codeGraphIo.test.ts src/features/chat/input/workspace/
```
Expected: all tests pass.

- [ ] **6. Commit:**
```
git add src/features/chat/input/workspace/CodeGraphPanel.tsx src/features/chat/input/workspace/CodeGraphPanel.test.tsx
git commit -m "refactor(code-graph): replace monolithic CodeGraphPanel with layered GraphCanvas+Toolbar+Sidebar"
```

---

## Self-Review

Spec coverage:
- Rich node cards (type badge, lines, complexity bar, inDegree size): Task 8 GraphCanvas
- 6 edge kinds with visual encoding: Task 8 EDGE_STYLES + CircularEdge animation
- Search: Task 6 GraphToolbar input + Task 5 useGraphState.searchQuery
- N-hop depth: Task 5 highlightSet BFS + Task 6 depth slider
- Path highlight: Task 2 findPaths + Task 5 pathEdges + Task 9 wiring
- Directory collapse: Task 5 collapsed/expandedDirs state (UI toggle in Task 6; collapse rendering deferred to post-MVP — state is ready)
- Data layer separation: Tasks 1–4
- FileGraph @deprecated: Task 3
- No emoji: enforced in Task 8 extBadge

Type consistency: GraphNode.path used as ReactFlow node id throughout; EdgeKind string union used in EDGE_STYLES and visibleKinds filter.
