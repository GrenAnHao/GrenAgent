// 相同工具调用链。对齐 deepseek-harness 的 repeat-tool-reminder：
// 只认「工具名 + 规范化参数」完全相同的连续次数，到阈值才提醒，超过最高阈值后沉默。
// 不拦截调用，也不统计单轮总次数。

export class RepeatGuardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepeatGuardConfigError";
  }
}

export interface RepeatGuardConfig {
  /** 升序、去重后的提醒次数。第一档用轻提醒，其后用详细提醒。 */
  thresholds: number[];
  /** 空表示跟踪全部工具。条目是 `*` 通配。 */
  include: string[];
  /** 这些工具对链透明：既不计数，也不把连续计数清零。 */
  exclude: string[];
  /** 详细提醒里参数预览的字符上限。检测仍比较完整规范化串。 */
  argumentsPreviewChars: number;
}

export interface Chain {
  key: string;
  count: number;
}

const DEFAULT_THRESHOLDS = [3, 5, 8];
const DEFAULT_PREVIEW_CHARS = 500;

const GENTLE_REMINDER =
  "你正在用完全相同的参数重复调用同一个工具。再次调用前先仔细分析上一次的结果：" +
  "如果任务还没完成，换一种做法或换一组参数，不要原样再调一次。";

export function parseRepeatGuardConfig(raw: {
  thresholds?: string;
  include?: string;
  exclude?: string;
  argumentsPreviewChars?: string;
}): RepeatGuardConfig {
  return {
    thresholds: parseThresholds(raw.thresholds),
    include: parseList(raw.include),
    exclude: parseList(raw.exclude),
    argumentsPreviewChars: parsePreviewChars(raw.argumentsPreviewChars),
  };
}

function parseList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseThresholds(raw: string | undefined): number[] {
  // 未设置或留空＝默认。设置页清空输入框会写成 ""，与「没配」相同。
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_THRESHOLDS];
  const parts = parseList(raw);
  if (parts.length === 0) {
    throw new RepeatGuardConfigError("LOOP_GUARD_THRESHOLDS 不能为空");
  }
  const values = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new RepeatGuardConfigError(`LOOP_GUARD_THRESHOLDS 含无效阈值 ${part}：每一项必须是 >= 2 的整数`);
    }
    const value = Number(part);
    if (value < 2) {
      throw new RepeatGuardConfigError(`LOOP_GUARD_THRESHOLDS 含无效阈值 ${value}：每一项必须是 >= 2 的整数`);
    }
    return value;
  });
  if (new Set(values).size !== values.length) {
    throw new RepeatGuardConfigError("LOOP_GUARD_THRESHOLDS 不能包含重复值");
  }
  return [...values].sort((a, b) => a - b);
}

function parsePreviewChars(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PREVIEW_CHARS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new RepeatGuardConfigError(`LOOP_GUARD_ARGUMENTS_PREVIEW 无效（${raw}）：必须是 >= 1 的整数`);
  }
  const value = Number(raw.trim());
  if (value < 1) {
    throw new RepeatGuardConfigError(`LOOP_GUARD_ARGUMENTS_PREVIEW 无效（${value}）：必须是 >= 1 的整数`);
  }
  return value;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

export function isTracked(toolName: string, config: RepeatGuardConfig): boolean {
  const include = config.include.map(wildcardToRegExp);
  const exclude = config.exclude.map(wildcardToRegExp);
  if (include.length > 0 && !include.some((pattern) => pattern.test(toolName))) return false;
  return !exclude.some((pattern) => pattern.test(toolName));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** 深度键排序后再序列化。属性顺序不同视为同一次调用。无法序列化时返回 undefined，调用方跳过该次。 */
export function canonicalize(value: unknown): string | undefined {
  try {
    return JSON.stringify(sortJsonValue(value));
  } catch {
    return undefined;
  }
}

function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}

function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return (
    "检测到重复的工具调用：\n" +
    `- tool: ${toolName}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${canonicalArguments}\n` +
    "这些重复调用没有带来进展。不要再用这组完全相同的参数调用该工具。" +
    "查看最新结果，换一个动作、换一组参数，或者已经收集到足够证据就结束任务。"
  );
}

export function reminderFor(count: number, toolName: string, canonical: string, config: RepeatGuardConfig): string | undefined {
  if (!config.thresholds.includes(count)) return undefined;
  if (count === config.thresholds[0]) return GENTLE_REMINDER;
  return detailedReminder(toolName, count, previewArguments(canonical, config.argumentsPreviewChars));
}

export type ChainStep =
  | { kind: "skip" }
  | { kind: "advance"; chain: Chain; reminder?: string };

/** 推进一条链。未跟踪或无法规范化的调用返回 skip，调用方必须保留原链。 */
export function nextChain(prev: Chain | undefined, toolName: string, args: unknown, config: RepeatGuardConfig): ChainStep {
  if (!isTracked(toolName, config)) return { kind: "skip" };
  const canonical = canonicalize(args);
  if (canonical === undefined) return { kind: "skip" };
  const key = JSON.stringify([toolName, canonical]);
  const count = prev !== undefined && prev.key === key ? prev.count + 1 : 1;
  return {
    kind: "advance",
    chain: { key, count },
    reminder: reminderFor(count, toolName, canonical, config),
  };
}

export type ContentBlock = { type: string; text?: string };

/** 在原工具结果后面追加提醒，不改已有块。 */
export function appendReminder<T extends ContentBlock>(
  content: readonly T[],
  reminder: string,
): Array<T | { type: "text"; text: string }> {
  return [...content, { type: "text", text: `\n[repeat-tool-reminder]\n${reminder}` }];
}
