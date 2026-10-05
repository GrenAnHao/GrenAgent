import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../lib/pi';
import { parsePartialArgs } from '../../../lib/streamingJson';
import { applyEvent, initialAgentState, materializeToolDrafts, type AgentState, type ChatMessage } from '../../../stores/agentReducer';
import { dockTodos, latestTodosFromMessages } from './latestTodos';

const tool = (over: Partial<Extract<ChatMessage, { kind: 'tool' }>> & { result: unknown; status: 'running' | 'done' | 'error' }): ChatMessage => ({
  kind: 'tool',
  id: 't',
  toolCallId: 'c',
  toolName: 'todo',
  args: {},
  ...over,
});

describe('latestTodosFromMessages', () => {
  it('returns null when nothing succeeded', () => {
    expect(latestTodosFromMessages([])).toBeNull();
    expect(latestTodosFromMessages([
      tool({ status: 'error', result: { details: { todos: [], error: 'x' } } }),
    ])).toBeNull();
  });

  it('skips error status and details.error, keeps the last done snapshot', () => {
    const messages: ChatMessage[] = [
      tool({
        id: 'a',
        status: 'done',
        result: { details: { todos: [{ id: 1, text: 'old', status: 'pending' }], nextId: 2 } },
      }),
      tool({
        id: 'b',
        status: 'done',
        result: { details: { todos: [{ id: 1, text: 'new', status: 'in_progress' }], nextId: 2, error: 'nope' } },
      }),
      tool({
        id: 'c',
        status: 'error',
        result: { details: { todos: [], nextId: 1 } },
      }),
    ];
    expect(latestTodosFromMessages(messages)).toEqual([
      { id: 1, text: 'old', status: 'pending' },
    ]);
  });

  it('uses a running update once its args parse, ahead of the previous snapshot', () => {
    const messages: ChatMessage[] = [
      tool({
        id: 'a',
        status: 'done',
        result: {
          details: {
            todos: [
              { id: 1, text: '分析', status: 'in_progress' },
              { id: 2, text: '写文档', status: 'pending' },
            ],
            nextId: 3,
          },
        },
      }),
      tool({
        id: 'b',
        status: 'running',
        args: {
          todos: [
            { id: 1, text: '分析', status: 'completed' },
            { id: 2, text: '写文档', status: 'in_progress' },
          ],
        },
        result: undefined,
      }),
    ];
    expect(latestTodosFromMessages(messages)?.map((todo) => todo.status)).toEqual(['completed', 'in_progress']);
  });

  it('keeps the last done snapshot while the running update is still incomplete', () => {
    const messages: ChatMessage[] = [
      tool({
        id: 'a',
        status: 'done',
        result: { details: { todos: [{ id: 1, text: '分析', status: 'in_progress' }], nextId: 2 } },
      }),
      tool({
        id: 'b',
        status: 'running',
        args: { todos: [{ id: 1, text: '分析' }] },
        result: undefined,
      }),
    ];
    expect(latestTodosFromMessages(messages)).toEqual([
      { id: 1, text: '分析', status: 'in_progress' },
    ]);
  });

  it('prefers a partial result over args while the call is running', () => {
    const messages: ChatMessage[] = [
      tool({
        id: 'b',
        status: 'running',
        args: { todos: [{ id: 1, text: '参数里的旧文案', status: 'pending' }] },
        result: { details: { todos: [{ id: 1, text: '中间结果', status: 'completed' }], nextId: 2 } },
      }),
    ];
    expect(latestTodosFromMessages(messages)).toEqual([
      { id: 1, text: '中间结果', status: 'completed' },
    ]);
  });

  it('ignores half-written args while the call is still streaming', () => {
    const messages: ChatMessage[] = [
      tool({
        id: 'a',
        status: 'done',
        result: { details: { todos: [{ id: 1, text: '分析', status: 'in_progress' }], nextId: 2 } },
      }),
      tool({
        id: 'b',
        status: 'running',
        argsComplete: false,
        args: { todos: [{ id: 1, text: '分', status: 'completed' }] },
        result: undefined,
      }),
    ];
    expect(latestTodosFromMessages(messages)).toEqual([
      { id: 1, text: '分析', status: 'in_progress' },
    ]);
  });

  it('does not flip between the old and the half-streamed list', () => {
    const update = (ame: Record<string, unknown>) =>
      ({ type: 'message_update', assistantMessageEvent: ame }) as AgentEvent;
    const previous = tool({
      id: 'a',
      status: 'done',
      result: {
        details: {
          todos: [
            { id: 1, text: '分析', status: 'in_progress' },
            { id: 2, text: '实现', status: 'pending' },
          ],
          nextId: 3,
        },
      },
    });
    let state: AgentState = { ...initialAgentState(), messages: [previous] };
    state = applyEvent(state, update({ type: 'toolcall_start', contentIndex: 0, id: 'call_b', toolName: 'todo' }));
    const json = JSON.stringify({
      todos: [
        { status: 'completed', text: '分析' },
        { status: 'in_progress', text: '实现' },
        { status: 'pending', text: '验证' },
      ],
    });
    const seen: string[] = [];
    for (const ch of json) {
      state = applyEvent(state, update({ type: 'toolcall_delta', contentIndex: 0, delta: ch }));
      state = materializeToolDrafts(state, 0, parsePartialArgs).state;
      const label = (dockTodos(state.messages, false) ?? []).map((t) => `${t.text}:${t.status}`).join('|');
      if (seen.at(-1) !== label) seen.push(label);
    }
    state = applyEvent(state, update({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 'call_b', name: 'todo', arguments: JSON.parse(json) },
    }));
    const label = (dockTodos(state.messages, false) ?? []).map((t) => `${t.text}:${t.status}`).join('|');
    if (seen.at(-1) !== label) seen.push(label);
    expect(seen).toEqual([
      '分析:in_progress|实现:pending',
      '分析:completed|实现:in_progress|验证:pending',
    ]);
  });

  it('returns empty array after a successful clear', () => {
    expect(latestTodosFromMessages([
      tool({ status: 'done', result: { details: { todos: [], nextId: 1 } } }),
    ])).toEqual([]);
  });
});

const user = (text: string, steering = false): ChatMessage => ({
  kind: 'user',
  id: text,
  text,
  steering,
});

describe('dockTodos', () => {
  const done = tool({
    status: 'done',
    result: { details: { todos: [{ id: 1, text: '注册', status: 'completed' }], nextId: 2 } },
  });

  it('keeps a finished list until the next user message', () => {
    expect(dockTodos([done], true)?.map((todo) => todo.text)).toEqual(['注册']);
  });

  it('clears a finished list once the next user round starts', () => {
    expect(dockTodos([done, user('下一轮')], true)).toBeNull();
    expect(dockTodos([done, user('下一轮')], false)).toBeNull();
  });

  it('keeps unfinished work into the next round, and ignores steering', () => {
    const open = tool({
      status: 'done',
      result: { details: { todos: [{ id: 1, text: '还没做', status: 'pending' }], nextId: 2 } },
    });
    expect(dockTodos([open, user('继续')], true)?.[0]?.text).toBe('还没做');
    expect(dockTodos([done, user('插一句', true)], true)?.[0]?.text).toBe('注册');
  });
});
