import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './agentReducer';
import { backfillEntryIds, cutMessagesAfterEntry, keepSettledLiveTools, mergeLiveTail } from './sessionMessageSync';

const user = (id: string, text: string, entryId?: string): ChatMessage => ({
  kind: 'user',
  id,
  text,
  entryId,
});

const assistant = (id: string, text: string): ChatMessage => ({
  kind: 'assistant',
  id,
  text,
  thinking: '',
  streaming: false,
});

describe('cutMessagesAfterEntry', () => {
  it('drop-target 裁掉目标及之后', () => {
    const messages = [user('1', 'a', 'u1'), assistant('2', 'r'), user('3', 'b', 'u2')];
    expect(cutMessagesAfterEntry(messages, 'u2', 'drop-target')).toEqual([
      user('1', 'a', 'u1'),
      assistant('2', 'r'),
    ]);
  });

  it('keep-target 保留目标只裁后代', () => {
    const messages = [user('1', 'a', 'u1'), assistant('2', 'r')];
    expect(cutMessagesAfterEntry(messages, 'u1', 'keep-target')).toEqual([user('1', 'a', 'u1')]);
  });

  it('找不到 entryId 返回 null，避免误写长列表', () => {
    const messages = [user('1', 'a', 'u1'), assistant('2', 'r')];
    expect(cutMessagesAfterEntry(messages, 'missing', 'drop-target')).toBeNull();
  });
});

describe('mergeLiveTail', () => {
  const timed = (id: string, text: string, timestamp: number, streaming = false): ChatMessage => ({
    kind: 'assistant',
    id,
    text,
    thinking: '',
    streaming,
    timestamp,
  });
  const tool = (id: string, toolCallId: string, status: 'running' | 'done', result?: unknown): ChatMessage => ({
    kind: 'tool',
    id,
    toolCallId,
    toolName: 'bash',
    args: { command: 'ls' },
    result,
    status,
  });

  it('快照里已有的原位更新，没落盘的按顺序接在后面', () => {
    const base = [user('u', 'task'), timed('a1', 'done answer', 1), tool('t1', 'call-1', 'running')];
    const tail = [tool('x1', 'call-1', 'done', 'ok'), timed('x2', 'still typing', 2, true), tool('x3', 'call-2', 'running')];
    const merged = mergeLiveTail(base, tail);
    expect(merged.map((m) => m.id)).toEqual(['u', 'a1', 't1', 'x2', 'x3']);
    expect(merged[2]).toMatchObject({ status: 'done', result: 'ok', args: { command: 'ls' } });
  });

  it('同一条助手消息两边都有时不重复，保留更新的那份', () => {
    const merged = mergeLiveTail([timed('a1', 'par', 5)], [timed('x1', 'partial more', 5, true)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'a1', text: 'partial more', streaming: true });
  });

  it('空尾巴原样返回快照，空快照返回尾巴', () => {
    const base = [user('u', 'task')];
    expect(mergeLiveTail(base, [])).toBe(base);
    const tail = [timed('x', 't', 1, true)];
    expect(mergeLiveTail([], tail)).toBe(tail);
  });
});

describe('backfillEntryIds', () => {
  it('按序把后端 entryId 补到本地用户消息，不重排', () => {
    const local: ChatMessage[] = [
      user('local-1', 'hello'),
      assistant('a1', 'reply'),
      user('local-2', 'again'),
    ];
    const next = backfillEntryIds(local, [
      { role: 'user', content: 'hello', entryId: 'entry-u1', timestamp: 10 },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }], entryId: 'entry-a1' },
      { role: 'user', content: 'again', entryId: 'entry-u2', timestamp: 20 },
    ]);
    expect(next.map((m) => (m.kind === 'user' ? m.entryId : m.kind))).toEqual([
      'entry-u1',
      'assistant',
      'entry-u2',
    ]);
    expect(next[0]).toMatchObject({ id: 'local-1', text: 'hello', timestamp: 10 });
    expect(next[2]).toMatchObject({ id: 'local-2', text: 'again', timestamp: 20 });
    // 顺序与本地 id 不变
    expect(next.map((m) => m.id)).toEqual(['local-1', 'a1', 'local-2']);
  });

  it('已有 entryId 时不覆盖，仍按序对齐后续消息', () => {
    const local: ChatMessage[] = [user('1', 'a', 'keep-me'), user('2', 'b')];
    const next = backfillEntryIds(local, [
      { role: 'user', content: 'a', entryId: 'backend-1' },
      { role: 'user', content: 'b', entryId: 'backend-2' },
    ]);
    expect(next[0]).toMatchObject({ entryId: 'keep-me' });
    expect(next[1]).toMatchObject({ entryId: 'backend-2' });
  });
});

describe('keepSettledLiveTools', () => {
  const tool = (id: string, toolCallId: string, status: 'running' | 'done' | 'error', text?: string): ChatMessage =>
    ({
      kind: 'tool',
      id,
      toolCallId,
      toolName: 'code_explore',
      args: { query: 'q' },
      status,
      ...(text ? { result: { content: [{ type: 'text', text }] } } : {}),
    }) as ChatMessage;

  it('快照里还在跑、实时已结束：沿用实时结果，id 保持快照的', () => {
    const out = keepSettledLiveTools([tool('s1', 'c1', 'running'), tool('s2', 'b1', 'running')], [tool('l1', 'c1', 'done', 'hit')]);
    expect(out[0]).toMatchObject({ id: 's1', status: 'done', result: { content: [{ text: 'hit' }] } });
    expect(out[1]).toMatchObject({ id: 's2', status: 'running' });
  });

  it('实时还在跑、快照已有结果：以快照为准（进程子代理不推事件）', () => {
    const base = [tool('s1', 'c1', 'done', 'from-jsonl')];
    expect(keepSettledLiveTools(base, [tool('l1', 'c1', 'running')])).toBe(base);
  });
});
