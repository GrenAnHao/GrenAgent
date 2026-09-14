import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../stores/agentReducer';
import { latestTodosFromMessages } from './latestTodos';

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

  it('returns empty array after a successful clear', () => {
    expect(latestTodosFromMessages([
      tool({ status: 'done', result: { details: { todos: [], nextId: 1 } } }),
    ])).toEqual([]);
  });
});
