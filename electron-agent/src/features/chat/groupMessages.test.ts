import { describe, expect, it } from 'vitest';
import { groupMessages } from './groupMessages';
import type { ChatMessage } from '../../stores/agentReducer';

const assistant = (id: string, over: Partial<Extract<ChatMessage, { kind: 'assistant' }>> = {}): ChatMessage => ({
  kind: 'assistant',
  id,
  text: '',
  thinking: '',
  streaming: false,
  ...over,
});

const tool = (id: string, toolName: string, status: 'running' | 'done' | 'error' = 'done'): ChatMessage => ({
  kind: 'tool',
  id,
  toolCallId: `c-${id}`,
  toolName,
  args: {},
  result: {},
  status,
});

describe('groupMessages', () => {
  it('expands one turn into chronological timeline segments', () => {
    const out = groupMessages([
      assistant('a1', { thinking: 'think A', thinkingDuration: 1000 }),
      tool('t1', 'bash'),
      assistant('a2', { text: 'final answer', thinking: 'think B', thinkingDuration: 2000 }),
      tool('t2', 'read'),
    ]);

    expect(out).toHaveLength(1);
    const turn = out[0];
    expect(turn.kind).toBe('turn');
    if (turn.kind !== 'turn') return;

    expect(turn.id).toBe('a1');
    expect(turn.segments.map((s) => s.kind)).toEqual(['thinking', 'tool', 'thinking', 'text', 'tool']);
    expect(turn.segments[0]).toMatchObject({ kind: 'thinking', content: 'think A', id: 'a1-thinking', durationMs: 1000 });
    expect(turn.segments[1]).toMatchObject({ kind: 'tool', toolName: 'bash', id: 't1' });
    expect(turn.segments[2]).toMatchObject({ kind: 'thinking', content: 'think B', id: 'a2-thinking' });
    expect(turn.segments[3]).toMatchObject({ kind: 'text', content: 'final answer', id: 'a2-text' });
    expect(turn.segments[4]).toMatchObject({ kind: 'tool', toolName: 'read', id: 't2' });
  });

  it('marks only the active reasoning segment as streaming', () => {
    const out = groupMessages([
      assistant('a1', { thinking: 'done thinking', streaming: false, thinkingDuration: 500 }),
      tool('t1', 'bash'),
      assistant('a2', { thinking: 'still thinking', streaming: true }),
    ]);
    const turn = out[0];
    if (turn.kind !== 'turn') throw new Error('expected turn');
    expect(turn.segments[0]).toMatchObject({ kind: 'thinking', streaming: false });
    expect(turn.segments[2]).toMatchObject({ kind: 'thinking', streaming: true });
  });

  it('starts a new turn after a user message', () => {
    const out = groupMessages([
      assistant('a1', { text: 'hi' }),
      { kind: 'user', id: 'u1', text: 'next' },
      assistant('a2', { text: 'reply' }),
    ]);
    expect(out.map((m) => m.kind)).toEqual(['turn', 'user', 'turn']);
  });

  it('spawn_agent breaks the turn and stands alone', () => {
    const out = groupMessages([
      assistant('a1', { thinking: 'plan' }),
      tool('s1', 'spawn_agent'),
      assistant('a2', { text: 'done', thinking: 'wrap up' }),
      tool('t2', 'bash'),
    ]);
    expect(out.map((m) => m.kind)).toEqual(['turn', 'tool', 'turn']);
    const last = out[2];
    if (last.kind !== 'turn') throw new Error('expected turn');
    expect(last.segments.map((s) => s.kind)).toEqual(['thinking', 'text', 'tool']);
  });

  it('collapses repeated todo updates into one snapshot at the latest position', () => {
    const out = groupMessages([
      assistant('a1', { text: 'working' }),
      tool('t1', 'todo'),
      tool('b1', 'bash'),
      tool('t2', 'todo'),
      tool('t3', 'todo'),
    ]);

    expect(out).toHaveLength(1);
    const turn = out[0];
    if (turn.kind !== 'turn') throw new Error('expected turn');

    // 三次 todo 合并为一张，停在最后一次 todo 调用的位置（bash 之后）。
    const todos = turn.segments.filter((s) => s.kind === 'tool' && s.toolName === 'todo');
    expect(todos).toHaveLength(1);
    expect(turn.segments.map((s) => s.kind)).toEqual(['text', 'tool', 'tool']);

    // 稳定 id 与 turn 绑定，便于 React 原地复用；内容取最新一次（t3）。
    const todoSeg = turn.segments[2];
    expect(todoSeg).toMatchObject({ kind: 'tool', toolName: 'todo', id: 'a1-todo' });
    if (todoSeg.kind === 'tool') expect(todoSeg.toolCallId).toBe('c-t3');
  });

  it('keeps todo snapshots independent across turns', () => {
    const out = groupMessages([
      assistant('a1', { text: 'first' }),
      tool('t1', 'todo'),
      { kind: 'user', id: 'u1', text: 'go on' },
      assistant('a2', { text: 'second' }),
      tool('t2', 'todo'),
    ]);

    expect(out.map((m) => m.kind)).toEqual(['turn', 'user', 'turn']);
    const first = out[0];
    const second = out[2];
    if (first.kind !== 'turn' || second.kind !== 'turn') throw new Error('expected turns');
    expect(first.segments.find((s) => s.kind === 'tool')).toMatchObject({ id: 'a1-todo' });
    expect(second.segments.find((s) => s.kind === 'tool')).toMatchObject({ id: 'a2-todo' });
  });
});
