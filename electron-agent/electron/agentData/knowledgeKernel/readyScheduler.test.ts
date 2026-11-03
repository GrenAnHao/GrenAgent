import { describe, expect, it } from 'vitest';
import type { StageGraph, StageNode } from './pipeline';
import { selectDispatchableItems } from './readyScheduler';
const n = (id: string, deps: string[] = [], phase: StageNode['phase'] = 'generate', depth?: number): StageNode => ({ id, phase, kind: phase === 'generate' ? 'page' : phase, deps, inputHash: id, depth });
const graph = (nodes: StageNode[], completed: string[] = []): StageGraph => ({ domain: 'wiki', inputHash: 'x', nodes, completed, total: null, definitions: [], expanded: [], leaves: [], outputHashes: {} });
const policy = { catalogueConcurrency: 3, pageConcurrency: 3 };
describe('ready scheduler', () => {
  it('fills an open slot immediately and waits for persisted dependencies', () => {
    const g = graph([n('a'), n('b'), n('c'), n('d', ['a']), n('e')]);
    expect(selectDispatchableItems(g, new Set(), new Set(), policy).map(x => x.id)).toEqual(['a','b','c']);
    g.completed.push('c');
    expect(selectDispatchableItems(g, new Set(['a','b']), new Set(), policy).map(x => x.id)).toEqual(['e']);
    g.completed.push('a');
    expect(selectDispatchableItems(g, new Set(['b','e']), new Set(), policy).map(x => x.id)).toEqual(['d']);
  });
  it('holds deeper catalogue work until all shallower in-flight work finishes', () => {
    const g = graph([n('p', [], 'catalogue', 1), n('q', [], 'catalogue', 1), n('child', ['p'], 'catalogue', 2)], ['p']);
    expect(selectDispatchableItems(g, new Set(['q']), new Set(), policy)).toEqual([]);
    g.completed.push('q'); expect(selectDispatchableItems(g, new Set(), new Set(), policy).map(x=>x.id)).toEqual(['child']);
  });
  it('a failed dependency blocks only descendants', () => {
    const g = graph([n('a'), n('b'), n('d',['a'])]);
    expect(selectDispatchableItems(g, new Set(), new Set(['a']), policy).map(x=>x.id)).toEqual(['b']);
  });
});
