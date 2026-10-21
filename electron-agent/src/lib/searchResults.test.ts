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

  // pi 1.3.0 内置 grep（core/tools/grep.js）：匹配行 `path:N: text`，上下文行 `path-N- text`，提示放在末尾方括号里。
  it('parses pi grep lines grouped by file', () => {
    const text = [
      'features/agentData/AgentDataCenter.tsx:7: import { CodeRetrievalPanel } from \'./CodeRetrievalPanel\';',
      'features/agentData/AgentDataCenter.tsx:107: return <CodeRetrievalPanel />',
      'features/agentData/CodeRetrievalPanel.tsx:39: export function CodeRetrievalPanel() {',
    ].join('\n');
    const r = parseGrepOutput(text);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.files).toEqual([
      {
        path: 'features/agentData/AgentDataCenter.tsx',
        matches: [
          { line: 7, text: "import { CodeRetrievalPanel } from './CodeRetrievalPanel';" },
          { line: 107, text: 'return <CodeRetrievalPanel />' },
        ],
      },
      { path: 'features/agentData/CodeRetrievalPanel.tsx', matches: [{ line: 39, text: 'export function CodeRetrievalPanel() {' }] },
    ]);
  });

  it('keeps pi context lines but counts only matches', () => {
    const text = [
      'ui-harness/probes/code-index-sync.mjs-13- // 注释',
      'ui-harness/probes/code-index-sync.mjs:14: const PANEL = \'x\'',
      'ui-harness/probes/code-index-sync.mjs-15- ',
    ].join('\n');
    const r = parseGrepOutput(text);
    expect(r.total).toBe(1);
    expect(r.files).toEqual([
      {
        path: 'ui-harness/probes/code-index-sync.mjs',
        matches: [
          { line: 13, text: '// 注释', context: true },
          { line: 14, text: "const PANEL = 'x'" },
          { line: 15, text: '', context: true },
        ],
      },
    ]);
  });

  it('handles pi windows paths and limit notices', () => {
    const text = [
      'C:\\proj\\x.ts:12: hit: with colon',
      '',
      '[100 matches limit reached. Use limit=200 for more, or refine pattern]',
    ].join('\n');
    const r = parseGrepOutput(text);
    expect(r.total).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.files).toEqual([{ path: 'C:\\proj\\x.ts', matches: [{ line: 12, text: 'hit: with colon' }] }]);
  });

  it('returns empty for pi No matches found', () => {
    expect(parseGrepOutput('No matches found')).toEqual({ total: 0, truncated: false, files: [] });
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
