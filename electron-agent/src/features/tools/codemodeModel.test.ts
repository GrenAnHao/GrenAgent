import { describe, expect, it } from 'vitest';
import type { ToolSegment } from '../chat/groupMessages';
import {
  callLabel,
  codemodeCallSummary,
  codemodeCalls,
  detectResultFormat,
  firstCodeLine,
  formatCallDuration,
  mcpToolParts,
  mergeCodemodeCalls,
  parseCodemodeOutput,
  splitFullOutput,
  toolArgsSummary,
  type CodemodeCall,
} from './codemodeModel';

const header = (ok: boolean, seconds: string) => ({
  type: 'text',
  text: `${ok ? 'Script completed' : 'Script failed'}\nWall time ${seconds} seconds\nOutput:\n`,
});

function child(toolCallId: string, toolName: string, status: ToolSegment['status'] = 'done'): ToolSegment {
  return { kind: 'tool', id: `seg-${toolCallId}`, toolCallId, toolName, args: {}, result: undefined, status };
}

function call(id: string, name: string, status: CodemodeCall['status'] = 'ok', durationMs?: number): CodemodeCall {
  return { id, name, args: '{}', status, ...(durationMs != null ? { durationMs } : {}) };
}

describe('parseCodemodeOutput', () => {
  it('drops the script header and keeps the wall time', () => {
    const out = parseCodemodeOutput({ content: [header(true, '3.4'), { type: 'text', text: 'hello' }] });
    expect(out.ok).toBe(true);
    expect(out.wallMs).toBe(3400);
    expect(out.blocks).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('pretty prints JSON blocks and merges adjacent text blocks', () => {
    const out = parseCodemodeOutput({
      content: [header(true, '1.0'), { type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: '{"x":1}' }],
    });
    expect(out.blocks).toEqual([
      { kind: 'text', text: 'a\nb' },
      { kind: 'json', text: '{\n  "x": 1\n}' },
    ]);
  });

  it('splits the script error out of a failed run', () => {
    const out = parseCodemodeOutput({
      content: [header(false, '2.0'), { type: 'text', text: 'partial' }, { type: 'text', text: 'Script error:\nError: boom' }],
    });
    expect(out.ok).toBe(false);
    expect(out.blocks).toEqual([
      { kind: 'text', text: 'partial' },
      { kind: 'error', text: 'Error: boom' },
    ]);
  });

  it('splits the 1.1.0 joined block into text items, JSON and console output', () => {
    const joined = [
      '==> text 1/2 <==',
      'first line',
      'second line',
      '==> text 2/2 <==',
      '{"ok":true}',
      '<console_output>',
      'log a',
      'log b',
      '</console_output>',
    ].join('\n');
    const out = parseCodemodeOutput({ content: [header(true, '1.2'), { type: 'text', text: joined }] });
    expect(out.blocks).toEqual([
      { kind: 'text', text: 'first line\nsecond line' },
      { kind: 'json', text: '{\n  "ok": true\n}' },
      { kind: 'console', text: 'log a\nlog b' },
    ]);
  });

  it('keeps a single 1.1.0 text item without a marker as is', () => {
    const out = parseCodemodeOutput({ content: [header(true, '0.3'), { type: 'text', text: '[1,2]' }] });
    expect(out.blocks).toEqual([{ kind: 'json', text: '[\n  1,\n  2\n]' }]);
  });

  it('splits the script error off the end of a failed 1.1.0 block', () => {
    const joined = '<console_output>\nstarted\n</console_output>\nScript error:\nError: boom\n    at <anonymous> (script:3)';
    const out = parseCodemodeOutput({ content: [header(false, '0.4'), { type: 'text', text: joined }] });
    expect(out.blocks).toEqual([
      { kind: 'console', text: 'started' },
      { kind: 'error', text: 'Error: boom\n    at <anonymous> (script:3)' },
    ]);
  });

  it('continues text items across an image block', () => {
    const out = parseCodemodeOutput({
      content: [
        header(true, '1.0'),
        { type: 'text', text: '==> text 1/2 <==\nbefore' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: '==> text 2/2 <==\nafter' },
      ],
    });
    expect(out.blocks).toEqual([{ kind: 'text', text: 'before\nafter' }]);
  });

  it('does not treat script text as markers, console or errors on a completed run', () => {
    const text = 'see ==> text 1/2 <==\nScript error:\nnot really\n<console_output>\nx\n</console_output> trailing';
    const out = parseCodemodeOutput({ content: [header(true, '0.1'), { type: 'text', text }] });
    expect(out.blocks).toEqual([{ kind: 'text', text }]);
  });

  it('keeps input without a header (rejected options) as text', () => {
    const out = parseCodemodeOutput({ content: [{ type: 'text', text: 'Invalid // @options line' }] });
    expect(out.ok).toBeUndefined();
    expect(out.blocks).toEqual([{ kind: 'text', text: 'Invalid // @options line' }]);
  });

  it('reads fullOutputPath from details', () => {
    const out = parseCodemodeOutput({ content: [header(true, '1.0')], details: { calls: [], fullOutputPath: '/tmp/x.txt' } });
    expect(out.fullOutputPath).toBe('/tmp/x.txt');
    expect(out.blocks).toEqual([]);
  });
});

describe('codemodeCalls', () => {
  it('normalizes details.calls and skips malformed rows', () => {
    const calls = codemodeCalls({
      details: {
        calls: [
          { id: 'p/1', name: 'mcp__a__x', args: '{"q":"1"}', status: 'ok', durationMs: 12 },
          { id: 'p/?', name: 'mcp__a__y', args: '{}', status: 'weird' },
          { id: 'p/3' },
          null,
        ],
      },
    });
    expect(calls).toEqual([
      { id: 'p/1', name: 'mcp__a__x', args: '{"q":"1"}', status: 'ok', durationMs: 12 },
      { id: 'p/?', name: 'mcp__a__y', args: '{}', status: 'running' },
    ]);
  });
});

describe('mergeCodemodeCalls', () => {
  it('pairs records with live children by id and carries the recorded duration', () => {
    const items = mergeCodemodeCalls([call('p/1', 'mcp__a__x', 'ok', 812)], [child('p/1', 'mcp__a__x')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'live', status: 'ok', durationMs: 812 });
  });

  it('pairs a running `/?` record with the unclaimed live child of the same name', () => {
    const items = mergeCodemodeCalls(
      [call('p/1', 'mcp__a__x'), call('p/?', 'mcp__a__y', 'running')],
      [child('p/1', 'mcp__a__x'), child('p/2', 'mcp__a__y', 'running')],
    );
    expect(items.map((item) => [item.kind, item.status, item.name])).toEqual([
      ['live', 'ok', 'mcp__a__x'],
      ['live', 'running', 'mcp__a__y'],
    ]);
  });

  it('keeps records without a live child (history replay, models.* calls)', () => {
    const items = mergeCodemodeCalls([call('p/1', 'mcp__a__x'), call('p/models.classify/1', 'models.classify', 'error')]);
    expect(items.map((item) => item.kind)).toEqual(['record', 'record']);
    expect(items[1]!.status).toBe('error');
  });

  it('appends live children the progress update has not reported yet', () => {
    const items = mergeCodemodeCalls([call('p/1', 'mcp__a__x')], [child('p/1', 'mcp__a__x'), child('p/2', 'mcp__a__y', 'running')]);
    expect(items.map((item) => item.name)).toEqual(['mcp__a__x', 'mcp__a__y']);
    expect(items[1]!.status).toBe('running');
  });
});

describe('labels', () => {
  it('splits MCP names into server and tool', () => {
    expect(mcpToolParts('mcp__deepwiki__ask_wiki_question')).toEqual({ server: 'deepwiki', tool: 'ask_wiki_question' });
    expect(mcpToolParts('read')).toBeNull();
    expect(callLabel('mcp__antd__antd_doc')).toBe('antd.antd_doc');
    expect(callLabel('models.classify')).toBe('models.classify');
  });

  it('summarizes repeated calls with a count', () => {
    expect(codemodeCallSummary(['mcp__antd__antd_doc', 'mcp__antd__antd_doc', 'mcp__deepwiki__ask_wiki_question'])).toBe(
      'antd.antd_doc ×2、deepwiki.ask_wiki_question',
    );
  });

  it('skips the options line when picking the first code line', () => {
    expect(firstCodeLine('// @options: {"timeout_ms": 1}\n\n  const a = 1;\nreturn a;')).toBe('const a = 1;');
  });

  it('formats call durations', () => {
    expect(formatCallDuration(95)).toBe('95ms');
    expect(formatCallDuration(2380)).toBe('2.4s');
    expect(formatCallDuration(80_000)).toBe('1m20s');
  });
});

describe('toolArgsSummary', () => {
  it('reads strings and arrays in written order', () => {
    expect(toolArgsSummary({ repoName: 'a/b', question: 'How?' })).toBe('a/b · How?');
    expect(toolArgsSummary({ queries: [{ query: 'one' }, { query: 'two' }] })).toBe('one 等 2 项');
    expect(toolArgsSummary({ component: 'Splitter' })).toBe('Splitter');
  });

  it('parses the truncated JSON preview from details.calls', () => {
    const preview = `${JSON.stringify({ question: 'x'.repeat(300) }).slice(0, 197)}...`;
    expect(toolArgsSummary(preview).startsWith('xxx')).toBe(true);
  });
});

describe('MCP result body helpers', () => {
  it('splits the 全文 path off the end', () => {
    expect(splitFullOutput('body\n全文: C:\\tmp\\mcp-result-1')).toEqual({ body: 'body', fullPath: 'C:\\tmp\\mcp-result-1' });
    expect(splitFullOutput('plain')).toEqual({ body: 'plain' });
  });

  it('detects json, markdown and plain text', () => {
    expect(detectResultFormat('{"a":1}')).toBe('json');
    expect(detectResultFormat('## Title\ntext')).toBe('markdown');
    expect(detectResultFormat('see [docs](https://x.dev)')).toBe('markdown');
    expect(detectResultFormat('MCP error -32603: not indexed')).toBe('text');
  });
});
