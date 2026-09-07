import { parseAttachments } from '../chat/attachment';
import type { DisplayMessage } from '../chat/groupMessages';

/** 少于这个条数的对话不值得开地图（rail 比正文还短，纯干扰）。 */
export const MIN_MESSAGES_THRESHOLD = 3;

/**
 * 刻度长度按「突出程度」分级：0 是默认统一长度，悬停的那条取最高级，
 * 向两侧每隔一条降一级，形成中间最长、两边渐短的鼓包。
 */
const WIDTH_BY_EMPHASIS = [8, 13, 18, 24] as const;
export const MAX_EMPHASIS = WIDTH_BY_EMPHASIS.length - 1;
export const MAX_INDICATOR_WIDTH: number = WIDTH_BY_EMPHASIS[MAX_EMPHASIS];
/** 每条刻度占的高度（含上下留白），rail 跟随时据此把位置换算成像素。 */
export const INDICATOR_PITCH = 10;

const TITLE_MAX_LENGTH = 60;
const REPLY_MAX_LENGTH = 140;
/** 提取回复摘要时最多读这么多原文，够截出 REPLY_MAX_LENGTH 即可，避免长回复反复走正则。 */
const REPLY_RAW_BUDGET = REPLY_MAX_LENGTH * 4;

/**
 * 消息正文压成单行纯文本。
 *
 * 先用 parseAttachments 剥掉 <pi:attachment> 块——粘贴的长文本与拖入的文件动辄上千字，
 * 留着预览里全是文件内容；再抹掉 markdown 标记只留可读文字。够预览用即可，不追求严格解析。
 */
export function toPlainText(content: string | undefined): string {
  if (!content) return '';

  const body = parseAttachments(content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ');

  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([*+-]|\d+\.)\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/** 气泡标题：用户消息正文压成一行并截断。 */
export function getTitleText(content: string | undefined): string {
  return truncate(toPlainText(content), TITLE_MAX_LENGTH);
}

/**
 * 气泡正文：紧随该用户消息的助手回复摘要。
 * 只取 turn 里的正文段（跳过推理与工具调用）和 agent-answer 通知，遇到下一条用户消息即停。
 */
export function getReplyText(messages: DisplayMessage[], userIndex: number): string {
  const parts: string[] = [];
  let collected = 0;

  for (let i = userIndex + 1; i < messages.length && collected < REPLY_RAW_BUDGET; i++) {
    const msg = messages[i];
    if (msg.kind === 'user') break;

    if (msg.kind === 'turn') {
      for (const segment of msg.segments) {
        if (segment.kind !== 'text') continue;
        parts.push(segment.content);
        collected += segment.content.length;
      }
    } else if (msg.kind === 'notice' && msg.customType === 'agent-answer') {
      parts.push(msg.content);
      collected += msg.content.length;
    }
  }

  return truncate(toPlainText(parts.join(' ').slice(0, REPLY_RAW_BUDGET)), REPLY_MAX_LENGTH);
}

/**
 * 视口顶部位置落在哪条刻度上：listIndex 不超过 scrollPosition 的最后一条（二分查找）。
 * 视口多半停在助手回复上，它们没有自己的刻度，这样就归到「开启这一轮的那条用户消息」。
 * 还没滚到第一条用户消息时返回 -1。
 */
export function findIndicatorPosition(
  indicators: readonly { listIndex: number }[],
  scrollPosition: number,
): number {
  let low = 0;
  let high = indicators.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (indicators[mid].listIndex <= scrollPosition) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * 把视口位置换算成刻度序列上的小数位置：视口顶部落在第 p 条与第 p+1 条刻度之间时，
 * 按两条用户消息之间的**像素**距离插值。用像素而不是条目数，是为了让 rail 的速度与正文滚动
 * 严格成正比——否则滚过 50px 的短问句和滚过 400px 的长回复会走出同样的距离，忽快忽慢。
 */
export function getFractionalPosition(
  indicators: readonly { listIndex: number }[],
  topIndex: number,
  scrollOffset: number,
  getItemOffset: (listIndex: number) => number,
): number {
  const last = indicators.length - 1;
  const position = findIndicatorPosition(indicators, topIndex);
  if (position < 0) return 0;
  if (position >= last) return Math.max(last, 0);
  const start = getItemOffset(indicators[position].listIndex);
  const end = getItemOffset(indicators[position + 1].listIndex);
  if (end <= start) return position;
  const within = Math.min(Math.max((scrollOffset - start) / (end - start), 0), 1);
  return position + within;
}

/** rail 跟随的目标 scrollTop：让当前（小数）刻度落在 rail 中线，两端夹紧到可滚范围内。 */
export function getRailScrollTop(
  fractionalPosition: number,
  railClientHeight: number,
  railScrollHeight: number,
): number {
  const centered = (fractionalPosition + 0.5) * INDICATOR_PITCH - railClientHeight / 2;
  const maxTop = Math.max(0, railScrollHeight - railClientHeight);
  return Math.min(Math.max(0, centered), maxTop);
}

/** 突出程度：与悬停刻度的距离越近越高；没有悬停时全部为 0。 */
export function getEmphasis(position: number, hoveredPosition: number | null): number {
  if (hoveredPosition === null) return 0;
  return Math.max(0, MAX_EMPHASIS - Math.abs(position - hoveredPosition));
}

export function getIndicatorWidth(emphasis: number): number {
  return WIDTH_BY_EMPHASIS[Math.min(Math.max(emphasis, 0), MAX_EMPHASIS)];
}
