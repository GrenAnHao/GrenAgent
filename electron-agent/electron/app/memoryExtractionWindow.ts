import type { ConversationMessage } from '../agent/memoryPrompts';

/** 上游 core/record/l1-extractor.ts:149-150 的默认值。 */
export const MAX_NEW_MESSAGES = 10;
export const MAX_BACKGROUND_MESSAGES = 5;
/**
 * Pi 偏离：上游不截单条。Pi 的 assistant 回复经常是长报告，合并同一轮的多段文本后一条就可能上万字，
 * 不截的话批量上限就形同虚设。
 */
export const MAX_MESSAGE_CHARS = 4000;
const TRUNCATED = '…（已截断）';

type Role = 'user' | 'assistant';
export interface TranscriptSegment { role: string; content: string }
export interface ConversationTurn { role: Role; content: string }
export interface ExtractionWindow { newMessages: ConversationMessage[]; backgroundMessages: ConversationMessage[] }

/** extensions/_shared/transcript.ts 的 messageToText 写成 `role: text`，role 来自 pi 的 AgentMessage。 */
const ROLE_LINE = /^(user|assistant|toolResult|custom|bashExecution|branchSummary|compactionSummary): /gm;

export function splitTranscript(text: string): TranscriptSegment[] {
  const matches = [...text.matchAll(ROLE_LINE)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    return { role: match[1], content: text.slice(start, end).replace(/\n+$/, '') };
  });
}

/** 上游 sanitizeText 里与 Pi 相关的部分（去内联图片、压空行）加 stripCodeBlocks（只对 assistant）。 */
function cleanContent(role: Role, content: string): string {
  let text = content.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, '');
  if (role === 'assistant') text = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  return text.replace(/\0/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 移植自上游 shouldExtractL1（utils/sanitize.ts:135-156）；OpenClaw 专有的框架噪声过滤不适用于 Pi，未移植。 */
export function shouldExtract(text: string): boolean {
  if (!text.trim()) return false;
  if (text.startsWith('/')) return false;
  if (/^[^\w\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{1,5}$/.test(text)) return false;
  if (/^[?？]+$/.test(text)) return false;
  return true;
}

function cap(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}${TRUNCATED}` : text;
}

/**
 * 只留 user / assistant 文本（上游 extractUserAssistantMessages）。工具输出被丢掉以后，同一轮里被工具调用
 * 隔开的 assistant 文本是连续的，合成一条，相当于「一轮一条回复」，和上游的消息粒度一致。
 */
export function conversationTurns(text: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const segment of splitTranscript(text)) {
    if (segment.role !== 'user' && segment.role !== 'assistant') continue;
    const content = cleanContent(segment.role, segment.content);
    if (!shouldExtract(content)) continue;
    const last = turns.at(-1);
    if (last && last.role === 'assistant' && segment.role === 'assistant') {
      last.content = `${last.content}\n\n${content}`;
      continue;
    }
    turns.push({ role: segment.role, content });
  }
  return turns.map((turn) => ({ ...turn, content: cap(turn.content) }));
}

/**
 * 上游把一批里最后 10 条当新消息、再往前 5 条当背景（l1-extractor.ts:177-182）。Pi 的 background 是同一
 * 会话里更早、已经抽过的文本，所以背景候选是「background 的消息 + delta 里没进窗口的消息」。
 * 窗口外更早的 delta 消息不再单独抽取，提交游标时一并视为已处理，和上游一致。
 */
export function buildExtractionWindow(delta: string, background: string, now = Date.now()): ExtractionWindow {
  const fresh = conversationTurns(delta);
  const newTurns = fresh.slice(-MAX_NEW_MESSAGES);
  const before = [...conversationTurns(background), ...fresh.slice(0, fresh.length - newTurns.length)];
  const backgroundTurns = before.slice(-MAX_BACKGROUND_MESSAGES);
  const stamp = (prefix: string, list: ConversationTurn[], offset: number): ConversationMessage[] =>
    list.map((turn, index) => ({ id: `${prefix}${index}`, role: turn.role, content: turn.content, timestamp: now + (offset + index) * 1000 }));
  return {
    backgroundMessages: stamp('b', backgroundTurns, 0),
    newMessages: stamp('m', newTurns, backgroundTurns.length),
  };
}
