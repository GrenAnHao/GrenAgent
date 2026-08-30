/** 用户消息里附件块的结构化表示（粘贴文本 / 拖入文件）。 */
export interface AttachmentBlock {
  attType: 'file' | 'text';
  /** 文件块的相对路径 / 文件名；文本块为 undefined。 */
  path?: string;
  lines: number;
  /** 文本块的字符数；文件块省略。 */
  chars?: number;
  content: string;
}

/** 渲染用：消息切成的有序段。 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'attachment'; block: AttachmentBlock };

// 转义：避免内容里字面 </pi:attachment> 提前闭合标签（插入零宽字符，解析时还原）。
const LITERAL_CLOSE = '</pi:attachment>';
const ESCAPED_CLOSE = '</pi:attachment\u200b>';

function escapeContent(s: string): string {
  return s.split(LITERAL_CLOSE).join(ESCAPED_CLOSE);
}
function unescapeContent(s: string): string {
  return s.split(ESCAPED_CLOSE).join(LITERAL_CLOSE);
}

// 属性值转义（path 可能含特殊字符）。
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** 把附件块包成 <pi:attachment> 文本。供 composeMessage 用。 */
export function wrapAttachment(block: AttachmentBlock): string {
  const attrs: string[] = [`type="${block.attType}"`];
  if (block.attType === 'file' && block.path) attrs.push(`path="${escapeAttr(block.path)}"`);
  attrs.push(`lines="${block.lines}"`);
  if (block.attType === 'text' && block.chars != null) attrs.push(`chars="${block.chars}"`);
  return `<pi:attachment ${attrs.join(' ')}>\n${escapeContent(block.content)}\n</pi:attachment>`;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out[m[1]] = unescapeAttr(m[2]);
  return out;
}

/** 把消息 text 切成正文段与附件段。解析失败的片段回退为 text，绝不抛错。供 UserMessage 用。 */
export function parseAttachments(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const re = /<pi:attachment\s+([^>]*)>\n?([\s\S]*?)\n?<\/pi:attachment>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) });
    const attrs = parseAttrs(m[1]);
    parts.push({
      type: 'attachment',
      block: {
        attType: attrs.type === 'file' ? 'file' : 'text',
        path: attrs.path,
        lines: Number(attrs.lines) || 0,
        chars: attrs.chars != null ? Number(attrs.chars) : undefined,
        content: unescapeContent(m[2]),
      },
    });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  if (parts.length === 0) parts.push({ type: 'text', text });
  return parts;
}
