import type { DisplayMessage } from '../chat/groupMessages';

/** 一次查找最多记多少处命中：再多也看不过来，计数写成上限值。 */
export const MAX_MATCHES = 5000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 查询 → 正则。不区分大小写，按字面匹配（不是正则语法），全空白的查询算「没有查询」。
 * 返回新对象：带 g 标志的正则有 lastIndex 状态，不共享。
 */
export function compileQuery(query: string): RegExp | null {
  if (query.trim() === '') return null;
  return new RegExp(escapeRegExp(query), 'giu');
}

function regexpOf(query: string | RegExp): RegExp | null {
  if (typeof query !== 'string') {
    query.lastIndex = 0;
    return query;
  }
  return compileQuery(query);
}

/** text 里有几处命中（封顶 MAX_MATCHES）。query 可以是已经编译好的正则，调用方自己保证不并发使用。 */
export function countMatches(text: string, query: string | RegExp): number {
  const re = regexpOf(query);
  if (!re || !text) return 0;
  let count = 0;
  while (re.exec(text) !== null) {
    count += 1;
    if (count >= MAX_MATCHES) break;
  }
  return count;
}

/**
 * 把 markdown 粗略还原成「界面上看到的文字」，只用来给没渲染出来的消息估命中数：
 * 去掉代码围栏行、反引号、粗体 / 删除线标记、链接和图片的语法壳，以及行首的标题 / 引用 / 列表记号。
 * 单个 `*` 和 `_` 不动：它们常出现在标识符里（login_user），剥掉会让命中数对不上。
 * 渲染出来之后命中数以 DOM 为准，这里的误差只影响还没滚到的消息。
 */
export function stripMarkdownForFind(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*|~~/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '');
}

/**
 * 一条列表项里「一直看得见」的文字：用户消息、助手正文（含代码块）。
 * 不含思考、工具卡的参数和输出：它们默认折叠，没渲染出来的内容命中了也看不见、没法高亮。
 * （展开过、渲染出来的部分，会在 DOM 扫描时计入。）
 */
export function visibleItemText(item: Pick<DisplayMessage, 'kind' | 'id'> & Record<string, unknown>): string {
  switch (item.kind) {
    case 'user':
      return typeof item.text === 'string' ? item.text : '';
    case 'turn': {
      const segments = Array.isArray(item.segments) ? (item.segments as Array<{ kind: string; content?: string }>) : [];
      return segments
        .filter((segment) => segment.kind === 'text' && typeof segment.content === 'string')
        .map((segment) => stripMarkdownForFind(segment.content as string))
        .join('\n');
    }
    case 'notice':
      return typeof item.content === 'string' ? item.content : '';
    default:
      return '';
  }
}

export interface VisibleTextCacheEntry {
  sources: readonly string[];
  text: string;
}

/** 参与估算的正文字符串引用。只收集引用，不做剥离。 */
export function textSources(item: Pick<DisplayMessage, 'kind' | 'id'> & Record<string, unknown>): string[] {
  switch (item.kind) {
    case 'user':
      return typeof item.text === 'string' ? [item.text] : [];
    case 'turn': {
      const segments = Array.isArray(item.segments) ? (item.segments as Array<{ kind: string; content?: string }>) : [];
      const sources: string[] = [];
      for (const segment of segments) {
        if (segment.kind === 'text' && typeof segment.content === 'string') sources.push(segment.content);
      }
      return sources;
    }
    case 'notice':
      return typeof item.content === 'string' ? [item.content] : [];
    default:
      return [];
  }
}

