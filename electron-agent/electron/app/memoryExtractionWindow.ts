import { stripTrailingNewlines, type ConversationMessage } from '../agent/memoryPrompts';

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

/**
 * extensions/_shared/transcript.ts 的 messageToText 写成 `role: text`，role 来自 pi 的 AgentMessage。
 *
 * 限制：扁平文本无法区分「角色行」和「正文里恰好以 `user: ` / `assistant: ` 开头的行」
 * （例如工具输出 cat 出来的示例对话），后者会被误切成新消息。这是 transcript 格式本身的
 * 歧义，旧的 messagesFromTranscript 也一样。彻底解决需要 sidecar 传结构化消息。
 */
const ROLE_LINE = /^(user|assistant|toolResult|custom|bashExecution|branchSummary|compactionSummary): /gm;

export function splitTranscript(text: string): TranscriptSegment[] {
  const matches = [...text.matchAll(ROLE_LINE)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    return { role: match[1], content: stripTrailingNewlines(text.slice(start, end)) };
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
  // 只把「斜杠命令形态」当命令：单行、不超过 64 字、`/` 后紧跟命令名再以空白或结尾断开。
  // 否则 `/api/v1/foo 报错了` 这类以路径开头的正文会被误丢。
  if (!text.includes('\n') && text.length <= 64 && /^\/[\w:-]+(\s|$)/.test(text)) return false;
  // \w 只认 ASCII，用 Unicode 属性类避免把 Cyrillic / CJK 等纯文字误判成符号。
  if (/^[^\p{L}\p{N}\s]{1,5}$/u.test(text)) return false;
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
  // 记录上一个 user/assistant 段的原始角色（不论它是否被 shouldExtract 过滤掉）。
  // 只有上一个对话段也是 assistant 时才合并，被过滤掉的 user 段（如 /compact）要断开合并；
  // toolResult / custom 等非 user/assistant 段不参与判断，因此同一轮里被工具输出隔开的 assistant 仍合并。
  let prevDialogRole: Role | null = null;
  for (const segment of splitTranscript(text)) {
    if (segment.role !== 'user' && segment.role !== 'assistant') continue;
    const role: Role = segment.role;
    const content = cleanContent(role, segment.content);
    const keep = shouldExtract(content);
    const previousDialogRole = prevDialogRole;
    prevDialogRole = role;
    if (!keep) continue;
    const last = turns.at(-1);
    if (role === 'assistant' && previousDialogRole === 'assistant' && last?.role === 'assistant') {
      last.content = `${last.content}\n\n${content}`;
      continue;
    }
    turns.push({ role, content });
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
