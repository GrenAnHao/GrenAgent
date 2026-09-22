import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './agentReducer';
import { backfillEntryIds, cutMessagesAfterEntry } from './sessionMessageSync';

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
