import { describe, expect, it } from 'vitest';
import { detectCycles, findPaths } from './codeGraphPath';
describe('code graph paths', () => { const nodes = ['a', 'b', 'c']; const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' }]; it('finds bounded simple paths', () => expect(findPaths(nodes, edges, 'a', 'c')).toEqual([['a', 'b', 'c']])); it('detects cycles', () => expect(detectCycles(nodes, edges)).toEqual([['a', 'b', 'c', 'a']])); });
