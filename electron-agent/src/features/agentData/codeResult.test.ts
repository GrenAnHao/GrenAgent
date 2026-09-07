import { describe, expect, it } from 'vitest';
import { decodeCodeResult } from './codeResult';

describe('decodeCodeResult', () => {
  it('reads SDK schema rows without losing node identity or symbols', () => {
    const row = { id: 'function:parse', file: 'src/parser.ts', line: 3, endLine: 7, symbol: 'parse', kind: 'function', snippet: '(input: string)' };
    const raw = { content: [{ type: 'text', text: '**parse**\nsrc/parser.ts:3' }], isError: false,
      structuredContent: { schemaVersion: 1, rows: [row], nodes: [], edges: [] } };
    expect(decodeCodeResult('codegraph_search', raw)).toMatchObject({ recognition: 'rows', rows: [row], isError: false });
  });
  it('prefers structured rows, keeps raw and does not invent missing locations', () => {
    const raw = { structuredContent: [{ path: 'src/a.ts', name: 'parse' }, { symbol: 'onlySymbol', line: 0 }], content: [{ type: 'text', text: '[{"file":"ignored.ts","line":9}]' }] };
    const view = decodeCodeResult('codegraph_search', raw);
    expect(view.raw).toBe(raw);
    expect(view.recognition).toBe('rows');
    expect(view.rows).toEqual([{ file: 'src/a.ts', symbol: 'parse' }, { symbol: 'onlySymbol' }]);
  });

  it('joins text blocks and recognizes JSON arrays without requiring structuredContent', () => {
    const raw = { content: [{ type: 'text', text: '[{"file":"src/a.ts",' }, { type: 'image', data: 'ignored' }, { type: 'text', text: '"line":3,"snippet":"return true"}]' }] };
    expect(decodeCodeResult('codegraph_search', raw)).toMatchObject({ recognition: 'rows', isError: false, rows: [{ file: 'src/a.ts', line: 3, snippet: 'return true' }] });
  });

  it.each([undefined, 0, -1, 1.5, '2', NaN])('does not manufacture a valid line from %s', (line) => {
    expect(decodeCodeResult('codegraph_search', { structuredContent: [{ file: 'a.ts', line }] }).rows[0].line).toBeUndefined();
  });

  it('recognizes an actual empty array, but not an invalid array as an empty result', () => {
    expect(decodeCodeResult('codegraph_files', { content: [{ type: 'text', text: '[]' }] })).toMatchObject({ recognition: 'rows', rows: [] });
    const invalid = { structuredContent: [null, 7, { nodes: [] }], content: [{ type: 'text', text: '[null,7,{"nodes":[]}]' }] };
    expect(decodeCodeResult('codegraph_search', invalid)).toMatchObject({ recognition: 'text', text: '[null,7,{"nodes":[]}]', raw: invalid });
  });

  it('retains a mixed array without pretending omitted entries were valid rows', () => {
    const raw = { structuredContent: [{ file: 'a.ts' }, { nodes: ['x'] }] };
    const view = decodeCodeResult('codegraph_search', raw);
    expect(view.raw).toBe(raw);
    expect(view.rows).toEqual([{ file: 'a.ts' }]);
    expect(view.message).toMatch(/未识别/);
  });

  it('keeps unknown objects and readable text without guessing graph schemas', () => {
    const raw = { structuredContent: { nodes: [{ file: 'a.ts' }], edges: [] } };
    expect(decodeCodeResult('codegraph_explore', raw)).toMatchObject({ raw, recognition: 'unknown', rows: [] });
    expect(decodeCodeResult('codegraph_node', { content: [{ type: 'text', text: 'A readable explanation' }] })).toMatchObject({ recognition: 'text', text: 'A readable explanation' });
  });

  it('does not mistake human-readable relation labels for filesystem paths', () => {
    const text = '- main (function) - src/main.ts:10';
    expect(decodeCodeResult('codegraph_callers', { content: [{ type: 'text', text }] })).toMatchObject({ recognition: 'text', rows: [], text });
  });

  it('does not turn an overflowing text line number into Infinity', () => {
    const text = `src/a.ts:${'9'.repeat(400)}: parse`;
    expect(decodeCodeResult('codegraph_search', { content: [{ type: 'text', text }] })).toMatchObject({ recognition: 'text', rows: [], text });
  });

  it('retains an explicit MCP error even when it has recognizable rows', () => {
    const raw = { isError: true, structuredContent: [{ file: 'a.ts', line: 2 }], content: [{ type: 'text', text: 'partial results; connection lost' }] };
    expect(decodeCodeResult('codegraph_callers', raw)).toMatchObject({ isError: true, recognition: 'rows', rows: [{ file: 'a.ts', line: 2 }], raw });
  });
});
