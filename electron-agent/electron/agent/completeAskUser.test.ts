import { describe, expect, it, vi } from 'vitest';
import { completeAskUser, finishCompleteAskUser } from './completeAskUser.ts';
import { getVisualReview, publishVisualReview } from '../../../extensions/visual-companion/reviewRegistry.ts';

function fakeSession(messages: Array<Record<string, unknown>>) {
  const appended: unknown[] = [];
  return {
    appended,
    isStreaming: false,
    messages,
    sessionManager: { appendMessage: (message: unknown) => { appended.push(message); return 'e1'; }, getSessionFile: () => 'historical-owner' },
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

  it('validates a restored review against the original output and stable answer ID', async () => {
    const previewId = publishVisualReview('historical-owner').previewId;
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'show-1', name: 'show_visual', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'show-1', toolName: 'show_visual', details: { previewId } },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q-review', name: 'ask_user', arguments: { visualReview: { previewId } } }] },
    ];
    const session = fakeSession(messages);
    const value = JSON.stringify({ __askUserAnswer: 1, text: '[我的选择]\\n1. 评审：通过\\n补充说明：看图', images: [{ mimeType: 'image/png', data: 'abc' }], review: { previewId, outcome: 'approved' } });
    await expect(completeAskUser(session, { toolCallId: 'q-review', value })).resolves.toBe('ok');
    expect(session.appended[0]).toMatchObject({ details: { review: { previewId, requestId: 'q-review', outcome: 'approved' } }, content: [
      { type: 'text', text: expect.stringContaining('补充说明：看图') }, { type: 'image', mimeType: 'image/png', data: 'abc' },
    ] });
  });

  it('keeps a review pending and retryable if appendMessage fails', async () => {
    const previewId = publishVisualReview('historical-owner').previewId;
    const session = fakeSession([
      { role: 'toolResult', toolCallId: 'show-retry', toolName: 'show_visual', details: { previewId } },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'ask-retry', name: 'ask_user', arguments: { visualReview: { previewId } } }] },
    ]);
    const write = vi.fn(() => { throw new Error('disk write failed'); });
    session.sessionManager.appendMessage = write;
    const value = JSON.stringify({ __askUserAnswer: 1, text: '通过', review: { previewId, outcome: 'approved' } });
    await expect(completeAskUser(session, { toolCallId: 'ask-retry', value })).rejects.toThrow('disk write failed');
    expect(getVisualReview(previewId)).toMatchObject({ requestId: 'ask-retry', outcome: 'pending' });
    expect(session.agent.state.messages).toHaveLength(2);
    expect(session.agent.continue).not.toHaveBeenCalled();
    session.sessionManager.appendMessage = (message: unknown) => { session.appended.push(message); return 'saved'; };
    await expect(completeAskUser(session, { toolCallId: 'ask-retry', value })).resolves.toBe('ok');
    expect(getVisualReview(previewId)?.outcome).toBe('approved');
    expect(session.appended).toHaveLength(1);
  });

  it('rejects stale older versions, foreign owner and unstructured text', async () => {
    const older = publishVisualReview('historical-owner').previewId;
    const latest = publishVisualReview('historical-owner').previewId;
    const session = fakeSession([
      { role: 'toolResult', toolCallId: 'show-old', toolName: 'show_visual', details: { previewId: older } },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q-old', name: 'ask_user', arguments: { visualReview: { previewId: older } } }] },
      { role: 'toolResult', toolCallId: 'show-new', toolName: 'show_visual', details: { previewId: latest } },
    ]);
    await expect(completeAskUser(session, { toolCallId: 'q-old', value: JSON.stringify({ __askUserAnswer: 1, text: '通过', review: { previewId: older, outcome: 'approved' } }) })).rejects.toThrow();
    expect(session.appended).toHaveLength(0);
    const other = fakeSession([
      { role: 'toolResult', toolCallId: 'show-other', toolName: 'show_visual', details: { previewId: 'foreign-preview' } },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q-other', name: 'ask_user', arguments: { visualReview: { previewId: 'foreign-preview' } } }] },
    ]);
    await expect(completeAskUser(other, { toolCallId: 'q-other', value: '通过' })).rejects.toThrow('VISUAL_REVIEW_STALE');
    expect(other.appended).toHaveLength(0);
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

  it('acknowledges the completed tool call without waiting for draft cleanup', async () => {
    const cleanup = new Promise<void>(() => {});
    await expect(finishCompleteAskUser('ok', () => cleanup)).resolves.toBe('ok');
  });
});
