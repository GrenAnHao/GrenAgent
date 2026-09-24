import { describe, expect, it } from 'vitest';
import { parseCodeSearch, parseGlobOutput, parseGrepOutput } from './searchResults';

describe('parseGrepOutput', () => {
  it('parses grouped matches with total', () => {
    const text = [
      'Found 3 matches',
      '/proj/a.ts:',
      '  Line 12: const foo = 1',
      '  Line 30: foo()',
      '',
      '/proj/b.ts:',
      '  Line 5: import foo',
    ].join('\n');
    const r = parseGrepOutput(text);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.files).toHaveLength(2);
    expect(r.files[0]).toEqual({
      path: '/proj/a.ts',
      matches: [
        { line: 12, text: 'const foo = 1' },
        { line: 30, text: 'foo()' },
      ],
    });
    expect(r.files[1].matches).toEqual([{ line: 5, text: 'import foo' }]);
  });

  it('handles windows paths and truncation note', () => {
    const text = [
      'Found 120 matches (showing first 100)',
      'C:\\proj\\x.ts:',
      '  Line 1: hit',
      '(Results truncated: showing 100 of 120 matches)',
    ].join('\n');
    const r = parseGrepOutput(text);
    expect(r.total).toBe(120);
    expect(r.truncated).toBe(true);
    expect(r.files[0].path).toBe('C:\\proj\\x.ts');
  });

  it('returns empty for No files found', () => {
    const r = parseGrepOutput('No files found');
    expect(r.total).toBe(0);
    expect(r.files).toHaveLength(0);
  });
});

describe('parseCodeSearch', () => {
  it('按文件分组 details.matches，并带上总数与截断', () => {
    const view = parseCodeSearch('ignored when details exist', {
      matches: [
        { file: 'src/a.ts', line: 12, text: 'export function PddWorkbench' },
        { file: 'src/b.ts', line: 4, text: '跑通' },
        { file: 'src/a.ts', line: 20, text: 'return ok' },
      ],
      total: 3,
      files: 2,
      capped: true,
    });
    expect(view.error).toBeUndefined();
    expect(view.total).toBe(3);
    expect(view.capped).toBe(true);
    expect(view.files).toEqual([
      {
        path: 'src/a.ts',
        matches: [
          { line: 12, text: 'export function PddWorkbench' },
          { line: 20, text: 'return ok' },
        ],
      },
      { path: 'src/b.ts', matches: [{ line: 4, text: '跑通' }] },
    ]);
  });

  it('没有命中时不把 No matches 当成错误', () => {
    const view = parseCodeSearch('No matches.', {
      matches: [],
      total: 0,
      files: 0,
      capped: false,
    });
    expect(view.files).toEqual([]);
    expect(view.total).toBe(0);
    expect(view.error).toBeUndefined();
  });

  it('工具失败时保留原文，而不是当成空命中', () => {
    const view = parseCodeSearch('search: no valid patterns.', {
      matches: [],
      total: 0,
      files: 0,
      capped: false,
    });
    expect(view.files).toEqual([]);
    expect(view.error).toBe('search: no valid patterns.');
  });

  it('没有 details 时解析 search 的文本输出', () => {
    const text = [
      'src/a.ts',
      '  12: export function PddWorkbench',
      '  13- context line',
      'src/b.ts',
      '  4: 跑通',
      '(2 matches in 2 files; capped at 250)',
    ].join('\n');
    const view = parseCodeSearch(text);
    expect(view.capped).toBe(true);
    expect(view.total).toBe(2);
    expect(view.files[0].matches).toEqual([{ line: 12, text: 'export function PddWorkbench' }]);
    expect(view.files[1].matches).toEqual([{ line: 4, text: '跑通' }]);
  });
});

describe('parseGlobOutput', () => {
  it('collects file paths and detects truncation', () => {
    const text = ['/proj/a.ts', '/proj/b.tsx', '', '(Results are truncated: showing first 100 results.)'].join('\n');
    const r = parseGlobOutput(text);
    expect(r.files).toEqual(['/proj/a.ts', '/proj/b.tsx']);
    expect(r.truncated).toBe(true);
  });

  it('returns empty for No files found', () => {
    expect(parseGlobOutput('No files found')).toEqual({ files: [], truncated: false });
  });
});
