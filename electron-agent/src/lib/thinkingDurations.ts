/**
 * 推理时长跨会话持久化。
 *
 * pi 的会话文件只存 thinking 正文、不存推理耗时，切换/重开会话后
 * 「已深度思考（用时 X 秒）」会丢失用时。这里以助手消息的 timestamp
 * （pi 消息自带，ms 精度）为 key 把前端实时计出的时长落到 localStorage，
 * 恢复历史消息时按 timestamp 找回。
 */

const STORAGE_KEY = 'pi.thinking-durations.v1';
/** 最多保留的条目数，超出按 timestamp 淘汰最旧的。 */
const MAX_ENTRIES = 1000;

type DurationMap = Record<string, number>;

/** localStorage 不可用（隐私模式/测试环境异常）时的内存兜底。 */
let memoryFallback: DurationMap | null = null;

function load(): DurationMap {
  if (memoryFallback) return memoryFallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as DurationMap;
    return {};
  } catch {
    memoryFallback = {};
    return memoryFallback;
  }
}

function persist(map: DurationMap): void {
  if (memoryFallback) {
    memoryFallback = map;
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    memoryFallback = map;
  }
}

/** 记录一条推理时长（timestamp 为 pi 助手消息的 Unix ms）。 */
export function saveThinkingDuration(timestamp: number, duration: number): void {
  if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration <= 0) return;
  const map = load();
  const key = String(timestamp);
  if (map[key] === duration) return;
  map[key] = duration;

  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete map[k]);
  }
  persist(map);
}

/** 按消息 timestamp 取回推理时长；无记录返回 undefined。 */
export function getThinkingDuration(timestamp: number | undefined): number | undefined {
  if (timestamp == null || !Number.isFinite(timestamp)) return undefined;
  return load()[String(timestamp)];
}

/** 仅测试用：清空存储与内存兜底。 */
export function clearThinkingDurationsForTest(): void {
  memoryFallback = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
