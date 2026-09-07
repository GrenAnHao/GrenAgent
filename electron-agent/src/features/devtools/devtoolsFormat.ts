const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '-';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number, size = 2) => String(n).padStart(size, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 把任意值压成可安全 JSON 化的简版：限深度、限数组长度、限字符串长度、断开循环引用。
 * 工作台要预览的是「会话列表有几个、字段名是什么」，而不是把 300 条消息全展开——
 * 不设限的话一次刷新就要序列化几十 MB，面板会直接卡死。
 */
export function summarize(
  value: unknown,
  options: { maxDepth?: number; maxItems?: number; maxString?: number } = {},
  seen = new WeakSet<object>(),
): unknown {
  const maxDepth = options.maxDepth ?? 6;
  const maxItems = options.maxItems ?? 20;
  const maxString = options.maxString ?? 600;

  if (value === null) return null;
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'undefined' || type === 'function' || type === 'symbol') return `<${type}>`;
  if (type === 'bigint') return `${String(value)}n`;
  if (type === 'string') {
    const text = value as string;
    return text.length > maxString ? `${text.slice(0, maxString)}… (共 ${text.length} 字符)` : text;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (ArrayBuffer.isView(value)) return `<${(value as object).constructor.name} ${(value as unknown as { length: number }).length}>`;

  if (typeof value !== 'object') return String(value);
  const object = value as Record<string, unknown>;
  if (seen.has(object)) return '<循环引用>';
  if (maxDepth <= 0) return Array.isArray(value) ? `<数组 ${object.length} 项>` : '<对象>';
  seen.add(object);

  if (Array.isArray(value)) {
    const head = value.slice(0, maxItems).map((item) => summarize(item, { ...options, maxDepth: maxDepth - 1 }, seen));
    if (value.length > maxItems) head.push(`… 其余 ${value.length - maxItems} 项已省略`);
    return head;
  }

  const entries = Object.entries(object);
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, maxItems * 3)) {
    output[key] = summarize(item, { ...options, maxDepth: maxDepth - 1 }, seen);
  }
  if (entries.length > maxItems * 3) output['…'] = `其余 ${entries.length - maxItems * 3} 个字段已省略`;
  return output;
}

/** 给「复制/展示」用的稳定 JSON 文本；序列化失败（循环引用等）时退回 summarize。 */
export function prettyJson(value: unknown, maxLength = 40_000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = JSON.stringify(summarize(value), null, 2) ?? String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n… 已截断（共 ${text.length} 字符）` : text;
}

/** 单行摘要：用于事件流/调用历史这类「一行一条」的列表。 */
export function oneLine(value: unknown, maxLength = 220): string {
  let text: string;
  try {
    text = JSON.stringify(summarize(value, { maxDepth: 3, maxItems: 6, maxString: 120 })) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
