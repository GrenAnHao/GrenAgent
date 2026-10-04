// 按压力裁旧工具结果：缓存冷时定案（planPressurePrune），热时把同一份计划原样重放（applyPrunePlan）。
// 只改发往模型的副本，不原地修改消息对象。计划按 toolCallId 认消息：context 钩子每次拿到的是新克隆。
import { isCacheCold } from "./cache-warmth.js";
import { classify } from "./pressure.js";
import { textLength } from "./prune.js";

export const RECENT_KEEP_CHARS = 160_000;
export const SOFT_TRIM_MIN_CHARS = 4096;
export const SOFT_TRIM_HEAD = 1536;
export const SOFT_TRIM_TAIL = 1536;
export const HARD_PRUNE_MIN_SAVINGS = 80_000;

export type PruneMode = "soft" | "replace";
export type PrunePlan = ReadonlyMap<string, PruneMode>;

export type PruneMessageLike = {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
};

type TextBlock = { type: "text"; text: string };

const isTextBlock = (c: unknown): c is TextBlock =>
  !!c &&
  typeof c === "object" &&
  (c as { type?: unknown }).type === "text" &&
  typeof (c as { text?: unknown }).text === "string";

function joinedText(content: unknown): string {
  return Array.isArray(content) ? content.filter(isTextBlock).map((c) => c.text).join("\n") : "";
}

function nonTextBlocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content.filter((c) => !isTextBlock(c)) : [];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** 前 1536、后 1536 个 UTF-16 码元，中间一行说明。调用方保证 text.length > SOFT_TRIM_MIN_CHARS。 */
export function softTrimText(text: string): string {
  let head = text.slice(0, SOFT_TRIM_HEAD);
  if (head.length > 0 && isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
  let tail = text.slice(text.length - SOFT_TRIM_TAIL);
  if (tail.length > 0 && isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1);
  const removed = text.length - head.length - tail.length;
  return `${head}\n[... trimmed, removed ${removed} chars ...]\n${tail}`;
}

export function prunePlaceholder(toolName: string | undefined, chars: number): string {
  return `[pruned tool output: ${toolName || "tool"}, ${chars} chars]`;
}

function readPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const { path, file_path } = args as { path?: unknown; file_path?: unknown };
  if (typeof path === "string") return path;
  return typeof file_path === "string" ? file_path : "";
}

/** 助手消息里直接读 SKILL.md 的 read 调用 id。codemode 嵌套调用不在这里。 */
export function skillReadCallIds(messages: readonly PruneMessageLike[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const c of m.content as Array<{ type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }>) {
      if (c?.type !== "toolCall" || c.name !== "read" || typeof c.id !== "string") continue;
      if (readPath(c.arguments).split(/[\\/]/).pop() === "SKILL.md") ids.add(c.id);
    }
  }
  return ids;
}

export interface PlanOptions {
  level: 0 | 1 | 2 | 3;
  keepRecentTurns: number;
  minBodyChars: number;
}

export function planPressurePrune(messages: readonly PruneMessageLike[], opts: PlanOptions): Map<string, PruneMode> {
  const plan = new Map<string, PruneMode>();
  if (opts.level === 0) return plan;
  const userIdxs: number[] = [];
  messages.forEach((m, i) => {
    if (m?.role === "user") userIdxs.push(i);
  });
  if (userIdxs.length <= opts.keepRecentTurns) return plan;
  const protectFrom = userIdxs[userIdxs.length - opts.keepRecentTurns];
  const skills = skillReadCallIds(messages);
  const candidates: Array<{ id: string; len: number; toolName?: string }> = [];
  let recent = 0;
  for (let i = protectFrom - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
    if (skills.has(m.toolCallId)) continue;
    const len = textLength(m.content);
    recent += len;
    if (recent <= RECENT_KEEP_CHARS) continue;
    candidates.push({ id: m.toolCallId, len, toolName: m.toolName });
  }
  if (opts.level >= 2) {
    const whole = candidates.filter((c) => c.len >= opts.minBodyChars);
    const savings = whole.reduce((n, c) => n + c.len - prunePlaceholder(c.toolName, c.len).length, 0);
    if (savings >= HARD_PRUNE_MIN_SAVINGS) {
      for (const c of whole) plan.set(c.id, "replace");
      return plan;
    }
  }
  for (const c of candidates) if (c.len > SOFT_TRIM_MIN_CHARS) plan.set(c.id, "soft");
  return plan;
}

export interface ApplyResult<T> {
  messages: T[];
  savedChars: number;
  applied: number;
}

export function applyPrunePlan<T extends PruneMessageLike>(messages: T[], plan: PrunePlan): ApplyResult<T> {
  if (plan.size === 0) return { messages, savedChars: 0, applied: 0 };
  let savedChars = 0;
  let applied = 0;
  const out = messages.map((m) => {
    if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") return m;
    const mode = plan.get(m.toolCallId);
    if (mode === "replace") {
      const len = textLength(m.content);
      const text = prunePlaceholder(m.toolName, len);
      savedChars += Math.max(0, len - text.length);
      applied++;
      return { ...m, content: [{ type: "text", text }] } as T;
    }
    if (mode === "soft") {
      const joined = joinedText(m.content);
      if (joined.length <= SOFT_TRIM_MIN_CHARS) return m;
      const text = softTrimText(joined);
      savedChars += joined.length - text.length;
      applied++;
      return { ...m, content: [{ type: "text", text }, ...nonTextBlocks(m.content)] } as T;
    }
    return m;
  });
  return { messages: applied ? out : messages, savedChars, applied };
}

export interface ContextUsageLike {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

/** 把上一次请求省下的字符按 4 字符约 1 token 折回，得到未裁时的占用百分比。 */
export function unprunedPercent(usage: ContextUsageLike | undefined, savedChars: number): number | null {
  const percent = usage?.percent;
  if (percent == null || !Number.isFinite(percent)) return null;
  const contextWindow = usage?.contextWindow ?? 0;
  if (!(contextWindow > 0) || !(savedChars > 0)) return percent;
  return percent + (savedChars / 4 / contextWindow) * 100;
}

export interface PruneState {
  plan: PrunePlan;
  /** 上一次请求按计划省下的字符数。 */
  savedChars: number;
}

export const emptyPruneState = (): PruneState => ({ plan: new Map(), savedChars: 0 });

export interface PressurePruneInput<T> {
  messages: T[];
  now: number;
  lastActivity: number | undefined;
  ttlMs: number;
  usage: ContextUsageLike | undefined;
  keepRecentTurns: number;
  minBodyChars: number;
}

/** 冷：按未裁占用重新定案；热：沿用已有计划。返回本次要发的消息和新状态。 */
export function runPressurePrune<T extends PruneMessageLike>(
  state: PruneState,
  input: PressurePruneInput<T>,
): { messages: T[]; state: PruneState } {
  let plan = state.plan;
  if (isCacheCold(input.now, input.lastActivity, input.ttlMs)) {
    const percent = unprunedPercent(input.usage, state.savedChars);
    const level = percent == null ? 0 : classify(percent).level;
    plan = planPressurePrune(input.messages, {
      level,
      keepRecentTurns: input.keepRecentTurns,
      minBodyChars: input.minBodyChars,
    });
  }
  const res = applyPrunePlan(input.messages, plan);
  return { messages: res.messages, state: { plan, savedChars: res.savedChars } };
}
