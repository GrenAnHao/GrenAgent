type Edge = { source: string; target: string };

const MAX_PATH_DEPTH = 10;

function buildAdj(nodes: string[], edges: Edge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);
  return adj;
}

/** BFS: all simple paths from src to dst with depth <= MAX_PATH_DEPTH. */
export function findPaths(nodes: string[], edges: Edge[], src: string, dst: string): string[][] {
  const adj = buildAdj(nodes, edges);
  const results: string[][] = [];
  const queue: { path: string[]; visited: Set<string> }[] = [{ path: [src], visited: new Set([src]) }];
  while (queue.length > 0) {
    const { path, visited } = queue.shift()!;
    if (path.length >= MAX_PATH_DEPTH) continue;
    const cur = path[path.length - 1];
    for (const next of adj.get(cur) ?? []) {
      if (next === dst && !visited.has(next)) {
        results.push([...path, dst]);
      } else if (!visited.has(next)) {
        queue.push({ path: [...path, next], visited: new Set([...visited, next]) });
      }
    }
  }
  return results;
}

/** DFS-based cycle detection. Returns each cycle as an array ending with the repeated node. */
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
