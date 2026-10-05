import type { ChatMessage, UserImage } from '../../stores/agentReducer';
import { createComposerItem, type ComposerQueuedItem } from './input/composerQueue';

export interface AbortedSteerSend {
  text: string;
  images?: UserImage[];
  /** 会话里已经有这条气泡，发送时不要再插一条。 */
  alreadyShown: boolean;
}

export interface AbortedSteerPlan {
  messages: ChatMessage[];
  composerQueue: ComposerQueuedItem[];
  send: AbortedSteerSend | null;
}

/**
 * 人为暂停后，尚未注入当前回合的引导：第一条作为新消息发出，其余回到输入区排队。
 * `queuedSteers` 是暂停后 Pi 仍握着的引导正文，按排队顺序。
 */
export function settleAbortedSteers(
  messages: ChatMessage[],
  composerQueue: ComposerQueuedItem[],
  queuedSteers: readonly string[],
): AbortedSteerPlan {
  const pending = queuedSteers.map((text) => text.trim()).filter(Boolean);
  if (pending.length === 0) return { messages, composerQueue, send: null };

  const claimed = new Set<number>();
  const matched = pending.map((text) => {
    const index = messages.findIndex((message, i) =>
      !claimed.has(i)
      && message.kind === 'user'
      && message.steering
      && message.steerState !== 'consumed'
      && message.text === text,
    );
    if (index < 0) return -1;
    claimed.add(index);
    return index;
  });

  const firstIndex = matched[0] ?? -1;
  const first = firstIndex >= 0 ? messages[firstIndex] : undefined;
  const drop = new Set(matched.slice(1).filter((index) => index >= 0));
  const nextMessages = messages.flatMap((message, index) => {
    if (drop.has(index)) return [];
    if (index === firstIndex && message.kind === 'user') {
      const { steering: _steering, steerState: _steerState, ...plain } = message;
      return [plain];
    }
    return [message];
  });

  const queued = pending.slice(1).map((text, offset) => {
    const index = matched[offset + 1] ?? -1;
    const message = index >= 0 ? messages[index] : undefined;
    const images = message && message.kind === 'user' ? message.images : undefined;
    return createComposerItem(text, images);
  });

  return {
    messages: nextMessages,
    composerQueue: [...queued, ...composerQueue],
    send: {
      text: pending[0]!,
      images: first && first.kind === 'user' ? first.images : undefined,
      alreadyShown: firstIndex >= 0,
    },
  };
}
