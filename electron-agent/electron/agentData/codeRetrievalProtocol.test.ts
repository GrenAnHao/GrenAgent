import { describe, expect, it } from 'vitest';
import { readCodeRetrievalTool, validateCodeRetrievalArgs } from './codeRetrievalProtocol';

describe('CodeGraph read-only RPC validation', () => {
  it.each(['search', 'explore', 'callers', 'callees', 'impact', 'node', 'files'])('accepts codegraph_%s', (name) => {
    expect(readCodeRetrievalTool(`codegraph_${name}`)).toBe(`codegraph_${name}`);
  });

  it.each(['codegraph_sync', 'codegraph_init', 'codegraph_status', '', null])('rejects unsupported tool %s', (name) => {
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

  it.each([
    ['codegraph_search', null], ['codegraph_search', []], ['codegraph_search', {}],
    ['codegraph_search', { query: 'parse', command: 'sync' }], ['codegraph_node', {}],
    ['codegraph_node', { file: 'src/a.ts', includeCode: 'yes' }],
    ['codegraph_search', { query: 'parse', limit: Infinity }],
    ['codegraph_files', { path: '../other' }], ['codegraph_files', { pattern: '../*' }],
    ['codegraph_files', { format: ['flat'] }], ['codegraph_search', { query: 'parse', kind: ['class'] }],
  ])('rejects malformed %s arguments', (tool, args) => {
    expect(() => validateCodeRetrievalArgs('/repo', readCodeRetrievalTool(tool), args)).toThrow();
  });
});
