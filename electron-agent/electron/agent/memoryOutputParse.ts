/**
 * 抽取输出的宽松解析。移植自 TencentDB-Agent-Memory（MIT）：
 * - <think> 剥离与数组提取：MemoryCore/src/core/record/l1-extractor.ts:571-631
 * - sanitizeJsonForParse：MemoryCore/src/utils/sanitize.ts:316-405
 * - repairExtractionJson：MemoryCore/src/core/record/l1-extractor.ts:674-681
 */

/** 非贪婪、要求闭合标签：被 max_tokens 截断的 think 原样保留，不会吃掉后面的正文。 */
export function stripModelWrappers(raw: string): string {
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  return cleaned.trim();
}

const SHORT_ESCAPES: Record<number, string> = { 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f', 0x0d: '\\r' };

function escapeControlCharsInJsonStrings(text: string): string {
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (inString) {
      if (ch === '\\' && i + 1 < text.length) { out.push(ch, text[i + 1]!); i++; continue; }
      if (ch === '"') { out.push(ch); inString = false; continue; }
      if (code <= 0x1f) { out.push(SHORT_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, '0')}`); continue; }
      out.push(ch);
    } else {
      if (ch === '"') inString = true;
      out.push(ch);
    }
  }
  return out.join('');
}

export function sanitizeJsonForParse(raw: string): string {
  const escaped = escapeControlCharsInJsonStrings(raw);
  try { JSON.parse(escaped); return escaped; } catch { /* 进入第二步 */ }
  return escaped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

export function repairExtractionJson(json: string): string {
  return json
    .replace(
      /("priority"\s*:\s*)(?!-?\d+(?:\.\d+)?\s*[,}]|"[^"\\]*(?:\\.[^"\\]*)*"\s*[,}])([\s\S]*?)(?=,\s*"(?:content|type|priority|source_message_ids|metadata)"\s*:|[}\]])/g,
      (_match, prefix: string) => `${prefix}50`,
    )
    .replace(/,\s*([}\]])/g, '$1');
}

export function parseLooseJson(text: string): unknown {
  const sanitized = sanitizeJsonForParse(text);
  try {
    return JSON.parse(sanitized);
  } catch (error) {
    const repaired = repairExtractionJson(sanitized);
    if (repaired === sanitized) throw error;
    return JSON.parse(repaired);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEnvelope(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === 'l1' || key === 'l2' || key === 'l3');
}

/**
 * 返回场景数组，或旧的 {l1,l2,l3} 信封（交给 flattenSceneExtraction / parseMemoryExtraction）。
 * 和上游的不同：完全找不到 JSON 时抛错（可重试），上游则当作「没有记忆」直接提交。
 */
export function parseExtractionText(raw: string): unknown {
  const cleaned = stripModelWrappers(raw);
  let whole: unknown;
  try { whole = parseLooseJson(cleaned); } catch { whole = undefined; }
  if (Array.isArray(whole)) return whole;
  if (isRecord(whole)) {
    if (isEnvelope(whole)) return whole;
    if (Array.isArray(whole.memories)) return [whole];
  }
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = parseLooseJson(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* 下面按整段的解析结果处理 */ }
  }
  // 合法 JSON 对象但没有场景数组（如 {"result":"…"}）原样交出，由 parseMemoryExtraction 的严格校验拒绝。
  if (isRecord(whole)) return whole;
  throw new Error('system Pi returned invalid JSON');
}
