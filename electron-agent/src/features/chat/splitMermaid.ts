export type MarkdownSegment =
  | { type: 'markdown'; content: string }
  | { type: 'mermaid'; content: string };

// 已闭合的 ```mermaid 代码块。未闭合的（流式输出中还没收到结束围栏）不会匹配，
// 因此会留在 markdown 段里按普通文本/代码渲染，等收全后再切出来渲染成图——流式友好。
const MERMAID_BLOCK = /```[ \t]*mermaid\b[^\n]*\n([\s\S]*?)\n[ \t]*```/gi;

// 把 markdown 切成「正文段」与「mermaid 段」：正文段交给 @lobehub/ui Markdown，
// mermaid 段交给自写的 inline-SVG 组件，从而绕开 @lobehub 的 blob image + lazy 渲染链路。
export function splitMermaid(markdown: string): MarkdownSegment[] {
  if (!markdown || !/```[ \t]*mermaid\b/i.test(markdown)) {
    return [{ content: markdown, type: 'markdown' }];
  }

  const segments: MarkdownSegment[] = [];
  let last = 0;
  for (const match of markdown.matchAll(MERMAID_BLOCK)) {
    const start = match.index ?? 0;
    const before = markdown.slice(last, start);
    if (before.trim()) segments.push({ content: before, type: 'markdown' });
    segments.push({ content: match[1], type: 'mermaid' });
    last = start + match[0].length;
  }

  const after = markdown.slice(last);
  if (after.trim() || segments.length === 0) segments.push({ content: after, type: 'markdown' });
  return segments;
}
