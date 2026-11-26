import type { TextContent, ImageContent, ToolResultMessage } from '@earendil-works/pi-ai';
import {
  findAskUserCallOwner,
  findPendingAskUser,
  isDeadAssistantTurn,
} from '../../src/features/chat/pendingAskUser';
import { decodeAskUserAnswer } from '../../../extensions/agent-mode/questions.js';
import { bindVisualReview, restoreVisualReviews, settleVisualReview } from '../../../extensions/visual-companion/reviewRegistry.js';

const CANCEL_TEXT = '用户取消了 ask_user 选择（未作答）。';
const RELAY_PREFIX = '（上一轮已中断，这是我在那张提问卡上的选择）\n';

export interface CompleteAskUserSession {
  isStreaming: boolean;
  messages: Array<{ role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; details?: unknown }>;
  sessionManager: { appendMessage: (message: ToolResultMessage) => unknown; getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined };
  agent: {
    state: { messages: unknown[] };
    continue: () => Promise<unknown>;
  };
  /** 走 pi 自己的用户输入通道：落盘、发事件、起回合，界面上能立刻看到这条用户消息。 */
  prompt: (
    text: string,
    options?: { images?: ImageContent[]; expandPromptTemplates?: boolean },
  ) => Promise<unknown>;
}

export interface CompleteAskUserInput {
  toolCallId: string;
  value?: string;
  cancelled?: boolean;
}

type ContentBlock = TextContent | ImageContent;

function answerBlocks(input: CompleteAskUserInput): ContentBlock[] | null {
  if (input.cancelled) return null;
  const decoded = decodeAskUserAnswer(input.value);
  if (!decoded.text.trim() && decoded.images.length === 0) return null;
  return [
    ...(decoded.text.trim() ? [{ type: 'text' as const, text: decoded.text }] : []),
    ...decoded.images,
  ];
}

function buildContent(input: CompleteAskUserInput): ContentBlock[] {
  return answerBlocks(input) ?? [{ type: 'text', text: CANCEL_TEXT }];
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

  const owner = findAskUserCallOwner(session.messages, input.toolCallId);
  if (!owner) {
    throw new Error('ask_user tool call is not pending');
  }

  // 发起这次调用的回合已经中断 / 出错：pi-ai 发请求前会丢掉那条 assistant 消息，这里再补
  // toolResult 就成了孤儿 tool_result，整个会话从此 400。改走用户消息把答案转达给模型。
  if (isDeadAssistantTurn(owner.message)) {
    if ((owner.call.args.visualReview as { previewId?: unknown } | undefined)?.previewId && !input.cancelled) {
      throw new Error('VISUAL_REVIEW_INTERRUPTED: 原评审回合已中断，请重新发起 ask_user 评审');
    }
    return relayAnswerFromDeadTurn(session, input);
  }

  const pending = findPendingAskUser(session.messages);
  if (!pending || pending.toolCallId !== input.toolCallId) {
    throw new Error('ask_user tool call is not pending');
  }

  const previewId = (owner.call.args.visualReview as { previewId?: unknown } | undefined)?.previewId;
  let review: { previewId: string; requestId: string; outcome: 'approved' | 'redo' | 'cancelled' } | undefined;
  let reviewOwner = '';
  if (typeof previewId === 'string') {
    reviewOwner = session.sessionManager.getSessionFile?.() || session.sessionManager.getSessionId?.() || '';
    if (!reviewOwner) throw new Error('VISUAL_REVIEW_OWNER: 无法验证原会话');
    restoreVisualReviews(reviewOwner, session.messages.flatMap((msg) =>
      msg.role === 'toolResult' && typeof msg.toolName === 'string'
        ? [{ toolName: msg.toolName, details: msg.details }] : [],
    ));
    bindVisualReview(reviewOwner, previewId, input.toolCallId);
    const decoded = decodeAskUserAnswer(input.value);
    const outcome = input.cancelled || decoded.review?.previewId !== previewId ? 'cancelled' : decoded.review.outcome;
    // Partial text or images cannot approve a closed review question.
    if (!input.cancelled && outcome === 'cancelled') throw new Error('VISUAL_REVIEW_INVALID: 缺少有效的通过或打回选项');
    // appendMessage is the commit point: a failed disk write must leave this preview retryable.
    review = { previewId, requestId: input.toolCallId, outcome };
  }

  const message = {
    role: 'toolResult' as const,
    toolCallId: input.toolCallId,
    toolName: 'ask_user',
    content: buildContent(input),
    isError: false,
    ...(review ? { details: { review } } : {}),
    timestamp: Date.now(),
  };

  session.sessionManager.appendMessage(message);
  if (review) settleVisualReview(reviewOwner, review.previewId, review.requestId, review.outcome);
  session.agent.state.messages.push(message);
  await session.agent.continue();
  return 'ok';
}

/**
 * 中断回合里的提问卡：作答转成一条 user 消息（模型看不到卡片原文，但看得到选了什么），
 * 取消就只收卡片——不写历史、不发请求。
 */
async function relayAnswerFromDeadTurn(
  session: CompleteAskUserSession,
  input: CompleteAskUserInput,
): Promise<'ok'> {
  const blocks = answerBlocks(input);
  if (!blocks) return 'ok';

  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const images = blocks.filter((block) => block.type === 'image');

  await session.prompt(`${RELAY_PREFIX}${text}`.trimEnd(), {
    images,
    expandPromptTemplates: false,
  });
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
    void deleteDraft().catch(logError);
  } catch (err) {
    logError(err);
  }
  return result;
}
