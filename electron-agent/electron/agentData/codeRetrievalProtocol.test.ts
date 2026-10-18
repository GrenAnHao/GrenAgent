import { EDGE_KINDS, LANGUAGES, NODE_KINDS } from '@colbymchenry/codegraph';
import { describe, expect, it } from 'vitest';
import {
  CODEGRAPH_EDGE_KINDS,
  CODEGRAPH_LANGUAGES,
  CODEGRAPH_NODE_KINDS,
  CODE_RETRIEVAL_TOOLS,
  readCodeRetrievalTool,
  validateCodeRetrievalArgs,
} from './codeRetrievalProtocol';

const READ_TOOLS = [
  'search', 'explore', 'callers', 'callees', 'impact', 'node', 'files',
  'status', 'usages', 'path', 'hierarchy', 'call_graph', 'deps', 'cycles',
  'dead_code', 'metrics', 'routes', 'traverse', 'context', 'changed',
] as const;

describe('CodeGraph read-only RPC validation', () => {
  it('mirrors SDK 1.6.2 kind, edge and language enums', () => {
    expect(CODEGRAPH_NODE_KINDS).toEqual([...NODE_KINDS]);
    expect(CODEGRAPH_EDGE_KINDS).toEqual([...EDGE_KINDS]);
    expect(CODEGRAPH_LANGUAGES).toEqual([...LANGUAGES]);
  });

  it.each(READ_TOOLS)('accepts codegraph_%s', (name) => {
    expect(readCodeRetrievalTool(`codegraph_${name}`)).toBe(`codegraph_${name}`);
  });

  it('exposes every read tool in the catalog', () => {
    expect(CODE_RETRIEVAL_TOOLS).toEqual(READ_TOOLS.map((name) => `codegraph_${name}`));
  });

  it.each(['codegraph_sync', 'codegraph_init', 'codegraph_watch', 'codegraph_clear', '', null])('rejects unsupported tool %s', (name) => {
    expect(() => readCodeRetrievalTool(name)).toThrow(/tool/i);
  });

  it('fixes projectPath to the workspace and preserves raw tool arguments', () => {
    const args = { query: 'parse', projectPath: '/repo/', limit: 5 };
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_search', args)).toEqual({ query: 'parse', limit: 5 });
    expect(args.projectPath).toBe('/repo/');
    expect(() => validateCodeRetrievalArgs('/repo', 'codegraph_search', { query: 'parse', projectPath: '/other' })).toThrow(/projectPath/);
  });

  it.each(['../outside.ts', '..\\outside.ts', '/other/file.ts', 'C:\\other\\file.ts', 'C:outside.ts', 'file\0.ts', '  ../outside.ts', ' /other/file.ts '])('rejects a file escaping the workspace: %s', (file) => {
    expect(() => validateCodeRetrievalArgs('/repo', 'codegraph_node', { file })).toThrow(/file/);
  });

  it('preserves file mode, symbol disambiguation and file-tree filters', () => {
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_node', { file: 'src/parser.ts', offset: 2, limit: 2000, symbolsOnly: true })).toEqual({ file: 'src/parser.ts', offset: 2, limit: 2000, symbolsOnly: true });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_callers', { symbol: 'parse', file: '/repo/src/parser.ts', limit: 5 })).toEqual({ symbol: 'parse', file: '/repo/src/parser.ts', limit: 5 });
    expect(validateCodeRetrievalArgs('C:\\repo', 'codegraph_node', { file: 'c:\\repo\\src\\parser.ts' })).toEqual({ file: 'c:\\repo\\src\\parser.ts' });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_files', { path: 'src', pattern: '**/*.test.ts', format: 'flat' })).toEqual({ path: 'src', pattern: '**/*.test.ts', format: 'flat' });
  });

  it('lets the file listing be read one page at a time', () => {
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_files', { format: 'flat', limit: 100, offset: 200 })).toEqual({ format: 'flat', limit: 100, offset: 200 });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_files', { offset: 0 })).toEqual({ offset: 0 });
  });

  it('accepts every SearchOptions field plus lookup modes', () => {
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_search', {
      query: 'parse',
      kind: 'type',
      kinds: ['function', 'route', 'component'],
      languages: ['typescript', 'tsx'],
      includePatterns: ['src/**'],
      excludePatterns: ['**/*.test.ts'],
      limit: 10,
      offset: 0,
      caseSensitive: true,
      mode: 'search',
      excludePrefix: false,
      words: ['parse', 'main'],
    })).toEqual({
      query: 'parse',
      kind: 'type',
      kinds: ['function', 'route', 'component'],
      languages: ['typescript', 'tsx'],
      includePatterns: ['src/**'],
      excludePatterns: ['**/*.test.ts'],
      limit: 10,
      offset: 0,
      caseSensitive: true,
      mode: 'search',
      excludePrefix: false,
      words: ['parse', 'main'],
    });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_search', { mode: 'kind', kinds: ['class'] })).toEqual({ mode: 'kind', kinds: ['class'] });
  });

  it('accepts every FindRelevantContextOptions field', () => {
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_explore', {
      query: 'parse main',
      maxFiles: 8,
      limit: 20,
      searchLimit: 6,
      traversalDepth: 3,
      maxNodes: 40,
      minScore: 0.3,
      edgeKinds: ['calls', 'imports'],
      nodeKinds: ['function', 'method'],
      seedNames: ['parse', 'main'],
    })).toMatchObject({
      query: 'parse main',
      searchLimit: 6,
      traversalDepth: 3,
      maxNodes: 40,
      minScore: 0.3,
      edgeKinds: ['calls', 'imports'],
      nodeKinds: ['function', 'method'],
      seedNames: ['parse', 'main'],
    });
  });

  it('accepts full analysis-tool arguments', () => {
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_status', {})).toEqual({});
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_changed', {})).toEqual({});
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_usages', { symbol: 'parse', file: 'src/parser.ts', limit: 20 })).toEqual({ symbol: 'parse', file: 'src/parser.ts', limit: 20 });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_path', { from: 'main', to: 'parse', fromFile: 'src/main.ts', toFile: 'src/parser.ts', edgeKinds: ['calls'] })).toEqual({
      from: 'main', to: 'parse', fromFile: 'src/main.ts', toFile: 'src/parser.ts', edgeKinds: ['calls'],
    });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_hierarchy', { symbol: 'Parser' })).toEqual({ symbol: 'Parser' });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_call_graph', { symbol: 'main', depth: 2 })).toEqual({ symbol: 'main', depth: 2 });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_deps', { file: 'src/main.ts', direction: 'both' })).toEqual({ file: 'src/main.ts', direction: 'both' });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_cycles', { limit: 10 })).toEqual({ limit: 10 });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_dead_code', { kinds: ['function', 'class'], limit: 50 })).toEqual({ kinds: ['function', 'class'], limit: 50 });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_metrics', { symbol: 'parse' })).toEqual({ symbol: 'parse' });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_routes', { limit: 20 })).toEqual({ limit: 20 });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_traverse', {
      symbol: 'parse', file: 'src/parser.ts', maxDepth: 3, depth: 2, edgeKinds: ['calls'], nodeKinds: ['function'],
      direction: 'outgoing', limit: 30, includeStart: true,
    })).toMatchObject({ symbol: 'parse', direction: 'outgoing', includeStart: true, maxDepth: 3 });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_context', {
      title: 'Find parse', description: 'entry', query: 'parse',
      maxNodes: 20, maxCodeBlocks: 4, maxCodeBlockSize: 800, includeCode: true,
      format: 'markdown', searchLimit: 5, traversalDepth: 2, minScore: 0.2,
    })).toMatchObject({ title: 'Find parse', format: 'markdown', maxCodeBlocks: 4 });
    expect(validateCodeRetrievalArgs('/repo', 'codegraph_node', { symbol: 'parse', includeMetrics: true })).toEqual({ symbol: 'parse', includeMetrics: true });
  });

  it.each([
    ['codegraph_search', null], ['codegraph_search', []], ['codegraph_search', {}],
    ['codegraph_search', { query: 'parse', command: 'sync' }], ['codegraph_node', {}],
    ['codegraph_node', { file: 'src/a.ts', includeCode: 'yes' }],
    ['codegraph_search', { query: 'parse', limit: Infinity }],
    ['codegraph_files', { path: '../other' }], ['codegraph_files', { pattern: '../*' }],
    ['codegraph_files', { format: ['flat'] }], ['codegraph_files', { limit: 0 }], ['codegraph_files', { offset: -1 }],
    ['codegraph_search', { query: 'parse', kind: ['class'] }],
    ['codegraph_search', { query: 'parse', kinds: ['not-a-kind'] }],
    ['codegraph_search', { query: 'parse', languages: ['not-a-lang'] }],
    ['codegraph_search', { query: 'parse', mode: 'fts' }],
    ['codegraph_search', { query: 'parse', includePatterns: ['../secret'] }],
    ['codegraph_explore', { query: 'parse', edgeKinds: ['calls', 'nope'] }],
    ['codegraph_explore', { query: 'parse', minScore: 2 }],
    ['codegraph_path', { from: 'main' }],
    ['codegraph_deps', {}],
    ['codegraph_deps', { file: 'src/main.ts', direction: 'inbound' }],
    ['codegraph_traverse', { symbol: 'parse', direction: 'dependencies' }],
    ['codegraph_context', {}],
    ['codegraph_context', { query: 'parse', format: 'flat' }],
    ['codegraph_status', { command: 'sync' }],
  ])('rejects malformed %s arguments', (tool, args) => {
    expect(() => validateCodeRetrievalArgs('/repo', readCodeRetrievalTool(tool), args)).toThrow();
  });
});
