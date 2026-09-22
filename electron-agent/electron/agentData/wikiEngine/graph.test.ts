import { describe, expect, it } from 'vitest';
import { createWikiGraph, graphMultiHopSearch } from './graph';

describe('wiki graph', () => {
  it('keeps seeds at hop 0 and decays neighbors', () => {
    const graph = createWikiGraph(
      [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
    );
    const hits = graphMultiHopSearch(graph, [{ id: 'a', score: 1 }], { hop: 2, decay: 0.5, minScore: 0.1 });
    expect(hits.find((hit) => hit.id === 'a')).toMatchObject({ hop: 0, score: 1 });
    expect(hits.find((hit) => hit.id === 'b')).toMatchObject({ hop: 1, score: 0.5, via: 'A' });
    expect(hits.find((hit) => hit.id === 'c')).toMatchObject({ hop: 2, score: 0.25 });
  });

  it('does not expand when hop is 0', () => {
    const graph = createWikiGraph(
      [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      [{ source: 'a', target: 'b' }],
    );
    expect(graphMultiHopSearch(graph, [{ id: 'a', score: 1 }], { hop: 0, decay: 0.5, minScore: 0.1 }).map((hit) => hit.id)).toEqual(['a']);
  });
});
