import { describe, it, expect } from 'vitest';
import type { ChatMessage } from './agentReducer';
import { applyPendingAskUserOnLoad } from './pendingAskUserLoad';

function tool(
  partial: Partial<Extract<ChatMessage, { kind: 'tool' }>> &
    Pick<Extract<ChatMessage, { kind: 'tool' }>, 'toolCallId' | 'toolName' | 'status'>,
): ChatMessage {
  return {
    kind: 'tool',
    id: partial.id ?? `m-${partial.toolCallId}`,
    toolCallId: partial.toolCallId,
    toolName: partial.toolName,
    args: partial.args ?? {},
    result: partial.result,
    status: partial.status,
  };
}

describe('applyPendingAskUserOnLoad', () => {
  it('结果还没落盘的普通调用保持 running，交给调用方判断还在不在跑', () => {
    const out = applyPendingAskUserOnLoad(
      [tool({ toolCallId: 'b1', toolName: 'bash', status: 'running' })],
      null,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'tool', toolCallId: 'b1', status: 'running' });
    expect((out[0] as { result?: unknown }).result).toBeUndefined();
  });

  it('已有结果却还标着 running 的卡（旧界面历史残留）收成 error', () => {
    const out = applyPendingAskUserOnLoad(
      [tool({ toolCallId: 'b2', toolName: 'bash', status: 'running', result: { content: [{ type: 'text', text: 'partial' }] } })],
      null,
    );
    expect(out[0]).toMatchObject({ toolCallId: 'b2', status: 'error' });
  });

  it('不再等待的 ask_user 行收成 error', () => {
    const out = applyPendingAskUserOnLoad(
      [tool({ toolCallId: 'q0', toolName: 'ask_user', status: 'running' })],
      null,
    );
    expect(out[0]).toMatchObject({ toolCallId: 'q0', status: 'error' });
  });

  it('keeps the current pending ask_user as running', () => {
    const pending = { toolCallId: 'q1', args: { questions: [{ question: '选哪个' }] } };
    const out = applyPendingAskUserOnLoad(
      [tool({ toolCallId: 'q1', toolName: 'ask_user', status: 'running', args: { old: true } })],
      pending,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'q1',
      toolName: 'ask_user',
      status: 'running',
      args: pending.args,
    });
  });

  it('marks a stale ask_user running row as error when it is not pending', () => {
    const out = applyPendingAskUserOnLoad(
      [
        tool({ toolCallId: 'old', toolName: 'ask_user', status: 'running' }),
        tool({ toolCallId: 'q1', toolName: 'ask_user', status: 'running' }),
      ],
      { toolCallId: 'q1', args: { questions: [] } },
    );
    expect(out.find((m) => m.kind === 'tool' && m.toolCallId === 'old')).toMatchObject({
      status: 'error',
    });
    expect(out.find((m) => m.kind === 'tool' && m.toolCallId === 'q1')).toMatchObject({
      status: 'running',
    });
  });

  it('appends a running ask_user when the longer uiHistory list is missing it', () => {
    const pending = { toolCallId: 'q1', args: { questions: [{ question: '选哪个' }] } };
    const out = applyPendingAskUserOnLoad(
      [{ kind: 'user', id: 'u1', text: 'earlier' }],
      pending,
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      kind: 'tool',
      toolCallId: 'q1',
      toolName: 'ask_user',
      status: 'running',
      args: pending.args,
    });
  });

  it('does not duplicate when the display list already has the pending toolCallId', () => {
    const pending = { toolCallId: 'q1', args: { questions: [] } };
    const out = applyPendingAskUserOnLoad(
      [tool({ toolCallId: 'q1', toolName: 'ask_user', status: 'running' })],
      pending,
    );
    expect(out.filter((m) => m.kind === 'tool' && m.toolCallId === 'q1')).toHaveLength(1);
  });

  it('flips a done/error row for the pending toolCallId back to running', () => {
    const pending = { toolCallId: 'q1', args: { questions: [{ question: '再选' }] } };
    const out = applyPendingAskUserOnLoad(
      [
        tool({
          toolCallId: 'q1',
          toolName: 'ask_user',
          status: 'done',
          args: { stale: true },
          result: { content: [] },
        }),
      ],
      pending,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'q1',
      status: 'running',
      args: pending.args,
    });
  });
});
