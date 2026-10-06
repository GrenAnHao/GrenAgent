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
  // canMerge：下一条保留下来的 assistant 能不能并进上一条 assistant。
  // 任何 user 段（哪怕被 shouldExtract 过滤掉，如 /compact）都会断开合并；保留下来的 assistant 段重新放开；
  // 被过滤的 assistant 段（如纯代码块）和 toolResult / custom 等非对话段不改变它，
  // 因此同一轮里被工具输出隔开的 assistant 仍合并，而被 user 命令隔开的不会借道被过滤的 assistant 合并。
  let canMerge = false;
  for (const segment of splitTranscript(text)) {
    if (segment.role !== 'user' && segment.role !== 'assistant') continue;
    const role: Role = segment.role;
    if (role === 'user') canMerge = false;
    const content = cleanContent(role, segment.content);
    if (!shouldExtract(content)) continue;
    const last = turns.at(-1);
    if (role === 'assistant' && canMerge && last?.role === 'assistant') {
      last.content = `${last.content}\n\n${content}`;
      continue;
    }
    turns.push({ role, content });
    if (role === 'assistant') canMerge = true;
  }
  return turns.map((turn) => ({ ...turn, content: cap(turn.content) }));
}

/** 背景只要尾部几条，先解析末尾这么多字符；凑不够就每次放大 4 倍，直到整段。 */
const TAIL_WINDOW_CHARS = 64 * 1024;
const TAIL_WINDOW_GROWTH = 4;

/** 从 from 起（含）第一个角色行的开头；`^` 看的是整段文本里的真实行首，不会把行中间当成行首。 */
function roleLineIndexFrom(text: string, from: number): number {
  const pattern = new RegExp(ROLE_LINE);
  pattern.lastIndex = from;
  return pattern.exec(text)?.index ?? -1;
}

/**
 * 等价于 `conversationTurns(text).slice(-count)`，但只解析末尾一段。background 是整段更早的会话，可达 MB 级，
 * 全量切分清洗只为留最后几条，在主进程里是白花的同步开销。
 *
 * 窗口从角色行开头切，窗口里的分段就是全量解析的后半段，逐段相同。唯一的差别在窗口的第一条：全量解析里它
 * 可能已经和窗口之前的 assistant 段合并过，窗口里只看得到后半截。所以要拿到多于 count 条才能确定最后 count 条
 * 和全量一致；窗口放大到整段时前面没有别的内容，直接返回。
 */
export function tailConversationTurns(text: string, count: number, windowChars = TAIL_WINDOW_CHARS): ConversationTurn[] {
  if (count <= 0) return [];
  let size = Math.max(1, windowChars);
  for (;;) {
    const from = text.length - size;
    if (from <= 0) return conversationTurns(text).slice(-count);
    const cut = roleLineIndexFrom(text, from);
    if (cut >= 0) {
      const turns = conversationTurns(text.slice(cut));
      if (turns.length > count) return turns.slice(-count);
    }
    size *= TAIL_WINDOW_GROWTH;
  }
}

/**
 * 上游把一批里最后 10 条当新消息、再往前 5 条当背景（l1-extractor.ts:177-182）。Pi 的 background 是同一
 * 会话里更早、已经抽过的文本，所以背景候选是「background 的消息 + delta 里没进窗口的消息」。
 * 窗口外更早的 delta 消息不再单独抽取，提交游标时一并视为已处理，和上游一致。
 *
 * background 可以是取值函数：delta 里没有可抽取的对话（调用方会直接跳过），或 delta 自己已经填满背景时，
 * 不会去取，更不会解析历史。
 */
export function buildExtractionWindow(delta: string, background: string | (() => string), now = Date.now()): ExtractionWindow {
  const fresh = conversationTurns(delta);
  if (fresh.length === 0) return { newMessages: [], backgroundMessages: [] };
  const newTurns = fresh.slice(-MAX_NEW_MESSAGES);
  const overflow = fresh.slice(0, fresh.length - newTurns.length);
  const missing = MAX_BACKGROUND_MESSAGES - overflow.length;
  const earlier = missing > 0 ? tailConversationTurns(typeof background === 'function' ? background() : background, missing) : [];
  const backgroundTurns = [...earlier, ...overflow].slice(-MAX_BACKGROUND_MESSAGES);
  const stamp = (prefix: string, list: ConversationTurn[], offset: number): ConversationMessage[] =>
    list.map((turn, index) => ({ id: `${prefix}${index}`, role: turn.role, content: turn.content, timestamp: now + (offset + index) * 1000 }));
  return {
    backgroundMessages: stamp('b', backgroundTurns, 0),
    newMessages: stamp('m', newTurns, backgroundTurns.length),
  };
}
