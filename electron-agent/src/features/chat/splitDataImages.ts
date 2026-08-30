export type DataImageSegment =
  | { type: 'markdown'; content: string }
  | { type: 'image'; src: string; alt: string };

// markdown 内嵌的 data-URL 图片：![alt](data:image/...;base64,XXXX)
const DATA_IMAGE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)\s]+)\)/g;

// 紧贴图片前、形如 {"prompt":...} 的图片请求回显：部分「图片模型」(如 gpt-image 系) 被当对话模型用时，
// 会把图片 API 请求体当成文本和图片一起返回。这段 JSON 对用户无意义，剥掉。仅匹配「扁平、含 prompt、
// 紧贴文本末尾」的对象，避免误删正文里合法的 JSON 代码块。
const TRAILING_IMAGE_REQUEST_JSON = /\{[^{}]*"prompt"[^{}]*\}\s*$/;

/**
 * 把 markdown 切成「正文段」与「图片段」：data-URL 图片单独切出，交给普通 <img> 渲染，绕开
 * @lobehub/ui Markdown 的 blob image + lazy 链路（WebView2 会拦截它、导致 data-URL 图片显示成破损占位）。
 * 同时剥掉紧贴图片前的图片请求 JSON 回显。无 data 图时原样返回单段，走原渲染快路径。
 */
export function splitDataImages(markdown: string): DataImageSegment[] {
  if (!markdown || !markdown.includes('data:image/')) {
    return [{ type: 'markdown', content: markdown }];
  }

  const segments: DataImageSegment[] = [];
  let last = 0;
  for (const match of markdown.matchAll(DATA_IMAGE)) {
    const start = match.index ?? 0;
    const before = markdown.slice(last, start).replace(TRAILING_IMAGE_REQUEST_JSON, '');
    if (before.trim()) segments.push({ type: 'markdown', content: before });
    segments.push({ type: 'image', alt: match[1] ?? '', src: match[2] });
    last = start + match[0].length;
  }

  const after = markdown.slice(last);
  if (after.trim() || segments.length === 0) segments.push({ type: 'markdown', content: after });
  return segments;
}

/**
 * 去掉对话内联的 data-URL 图片（图片统一走 generate_image 工具卡展示）与紧贴其前的「图片请求 JSON
 * 回显」，只保留正文。无 data 图时原样返回（快路径）。
 */
export function stripDataImages(markdown: string): string {
  if (!markdown.includes('data:image/')) return markdown;
  return splitDataImages(markdown)
    .filter((s): s is { type: 'markdown'; content: string } => s.type === 'markdown')
    .map((s) => s.content)
    .join('');
}

// markdown 图片引用：![alt](url ...)。
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;

/**
 * 对话正文一律不内联渲染图片（图片只走 generate_image 工具卡）：先剥 data-URL 图片 + 图片请求 JSON
 * 回显，再剥「本地/相对路径」的图片引用——这类在 WebView2 下必然裂图，且与工具卡重复（模型常在出图后
 * 又在正文贴一份图片路径）。http(s) 图片引用予以保留（可正常加载）。
 */
export function stripInlineImages(markdown: string): string {
  const out = stripDataImages(markdown);
  if (!out.includes('![')) return out;
  return out.replace(MARKDOWN_IMAGE, (full, url: string) => (/^https?:\/\//i.test(url) ? full : ''));
}
