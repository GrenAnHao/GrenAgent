import { describe, expect, it } from 'vitest';
import { computeForceLayout, topLevelDir } from './codeGraphLayout';
describe('code graph layout', () => { it('groups by top-level directory and returns stable positions', () => { expect(topLevelDir('src/a.ts')).toBe('src'); const graph = { nodes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }], edges: [{ source: 'src/a.ts', target: 'src/b.ts' }] }; expect(computeForceLayout(graph, { iterations: 2 })).toEqual(computeForceLayout(graph, { iterations: 2 })); }); });
