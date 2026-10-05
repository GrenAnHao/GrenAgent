export const PREVIEW_MAX_CHARS = 32 * 1024;

/** 流式高亮上限。估算值，按手工压测再调。 */
export const HL_MAX_LINES = 1500;
export const HL_MAX_CHARS = 96 * 1024;

/** edit：只给最后这么多对挂高亮器，更早的对折叠成摘要。 */
export const EDIT_LIVE_PAIRS = 3;

export interface WritePreview { text: string; totalLines: number; omittedLines: number; revision: number }

export function writeContent(args: unknown): string {
  const content = (args as { content?: unknown } | null)?.content;
  return typeof content === 'string' ? content : '';
}

export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

export function exceedsHighlightBudget(text: string): boolean {
  return text.length > HL_MAX_CHARS || lineCount(text) > HL_MAX_LINES;
}

/** 路径还没出现时，用正文开头判断语言，避免整段生成都停在纯文本。 */
export function inferLanguage(content: string): string | undefined {
  const head = content.slice(0, 4000);
  if (/^\s*(?:async\s+)?def\s+\w+\s*\(/m.test(head)) return 'python';
  if (/^\s*fn\s+\w+\s*\(/m.test(head) && /->/.test(head)) return 'rust';
  if (/^\s*func\s+\w+\s*\(/m.test(head) && /^\s*package\s+\w+/m.test(head)) return 'go';
  if (/^\s*#include\s+</m.test(head)) return 'cpp';
  if (/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/m.test(head) || /import\s+.+\s+from\s+['"]/.test(head)) {
    if (/\b(?:interface|type)\s+\w+/.test(head) || /:\s*(?:string|number|boolean)\b/.test(head)) return 'typescript';
    return 'javascript';
  }
  if (/^#{1,6}\s+\S/m.test(head)) return 'markdown';
  if (/<[a-zA-Z][^>]*>/.test(head) && /<\/[a-zA-Z]+>/.test(head)) return 'html';
  return undefined;
}

/** write 参数的实时预览：超过上限只保留尾部（在行边界截断），并给出省略行数。只用于降级后的纯文本，不交给高亮器。 */
export function streamingWritePreview(args: unknown): WritePreview {
  const content = writeContent(args);
  const totalLines = lineCount(content);
  if (content.length <= PREVIEW_MAX_CHARS) return { text: content, totalLines, omittedLines: 0, revision: content.length };
  let start = content.length - PREVIEW_MAX_CHARS;
  const nl = content.indexOf('\n', start);
  if (nl !== -1) start = nl + 1;
  const omittedLines = content.slice(0, start).split('\n').length - 1;
  return { text: content.slice(start), totalLines, omittedLines, revision: content.length };
}

export interface StreamingEditPair { oldText?: string; newText?: string }

/** 生成中的编辑已经露出的行数。缺的一侧按 0 计，随半截参数变长。 */
export function streamingEditStats(args: unknown): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const pair of streamingEditPairs(args)) {
    deleted += lineCount(pair.oldText ?? '');
    added += lineCount(pair.newText ?? '');
  }
  return { added, deleted };
}

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
