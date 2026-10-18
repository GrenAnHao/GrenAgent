import { describe, expect, it, vi } from 'vitest';
import { completeAskUser, finishCompleteAskUser } from './completeAskUser';

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
    prompt: vi.fn(async (_text: string, _options?: { images?: unknown[] }) => {}),
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

  // 中断 / 出错的回合被 pi-ai 整条丢掉，再补 toolResult 就是孤儿 tool_result，会话从此 400。
  it('relays the answer as a user message when the owning turn was aborted', async () => {
    const session = fakeSession([
      {
        role: 'assistant',
        stopReason: 'aborted',
        content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { questions: [{ question: '选哪个' }] } }],
      },
    ]);
    await expect(completeAskUser(session, { toolCallId: 'q1', value: '[我的选择]\n1. 选哪个：甲' })).resolves.toBe('ok');
    expect(session.appended).toHaveLength(0);
    expect(session.agent.continue).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledTimes(1);
    const [text] = session.prompt.mock.calls[0]!;
    expect(text).toContain('上一轮已中断');
    expect(text).toContain('[我的选择]');
  });

  it('writes nothing when a card from an errored turn is cancelled', async () => {
    const session = fakeSession([
      {
        role: 'assistant',
        stopReason: 'error',
        content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: {} }],
      },
    ]);
    await expect(completeAskUser(session, { toolCallId: 'q1', cancelled: true })).resolves.toBe('ok');
    expect(session.appended).toHaveLength(0);
    expect(session.agent.continue).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('still answers a live turn with a tool result even when an older turn died', async () => {
    const session = fakeSession([
      { role: 'assistant', stopReason: 'aborted', content: [{ type: 'toolCall', id: 'q0', name: 'ask_user', arguments: {} }] },
      { role: 'user', content: [{ type: 'text', text: '重问' }] },
      { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: {} }] },
    ]);
    await expect(completeAskUser(session, { toolCallId: 'q1', cancelled: true })).resolves.toBe('ok');
    expect(session.appended).toHaveLength(1);
    expect(session.appended[0]).toMatchObject({ role: 'toolResult', toolCallId: 'q1' });
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
  });
});

describe('finishCompleteAskUser', () => {
  it('returns the original result when draft delete fails', async () => {
    const logError = vi.fn();
    await expect(
      finishCompleteAskUser('ok', async () => {
        throw new Error('delete failed');
      }, logError),
    ).resolves.toBe('ok');
    expect(logError).toHaveBeenCalledTimes(1);

    await expect(
      finishCompleteAskUser('duplicate', async () => {
        throw new Error('delete failed');
      }, logError),
    ).resolves.toBe('duplicate');
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('still returns the result when draft delete s쳮ds', async () => {
    const deleteDraft = vi.fn(async () => {});
    await expect(finishCompleteAskUser('ok', deleteDraft)).resolves.toBe('ok');
    expect(deleteDraft).toHaveBeenCalledTimes(1);
  });
});
