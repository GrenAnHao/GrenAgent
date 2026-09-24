import { describe, expect, it, vi } from 'vitest';
import { completeAskUser } from './completeAskUser';

function fakeSession(messages: Array<Record<string, unknown>>) {
  const appended: unknown[] = [];
  return {
    appended,
    isStreaming: false,
    messages,
    sessionManager: { appendMessage: (message: unknown) => { appended.push(message); return 'e1'; } },
    agent: {
      state: { messages: [...messages] },
      continue: vi.fn(async () => {}),
    },
  };
}

describe('completeAskUser', () => {
  it('appends a cancel tool result and continues once', async () => {
    const session = fakeSession([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { questions: [{ question: '选哪个' }] } }] },
    ]);
    await completeAskUser(session, { toolCallId: 'q1', cancelled: true });
    expect(session.appended).toHaveLength(1);
    expect(session.appended[0]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'q1',
      toolName: 'ask_user',
      content: [{ type: 'text', text: '用户取消了 ask_user 选择（未作答）。' }],
    });
    expect(session.agent.state.messages.at(-1)).toEqual(session.appended[0]);
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
  });

  it('retries continue when the last message is already this tool result', async () => {
    const session = fakeSession([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'q1', toolName: 'ask_user', content: [{ type: 'text', text: 'done' }] },
    ]);
    await expect(completeAskUser(session, { toolCallId: 'q1', cancelled: true })).resolves.toBe('ok');
    expect(session.appended).toHaveLength(0);
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
  });

  it('returns duplicate when a later message follows the tool result', async () => {
    const session = fakeSession([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'q1', toolName: 'ask_user', content: [{ type: 'text', text: 'done' }] },
      { role: 'assistant', content: [{ type: 'text', text: '已继续' }] },
    ]);
    await expect(completeAskUser(session, { toolCallId: 'q1', cancelled: true })).resolves.toBe('duplicate');
    expect(session.appended).toHaveLength(0);
    expect(session.agent.continue).not.toHaveBeenCalled();
  });

  it('rejects a tool call that is not the pending ask_user', async () => {
    const session = fakeSession([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: {} }] },
    ]);
    await expect(completeAskUser(session, { toolCallId: 'other', cancelled: true })).rejects.toThrow(/pending/);
  });
});
