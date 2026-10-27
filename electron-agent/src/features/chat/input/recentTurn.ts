import type { ChatMessage } from '../../../stores/agentReducer';

/** 与主进程单次工具结果上限一致。 */
export const RECENT_TURN_MAX_CHARS = 4000;

/**
 * 当前会话最近一轮看得见的文字：最近一条有正文的助手消息，以及它前面最近一条用户消息。
 * 不含思考和工具卡。被移出上下文的消息不取。没有助手正文时返回空串，调用方写成「没有更早的对话」。
 */
export function formatRecentTurn(messages: readonly ChatMessage[], excluded: ReadonlySet<number>): string {
  const visible = messages.filter((message) => message.timestamp == null || !excluded.has(message.timestamp));
  let assistantAt = -1;
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const message = visible[index];
    if (message.kind === 'assistant' && message.text.trim()) {
      assistantAt = index;
      break;
    }
  }
  if (assistantAt < 0) return '';
  let userText = '';
  for (let index = assistantAt - 1; index >= 0; index -= 1) {
    const message = visible[index];
    if (message.kind === 'user' && message.text.trim()) {
      userText = message.text.trim();
      break;
    }
  }
  const assistantText = (visible[assistantAt] as Extract<ChatMessage, { kind: 'assistant' }>).text.trim();
  const body = [userText ? `用户：\n${userText}` : '', `助手：\n${assistantText}`].filter(Boolean).join('\n\n');
  const mark = '…（已截断）';
  if (body.length <= RECENT_TURN_MAX_CHARS) return body;
  return `${body.slice(0, RECENT_TURN_MAX_CHARS - mark.length)}${mark}`;
}
