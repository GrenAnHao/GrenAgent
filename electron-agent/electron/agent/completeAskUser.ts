import { findPendingAskUser } from '../../src/features/chat/pendingAskUser';
import { decodeAskUserAnswer } from '../../../extensions/agent-mode/questions.js';

const CANCEL_TEXT = '用户取消了 ask_user 选择（未作答）。';

export interface CompleteAskUserSession {
  isStreaming: boolean;
  messages: Array<{ role?: unknown; content?: unknown; toolCallId?: unknown }>;
  sessionManager: { appendMessage: (message: unknown) => unknown };
  agent: {
    state: { messages: unknown[] };
    continue: () => Promise<unknown>;
  };
}

export interface CompleteAskUserInput {
  toolCallId: string;
  value?: string;
  cancelled?: boolean;
}

function buildContent(input: CompleteAskUserInput): Array<{ type: string; text?: string; mimeType?: string; data?: string }> {
  if (input.cancelled) {
    return [{ type: 'text', text: CANCEL_TEXT }];
  }
  const decoded = decodeAskUserAnswer(input.value);
  if (decoded.text.trim() || decoded.images.length > 0) {
    return [
      ...(decoded.text.trim() ? [{ type: 'text' as const, text: decoded.text }] : []),
      ...decoded.images,
    ];
  }
  return [{ type: 'text', text: CANCEL_TEXT }];
}

export async function completeAskUser(
  session: CompleteAskUserSession,
  input: CompleteAskUserInput,
): Promise<'ok' | 'duplicate'> {
  if (session.isStreaming) {
    throw new Error('ask_user completion requires an idle session');
  }

  const alreadyHas = session.messages.some(
    (msg) => msg.role === 'toolResult' && msg.toolCallId === input.toolCallId,
  );
  if (alreadyHas) {
    const last = session.agent.state.messages.at(-1) as { role?: unknown; toolCallId?: unknown } | undefined;
    if (last?.role === 'toolResult' && last.toolCallId === input.toolCallId) {
      await session.agent.continue();
      return 'ok';
    }
    return 'duplicate';
  }

  const pending = findPendingAskUser(session.messages);
  if (!pending || pending.toolCallId !== input.toolCallId) {
    throw new Error('ask_user tool call is not pending');
  }

  const message = {
    role: 'toolResult' as const,
    toolCallId: input.toolCallId,
    toolName: 'ask_user',
    content: buildContent(input),
    isError: false,
    timestamp: Date.now(),
  };

  session.sessionManager.appendMessage(message);
  session.agent.state.messages.push(message);
  await session.agent.continue();
  return 'ok';
}

/**
 * 补写已成功（含 duplicate）后删草稿。删除失败只记日志，仍返回原结果，
 * 避免前端把已成功的补写当成失败、浮层卡住后再点一次 continue。
 */
export async function finishCompleteAskUser(
  result: 'ok' | 'duplicate',
  deleteDraft: () => Promise<void>,
  logError: (err: unknown) => void = (err) => {
    console.error('[ask_user] draft delete failed after complete', err);
  },
): Promise<'ok' | 'duplicate'> {
  try {
    await deleteDraft();
  } catch (err) {
    logError(err);
  }
  return result;
}
