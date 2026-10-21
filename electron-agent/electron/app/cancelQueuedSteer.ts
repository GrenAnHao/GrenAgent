/**
 * 撤下一条还在排队、没注入当前回合的引导。
 *
 * pi 的 AgentSession 只有整体 `clearQueue()`，没有撤单条的公开接口。这里优先直接从两份队列里摘掉那一条：
 * `agent.steeringQueue.messages`（真正会注入的消息，带图片）和 `_steeringMessages`（queue_update 用的正文）。
 * 这样其余引导保持原样（图片、顺序、时间戳都不动，也不会再跑一遍输入处理）。
 * 拿不到这两份内部队列（pi 换了实现）时退回公开接口：清空后把其余引导和跟进按正文重新排回去。
 *
 * 只认 agent 队列：它已经被取走、还没发 message_start 时，`_steeringMessages` 里仍有这条，
 * 但它已经在注入的路上，撤不回来，返回 cancelled: false。
 */

type QueuedUserMessage = { role?: unknown; content?: unknown };

export interface SteerQueueSession {
  clearQueue(): { steering: string[]; followUp: string[] };
  steer(text: string): Promise<unknown> | unknown;
  followUp(text: string): Promise<unknown> | unknown;
  getSteeringMessages?(): readonly string[];
}

export interface CancelSteerOptions {
  /** 正文对不上时（模板 / 技能展开后正文变了），界面只有这一条未注入的引导：队列里也只剩一条就撤它。 */
  allowSole?: boolean;
}

interface SteerInternals {
  steeringTexts: string[];
  agentQueue: QueuedUserMessage[];
  emit: () => void;
}

function readInternals(session: SteerQueueSession): SteerInternals | null {
  const raw = session as unknown as {
    _steeringMessages?: unknown;
    _emitQueueUpdate?: unknown;
    agent?: { steeringQueue?: { messages?: unknown } };
  };
  const steeringTexts = raw._steeringMessages;
  const agentQueue = raw.agent?.steeringQueue?.messages;
  const emit = raw._emitQueueUpdate;
  if (!Array.isArray(steeringTexts) || !Array.isArray(agentQueue) || typeof emit !== 'function') return null;
  return {
    steeringTexts: steeringTexts as string[],
    agentQueue: agentQueue as QueuedUserMessage[],
    emit: () => (emit as () => void).call(session),
  };
}

function messageText(message: QueuedUserMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      Boolean(part) && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('');
}

function pickIndex(texts: readonly string[], text: string, allowSole: boolean): number {
  const exact = texts.indexOf(text);
  if (exact >= 0) return exact;
  const trimmed = text.trim();
  const loose = texts.findIndex((item) => item.trim() === trimmed);
  if (loose >= 0) return loose;
  return allowSole && texts.length === 1 ? 0 : -1;
}

export async function cancelQueuedSteer(
  session: SteerQueueSession,
  text: string,
  options: CancelSteerOptions = {},
): Promise<{ cancelled: boolean }> {
  const allowSole = options.allowSole === true;
  const internals = readInternals(session);
  if (internals) {
    const index = pickIndex(internals.agentQueue.map(messageText), text, allowSole);
    if (index < 0) return { cancelled: false };
    const [removed] = internals.agentQueue.splice(index, 1);
    const removedText = removed ? messageText(removed) : text;
    const textIndex = internals.steeringTexts.indexOf(removedText);
    if (textIndex >= 0) internals.steeringTexts.splice(textIndex, 1);
    internals.emit();
    return { cancelled: true };
  }

  const pending = session.getSteeringMessages?.() ?? [];
  const index = pickIndex(pending, text, allowSole);
  if (index < 0) return { cancelled: false };
  const restored = session.clearQueue();
  const target = restored.steering[index];
  let skipped = false;
  for (const item of restored.steering) {
    if (!skipped && item === target) {
      skipped = true;
      continue;
    }
    await session.steer(item);
  }
  for (const item of restored.followUp) await session.followUp(item);
  return { cancelled: skipped };
}