function sameSources(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 按消息 id 缓存剥离结果。groupMessages 每次都造新对象，但没改过的正文仍是同一条字符串，
 * 用引用比较就能跳过整段正则。流式增长只让正在写的那一条重算。
 */
export function cachedVisibleItemText(
  item: Pick<DisplayMessage, 'kind' | 'id'> & Record<string, unknown>,
  cache: Map<string, VisibleTextCacheEntry>,
): string {
  const sources = textSources(item);
  const hit = cache.get(item.id);
  if (hit && sameSources(hit.sources, sources)) return hit.text;
  const text = visibleItemText(item);
  cache.set(item.id, { sources, text });
  return text;
}

const BLOCK_SELECTOR = 'address,article,aside,blockquote,dd,details,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,summary,table,tbody,td,tfoot,th,thead,tr,ul,br';

export interface TextSlice {
  node: Text;
  /** 这个文本节点在拼接串里的起点。 */
  start: number;
}

export interface CollectedText {
  text: string;
  slices: TextSlice[];
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SVG', 'CANVAS']);

function isRendered(el: Element, cache: Map<Element, boolean>): boolean {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  const visible =
    typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkVisibilityCSS: true } as never) : true;
  cache.set(el, visible);
  return visible;
}

/**
 * 把 root 下可见的文本节点按文档顺序拼成一个串，跨块级元素处插入换行（查询里没有换行，所以不会跨块命中），
 * 同一块里的行内元素（粗体、链接、行内代码）直接相连：于是「par**tial**」这种跨行内元素的词也能命中。
 * 跳过 `[data-find-ignore]` 子树（查找栏自己）、脚本样式、被 CSS 隐藏的节点。
 */
export function collectText(root: Element): CollectedText {
  const slices: TextSlice[] = [];
  let text = '';
  let lastBlock: Element | null | undefined;
  const visibility = new Map<Element, boolean>();
  const skipped = new Map<Element, boolean>();
  const blocks = new Map<Element, Element | null>();
  const isSkipped = (parent: Element): boolean => {
    const hit = skipped.get(parent);
    if (hit !== undefined) return hit;
    const value = SKIP_TAGS.has(parent.tagName.toUpperCase()) || parent.closest('[data-find-ignore]') !== null;
    skipped.set(parent, value);
    return value;
  };
  const blockOf = (parent: Element): Element | null => {
    const hit = blocks.get(parent);
    if (hit !== undefined) return hit;
    const block = parent.closest(BLOCK_SELECTOR);
    blocks.set(parent, block);
    return block;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (isSkipped(parent)) return NodeFilter.FILTER_REJECT;
      return isRendered(parent, visibility) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    const block = parent ? blockOf(parent) : null;
    if (lastBlock !== undefined && block !== lastBlock && text.length > 0) text += '\n';
    lastBlock = block;
    slices.push({ node: textNode, start: text.length });
    text += textNode.nodeValue ?? '';
  }
  return { text, slices };
}

/** 拼接串里 [from, to) 对应的 DOM Range。 */
export function rangeFor(collected: CollectedText, from: number, to: number): Range | null {
  const { slices } = collected;
  const locate = (offset: number, preferEnd: boolean): { node: Text; offset: number } | null => {
    let lo = 0;
    let hi = slices.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (slices[mid].start <= offset) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return null;
    let slice = slices[found];
    // 终点正好落在节点末尾：取前一个节点的末尾，不要滑进下一个节点的开头。
    if (preferEnd && offset === slice.start && found > 0) {
      const previous = slices[found - 1];
      if (previous.start + (previous.node.nodeValue?.length ?? 0) === offset) slice = previous;
    }
    const local = Math.min(offset - slice.start, slice.node.nodeValue?.length ?? 0);
    return { node: slice.node, offset: local };
  };
  const start = locate(from, false);
  const end = locate(to, true);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/** collected 里的全部命中，按顺序。query 可以是已经编译好的正则。 */
export function findRanges(collected: CollectedText, query: string | RegExp, limit = MAX_MATCHES): Range[] {
  const re = regexpOf(query);
  if (!re || !collected.text) return [];
  const ranges: Range[] = [];
  for (let match = re.exec(collected.text); match; match = re.exec(collected.text)) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const range = rangeFor(collected, match.index, match.index + match[0].length);
    if (range) ranges.push(range);
    if (ranges.length >= limit) break;
  }
  return ranges;
}
