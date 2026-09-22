// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).

export interface WikiGraph {
  hasNode(id: string): boolean;
  neighbors(id: string): string[];
  getNodeAttribute(id: string, key: 'label'): string | undefined;
}

export interface GraphMultiHopHit {
  id: string;
  score: number;
  hop: number;
  via?: string;
}

export function createWikiGraph(
  nodes: Array<{ id: string; label?: string }>,
  edges: Array<{ source: string; target: string }>,
): WikiGraph {
  const labels = new Map<string, string | undefined>();
  const adj = new Map<string, Set<string>>();

  for (const node of nodes) {
    labels.set(node.id, node.label);
    adj.set(node.id, new Set());
  }

  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!labels.has(edge.source) || !labels.has(edge.target)) continue;
    adj.get(edge.source)!.add(edge.target);
    adj.get(edge.target)!.add(edge.source);
  }

  return {
    hasNode(id: string): boolean {
      return labels.has(id);
    },
    neighbors(id: string): string[] {
      const set = adj.get(id);
      return set ? [...set] : [];
    },
    getNodeAttribute(id: string, key: 'label'): string | undefined {
      if (key !== 'label') return undefined;
      return labels.get(id);
    },
  };
}

export function graphMultiHopSearch(
  graph: WikiGraph,
  seeds: Array<{ id: string; score: number }>,
  opts: { hop: number; decay: number; minScore: number; maxNodes?: number },
): GraphMultiHopHit[] {
  const maxNodes = opts.maxNodes ?? 200;
  const seedIds = new Set<string>();
  const results = new Map<string, GraphMultiHopHit>();

  for (const seed of seeds) {
    if (!graph.hasNode(seed.id)) continue;
    seedIds.add(seed.id);
    const existing = results.get(seed.id);
    if (!existing || seed.score > existing.score) {
      results.set(seed.id, { id: seed.id, score: seed.score, hop: 0 });
    }
  }

  if (opts.hop > 0 && results.size > 0) {
    let frontier = [...results.keys()];

    for (let depth = 0; depth < opts.hop; depth++) {
      if (results.size >= maxNodes) break;
      const nextFrontier: string[] = [];

      for (const currentId of frontier) {
        if (results.size >= maxNodes) break;
        const current = results.get(currentId)!;
        const nextScore = current.score * opts.decay;
        if (nextScore < opts.minScore) continue;

        const via = graph.getNodeAttribute(currentId, 'label') ?? currentId;

        for (const neighborId of graph.neighbors(currentId)) {
          if (results.size >= maxNodes) break;
          if (seedIds.has(neighborId)) continue;

          const existing = results.get(neighborId);
          if (existing) {
            if (existing.score >= nextScore) continue;
            results.set(neighborId, { ...existing, score: nextScore, via });
            continue;
          }

          results.set(neighborId, {
            id: neighborId,
            score: nextScore,
            hop: depth + 1,
            via,
          });
          nextFrontier.push(neighborId);
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
  }

  return [...results.values()]
    .filter((hit) => hit.score >= opts.minScore)
    .sort((a, b) => b.score - a.score);
}
