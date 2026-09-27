export const PREVIEW_MAX_CHARS = 32 * 1024;

export interface WritePreview { text: string; totalLines: number; omittedLines: number; revision: number }

/** write 参数的实时预览：超过上限只保留尾部（在行边界截断），并给出省略行数。 */
export function streamingWritePreview(args: unknown): WritePreview {
  const content = typeof (args as { content?: unknown } | null)?.content === 'string'
    ? (args as { content: string }).content : '';
  const totalLines = content ? content.split('\n').length : 0;
  if (content.length <= PREVIEW_MAX_CHARS) return { text: content, totalLines, omittedLines: 0, revision: content.length };
  let start = content.length - PREVIEW_MAX_CHARS;
  const nl = content.indexOf('\n', start);
  if (nl !== -1) start = nl + 1;
  const omittedLines = content.slice(0, start).split('\n').length - 1;
  return { text: content.slice(start), totalLines, omittedLines, revision: content.length };
}

export interface StreamingEditPair { oldText?: string; newText?: string }

/** edit 参数的实时对：容忍缺 newText、edits 为 JSON 字符串、旧式 oldText/newText 与 old_string/new_string。 */
export function streamingEditPairs(args: unknown): StreamingEditPair[] {
  if (!args || typeof args !== 'object') return [];
  const input = args as Record<string, unknown>;
  let edits: unknown = input.edits;
  if (typeof edits === 'string') {
    try { edits = JSON.parse(edits); } catch { edits = undefined; }
  }
  if (edits && !Array.isArray(edits) && typeof edits === 'object') edits = [edits];
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  if (Array.isArray(edits)) {
    return edits.flatMap((e) => {
      if (!e || typeof e !== 'object') return [];
      const r = e as Record<string, unknown>;
      const pair = { oldText: str(r.oldText) ?? str(r.old_string), newText: str(r.newText) ?? str(r.new_string) };
      return pair.oldText === undefined && pair.newText === undefined ? [] : [pair];
    });
  }
  const single = { oldText: str(input.oldText) ?? str(input.old_string), newText: str(input.newText) ?? str(input.new_string) };
  return single.oldText === undefined && single.newText === undefined ? [] : [single];
}

/** 合计超过上限时只保留末尾若干对，并返回被省略的对数。 */
export function clipEditPairs(pairs: StreamingEditPair[], maxChars = PREVIEW_MAX_CHARS): { pairs: StreamingEditPair[]; omitted: number } {
  const size = (pair: StreamingEditPair) => (pair.oldText?.length ?? 0) + (pair.newText?.length ?? 0);
  const total = pairs.reduce((sum, pair) => sum + size(pair), 0);
  if (total <= maxChars) return { pairs, omitted: 0 };
  const kept: StreamingEditPair[] = [];
  let used = 0;
  for (let i = pairs.length - 1; i >= 0; i--) {
    const pair = pairs[i];
    if (!pair) continue;
    const len = size(pair);
    if (kept.length > 0 && used + len > maxChars) break;
    kept.push(pair);
    used += len;
  }
  kept.reverse();
  return { pairs: kept, omitted: pairs.length - kept.length };
}
