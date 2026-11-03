import type { StageGraph, StageNode } from './pipeline';

/** Select only work whose prerequisites are already durably acknowledged. */
export function selectDispatchableItems(graph: StageGraph, activeIds: ReadonlySet<string>, failedIds: ReadonlySet<string>, policy: { catalogueConcurrency: number; pageConcurrency: number }): StageNode[] {
  const done = new Set(graph.completed);
  const waiting = graph.nodes.filter(node => !done.has(node.id) && !failedIds.has(node.id));
  const ready = waiting.filter(node => !activeIds.has(node.id) && node.deps.every(id => done.has(id)));
  const active = graph.nodes.filter(node => activeIds.has(node.id));
  const phase = active[0]?.phase ?? ready[0]?.phase;
  if (!phase) return [];
  const same = ready.filter(node => node.phase === phase);
  if (phase === 'catalogue') {
    const depths = waiting.filter(node => node.phase === phase && (activeIds.has(node.id) || node.deps.every(id => done.has(id)))).map(node => node.depth ?? 0);
    const depth = Math.min(...depths);
    return same.filter(node => (node.depth ?? 0) === depth).slice(0, Math.max(0, policy.catalogueConcurrency - active.length));
  }
  if (phase === 'generate') return same.slice(0, Math.max(0, policy.pageConcurrency - active.length));
  return active.length ? [] : same.slice(0, 1);
}
