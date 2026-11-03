/** Model JSON parsing; control-character sanitization adapted from TencentDB-Agent-Memory (MIT). */
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

export function parseLooseJson(text: string): unknown {
  const sanitized = sanitizeJsonForParse(text);
  try { return JSON.parse(sanitized); }
  catch { return JSON.parse(sanitized.replace(/,\s*([}\]])/g, '$1')); }
}
