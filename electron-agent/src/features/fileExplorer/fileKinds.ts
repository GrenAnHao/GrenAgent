/** 按扩展名决定内容区怎么渲染；真正是不是二进制由主进程看文件内容判断。 */
export type FileKind = 'markdown' | 'image' | 'text';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

/** 超过这个大小的文本关掉折叠、括号匹配这类重扩展，改动也合并着上报。 */
export const LARGE_TEXT_BYTES = 2 * 1024 * 1024;

export type LineSeparator = '\n' | '\r\n';

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileKindOf(path: string): FileKind {
  const ext = extensionOf(path);
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'text';
}

/**
 * 按第一个换行判断文件用 CRLF 还是 LF。CodeMirror 默认把所有换行读成 \n、写回也是 \n，
 * 不告诉它原来的换行符，Windows 上的 CRLF 文件一保存整份都会变。
 */
export function detectLineSeparator(text: string): LineSeparator {
  const lf = text.indexOf('\n');
  return lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
}

/** 父目录的绝对路径（保留原分隔符）。 */
export function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : path;
}

/** path 相对 root 的各级名字，用于面包屑；不在 root 下时整条路径拆开。 */
export function pathSegments(root: string, path: string): string[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const p = norm(path);
  const rel = p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p;
  return rel.split('/').filter(Boolean);
}
