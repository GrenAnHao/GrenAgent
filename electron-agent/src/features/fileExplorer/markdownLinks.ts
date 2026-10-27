import { classifyHref } from '../../lib/hrefKinds';
import { joinUnder, relativeSegments } from './treeModel';

export type MarkdownLinkTarget =
  | { kind: 'anchor'; id: string }
  | { kind: 'external'; url: string }
  /** path 是文件树里的绝对路径；rel 是相对项目根、用 `/` 连接的写法（项目根自己是空串）。 */
  | { kind: 'file'; path: string; rel: string }
  | { kind: 'unsupported'; reason: string };

export interface MarkdownLinkContext {
  /** 文件树的根（realpath 后的项目根）。 */
  root: string;
  /** 正在预览的 markdown 文件，相对链接以它所在的目录为基准。 */
  filePath: string;
}

const OUTSIDE: MarkdownLinkTarget = { kind: 'unsupported', reason: '链接指向项目之外，已拦截' };

/**
 * 预览里一条链接该怎么处理。纯函数，不碰磁盘：
 * 文件是否存在由调用方再查；这里只负责把 `./`、`../`、`%20`、`?query`、`#hash` 这些写法落成项目内路径。
 * 跨文件的 `#hash` 不处理（只打开文件，不定位到标题）。
 */
export function resolveMarkdownLink(href: string, ctx: MarkdownLinkContext): MarkdownLinkTarget {
  const kind = classifyHref(href);
  if (kind.kind !== 'path') return kind;

  // 绝对路径在项目里就按绝对路径用；`/docs/a.md` 这种不在项目里的，按 GitHub 的习惯当作相对项目根。
  const absoluteInside = kind.rooted ? relativeSegments(ctx.root, kind.path) : null;
  const driveLetter = /^[a-zA-Z]:\//.test(kind.path);
  if (kind.rooted && !absoluteInside && driveLetter) return OUTSIDE;

  let stack: string[];
  let pieces: string[];
  if (absoluteInside) {
    stack = [];
    pieces = absoluteInside;
  } else if (kind.rooted) {
    stack = [];
    pieces = kind.path.split('/');
  } else {
    const current = relativeSegments(ctx.root, ctx.filePath);
    if (!current) return OUTSIDE;
    stack = current.slice(0, -1);
    pieces = kind.path.split('/');
  }

  for (const piece of pieces) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') {
      if (stack.length === 0) return OUTSIDE;
      stack.pop();
      continue;
    }
    stack.push(piece);
  }
  return { kind: 'file', path: stack.length ? joinUnder(ctx.root, stack) : ctx.root, rel: stack.join('/') };
}
