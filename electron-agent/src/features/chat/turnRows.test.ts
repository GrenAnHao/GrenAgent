import { describe, expect, it } from 'vitest';
import { buildTurnRows } from './turnRows';
import type { TimelineSegment } from './groupMessages';

const thinking = (id: string): TimelineSegment => ({ kind: 'thinking', id, content: 't', streaming: false });
const text = (id: string): TimelineSegment => ({ kind: 'text', id, content: 'x', streaming: false });
const tool = (id: string, toolName: string): TimelineSegment => ({
  kind: 'tool',
  id,
  toolCallId: `c-${id}`,
  toolName,
  args: {},
  result: {},
  status: 'done',
});
const skillRead = (id: string): TimelineSegment => ({
  kind: 'tool',
  id,
  toolCallId: `c-${id}`,
  toolName: 'read',
  args: { path: `/home/u/.agents/skills/${id}/SKILL.md` },
  result: {},
  status: 'done',
});

describe('buildTurnRows', () => {
  it('collapses 2+ consecutive read/list tools, keeps position', () => {
    const rows = buildTurnRows([
      thinking('th1'),
      tool('r1', 'read'),
      tool('r2', 'read_file'),
      tool('l1', 'ls'),
      text('tx1'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['segment', 'context', 'segment']);
    const ctx = rows[1];
    if (ctx.kind !== 'context') throw new Error('expected context');
    expect(ctx.id).toBe('ctx-r1');
    expect(ctx.tools.map((t) => t.toolName)).toEqual(['read', 'read_file', 'ls']);
  });

  it('keeps a lone context tool as an individual row', () => {
    const rows = buildTurnRows([tool('r1', 'read'), tool('b1', 'bash')]);
    expect(rows.map((r) => r.kind)).toEqual(['segment', 'segment']);
    expect(rows.every((r) => r.kind === 'segment')).toBe(true);
  });

  it('never groups search/action tools (grep/glob/github stand alone)', () => {
    const rows = buildTurnRows([
      tool('g1', 'grep'),
      tool('g2', 'glob'),
      tool('c1', 'github'),
      tool('b1', 'bash'),
      tool('e1', 'edit'),
    ]);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.kind === 'segment')).toBe(true);
  });

  it('SKILL.md 读取(调用技能)不并入折叠，单独成行并打断 read 连读', () => {
    const rows = buildTurnRows([
      tool('r1', 'read'),
      tool('r2', 'read'),
      skillRead('myskill'),
      tool('r3', 'read'),
      tool('r4', 'read'),
    ]);
    // read,read -> 折叠；技能调用独立；read,read -> 折叠
    expect(rows.map((r) => r.kind)).toEqual(['context', 'segment', 'context']);
    const mid = rows[1];
    expect(mid.kind === 'segment' && mid.segment.kind === 'tool' && mid.segment.id).toBe('myskill');
  });

  it('图片读取单独成行，并打断前后的文件连读', () => {
    const imageRead = (id: string): TimelineSegment => ({
      kind: 'tool',
      id,
      toolCallId: `c-${id}`,
      toolName: 'read',
      args: { path: `${id}.png` },
      result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
      status: 'done',
    });
    const rows = buildTurnRows([
      tool('r1', 'read'),
      tool('r2', 'read'),
      imageRead('shot'),
      tool('r3', 'read'),
      tool('r4', 'read'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['context', 'segment', 'context']);
    const mid = rows[1];
    expect(mid?.kind === 'segment' && mid.segment.kind === 'tool' && mid.segment.id).toBe('shot');
  });

  it('search tools break a read run instead of merging into it', () => {
    const rows = buildTurnRows([
      tool('r1', 'read'),
      tool('r2', 'read'),
      tool('g1', 'grep'),
      tool('r3', 'read'),
      tool('r4', 'read'),
    ]);
    // read,read -> 折叠；grep 独立；read,read -> 折叠
    expect(rows.map((r) => r.kind)).toEqual(['context', 'segment', 'context']);
    const a = rows[0];
    const b = rows[2];
    if (a.kind !== 'context' || b.kind !== 'context') throw new Error('expected context groups');
    expect(a.tools.map((t) => t.id)).toEqual(['r1', 'r2']);
    expect(b.tools.map((t) => t.id)).toEqual(['r3', 'r4']);
    expect(rows[1].kind === 'segment' && rows[1].segment.kind === 'tool' && rows[1].segment.toolName).toBe('grep');
  });

  it('merges 2+ consecutive reasoning segments into one (treats todo reasoning spam)', () => {
    const rows = buildTurnRows([
      { kind: 'thinking', id: 'th1', content: '继续添加任务1', streaming: false, durationMs: 30 },
      { kind: 'thinking', id: 'th2', content: '继续添加任务2', streaming: false, durationMs: 40 },
      { kind: 'thinking', id: 'th3', content: '继续添加任务3', streaming: false, durationMs: 50 },
      tool('todo1', 'todo'),
    ]);
    // 三段思考折叠为一段，停在原位；todo 卡片独立成行
    expect(rows.map((r) => r.kind)).toEqual(['segment', 'segment']);
    const merged = rows[0];
    if (merged.kind !== 'segment' || merged.segment.kind !== 'thinking') throw new Error('expected merged thinking');
    expect(merged.id).toBe('th1'); // 稳定 id 取首段
    expect(merged.segment.content).toBe('继续添加任务1\n\n继续添加任务2\n\n继续添加任务3');
    expect(merged.segment.durationMs).toBe(120); // 30+40+50 累加
    expect(rows[1].kind === 'segment' && rows[1].segment.kind === 'tool' && rows[1].segment.toolName).toBe('todo');
  });

  it('keeps a lone reasoning segment unchanged (no merge for single)', () => {
    const rows = buildTurnRows([thinking('th1'), tool('b1', 'bash')]);
    expect(rows.map((r) => r.kind)).toEqual(['segment', 'segment']);
    expect(rows[0].kind === 'segment' && rows[0].segment.id).toBe('th1');
  });

  it('does not merge reasoning separated by text or tool', () => {
    const rows = buildTurnRows([thinking('th1'), text('tx1'), thinking('th2'), tool('b1', 'bash'), thinking('th3')]);
    expect(rows.map((r) => r.kind)).toEqual(['segment', 'segment', 'segment', 'segment', 'segment']);
    expect(rows.map((r) => (r.kind === 'segment' ? r.segment.id : ''))).toEqual(['th1', 'tx1', 'th2', 'b1', 'th3']);
  });

  it('marks merged reasoning as streaming if any part is still streaming', () => {
    const rows = buildTurnRows([
      { kind: 'thinking', id: 'th1', content: 'done', streaming: false, durationMs: 10 },
      { kind: 'thinking', id: 'th2', content: 'live', streaming: true },
    ]);
    expect(rows).toHaveLength(1);
    const seg = rows[0];
    expect(seg.kind === 'segment' && seg.segment.kind === 'thinking' && seg.segment.streaming).toBe(true);
  });
});
