/** 自动压缩触发百分比。未设置时沿用扩展原来的 80。范围与 Kirocrew 一致：5–90。 */
export const AUTO_COMPACT_PERCENT_KEY = "AUTO_COMPACT_PERCENT";
export const AUTO_COMPACT_OVERRIDES_KEY = "AUTO_COMPACT_OVERRIDES";
export const AUTO_COMPACT_PERCENT_MIN = 5;
export const AUTO_COMPACT_PERCENT_MAX = 90;
export const AUTO_COMPACT_PERCENT_DEFAULT = 80;

export function clampAutoCompactPercent(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return AUTO_COMPACT_PERCENT_DEFAULT;
  return Math.min(AUTO_COMPACT_PERCENT_MAX, Math.max(AUTO_COMPACT_PERCENT_MIN, rounded));
}

/** 会话文件路径作覆盖表的键。斜杠统一，避免同一文件写出两份。 */
export function sessionCompactKey(path: string): string {
  return path.replace(/\\/g, "/");
}

export function readGlobalAutoCompactPercent(settings: Record<string, string | undefined>): number {
  const raw = settings[AUTO_COMPACT_PERCENT_KEY]?.trim() ?? "";
  if (!raw) return AUTO_COMPACT_PERCENT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return AUTO_COMPACT_PERCENT_DEFAULT;
  return clampAutoCompactPercent(n);
}

function readOverrides(settings: Record<string, string | undefined>): Record<string, number> {
  const raw = settings[AUTO_COMPACT_OVERRIDES_KEY];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      out[sessionCompactKey(key)] = clampAutoCompactPercent(value);
    }
    return out;
  } catch {
    return {};
  }
}

/** 该会话自己的触发值。没有覆盖时返回 null，表示跟随全局。 */
export function readSessionAutoCompactPercent(
  settings: Record<string, string | undefined>,
  sessionPath: string | null | undefined,
): number | null {
  if (!sessionPath) return null;
  const value = readOverrides(settings)[sessionCompactKey(sessionPath)];
  return value == null ? null : value;
}

export function effectiveAutoCompactPercent(
  settings: Record<string, string | undefined>,
  sessionPath: string | null | undefined,
): number {
  return readSessionAutoCompactPercent(settings, sessionPath) ?? readGlobalAutoCompactPercent(settings);
}

/** percent 为 null 时删掉该会话的覆盖。 */
export function withSessionAutoCompactPercent(
  settings: Record<string, string>,
  sessionPath: string,
  percent: number | null,
): Record<string, string> {
  const overrides = readOverrides(settings);
  const key = sessionCompactKey(sessionPath);
  if (percent == null) delete overrides[key];
  else overrides[key] = clampAutoCompactPercent(percent);
  const next = { ...settings };
  if (Object.keys(overrides).length === 0) delete next[AUTO_COMPACT_OVERRIDES_KEY];
  else next[AUTO_COMPACT_OVERRIDES_KEY] = JSON.stringify(overrides);
  return next;
}
