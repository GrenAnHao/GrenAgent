import { collectText, compileQuery, countMatches, findRanges, MAX_MATCHES } from './findMatch';

export interface FindStatus {
  /** 命中总数（封顶 MAX_MATCHES）。 */
  total: number;
  /** 当前是第几处，1 起；没有命中为 0。 */
  current: number;
}

/** 查找栏背后的执行者：DOM 内容（会话、Markdown 预览）和 CodeMirror 编辑器各有一个实现。 */
export interface FindDriver {
  setQuery(query: string): void;
  next(): void;
  prev(): void;
  clear(): void;
  dispose(): void;
}

export interface FinderItem {
  id: string;
  /** 这一项里一直看得见的文字，用来估算还没渲染出来的项的命中数。 */
  text: string;
}

export interface DomFinderOptions {
  getRoot: () => HTMLElement | null;
  /**
   * 列表型内容（会话）：按顺序给出全部项。DOM 里每一项的根元素带 `data-find-item="<id>"`，
   * 没渲染出来（被虚拟化卸载）的项先按 text 估算，渲染出来后以 DOM 为准。
   * 不给就把 root 整个当作一项（文件预览：全部在 DOM 里）。
   */
  items?: () => FinderItem[];
  /** 当前项所在的项还没渲染：请列表把它滚进来。 */
  scrollToItem?: (id: string) => void;
  /** 列表自己的滚动容器；滚它必须走 scrollBy（会打断「贴底跟随」），其余嵌套滚动区直接改 scrollTop。 */
  getScroller?: () => HTMLElement | null;
  scrollBy?: (deltaY: number) => void;
  onStatus: (status: FindStatus) => void;
}

const ROOT_ITEM = '__root';
/**
 * 渲染出来的项 DOM 命中数比文字估算少时，先当作「内容还没加载完」（代码块、图表是懒加载的，刚挂上来还是空的），
 * 这段时间内仍按估算计，别把当前项判成没命中；超过这个时间还是少，就是真的少（折叠、被样式隐藏），以 DOM 为准。
 */
const SETTLE_MS = 1500;
/** 当前项距滚动区上下沿至少留这么多像素才算「看得见」。 */
const VISIBLE_MARGIN = 48;

interface Cursor {
  id: string;
  occ: number;
}

// —— 高亮注册表：会话和文件预览可以同时在查找，各自的命中取并集写进同一组命名高亮。——
interface Contribution {
  all: Range[];
  current: Range | null;
}
const contributions = new Map<symbol, Contribution>();

interface HighlightRegistryLike {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function highlightApi(): { registry: HighlightRegistryLike; Highlight: new (...ranges: Range[]) => { priority: number } } | null {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistryLike } | undefined)?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => { priority: number } }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

function publishHighlights(): void {
  const api = highlightApi();
  if (!api) return;
  const all: Range[] = [];
  const current: Range[] = [];
  for (const entry of contributions.values()) {
    all.push(...entry.all);
    if (entry.current) current.push(entry.current);
  }
  if (all.length === 0) {
    api.registry.delete('gren-find');
    api.registry.delete('gren-find-current');
    return;
  }
  api.registry.set('gren-find', new api.Highlight(...all));
  if (current.length > 0) {
    const highlight = new api.Highlight(...current);
    // 当前项压在普通命中之上：同一段文字两层都有时，显示「当前」的颜色。
    highlight.priority = 1;
    api.registry.set('gren-find-current', highlight);
  } else {
    api.registry.delete('gren-find-current');
  }
}

/** 页面上现在有多少处高亮的 Range（测试和 probe 用）。 */
export function highlightedRangeCount(): number {
  let count = 0;
  for (const entry of contributions.values()) count += entry.all.length;
  return count;
}

function isScrollable(el: HTMLElement): boolean {
  const overflowY = getComputedStyle(el).overflowY;
  return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
}

export class DomFinder implements FindDriver {
  private readonly id = Symbol('dom-finder');
  private query = '';
  private cursor: Cursor | null = null;
  private status: FindStatus = { total: 0, current: 0 };
  private observer: MutationObserver | null = null;
  private observed: HTMLElement | null = null;
  private raf = 0;
  private pendingReveal = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  /** 项 id → 渲染出来时数到的真实命中数。文字没变就一直有效，项被卸载后也保留，计数不回跳。 */
  private domCounts = new Map<string, { text: string; count: number }>();
  /** 项 id → 按文字估算的命中数，query 变了清空。 */
  private modelCounts = new Map<string, { text: string; count: number }>();
  private ranges = new Map<string, Range[]>();
  /** 项 id → 它第一次被发现「DOM 命中数少于估算」的时刻。 */
  private mismatchSince = new Map<string, number>();
  /** 最近一次算出的各项命中数（跳转时用）。 */
  private lastCounts = new Map<string, number>();
  private settleRefresh: ReturnType<typeof setTimeout> | undefined;
  /** 已经扫过的项。元素和估算文字都没变、也没有落在这项上的 DOM 变更时，沿用上次的 Range。 */
  private live = new Map<string, { el: HTMLElement; modelText: string; ranges: Range[]; count: number; unsettled: boolean }>();
  /** 'all'：整表重扫。Set：只扫这些项。null：没有待处理的 DOM 变更。 */
  private pendingDirty: Set<string> | 'all' | null = null;
  private queryRe: RegExp | null = null;
  private reportedTotal = 0;
  /** 实际走过 collectText 的次数（测试用来确认没有整表重扫）。 */
  scanCount = 0;

  constructor(private readonly options: DomFinderOptions) {}

  /** 开始 / 更换查询。回到第一个命中并滚过去。 */
  setQuery(query: string): void {
    this.query = query;
    this.cursor = null;
    this.domCounts.clear();
    this.modelCounts.clear();
    this.mismatchSince.clear();
    this.live.clear();
    this.queryRe = null;
    this.active = query.trim() !== '';
    if (!this.active) {
      this.pendingDirty = null;
      this.clearHighlights();
      this.report({ total: 0, current: 0 });
      return;
    }
    this.queryRe = compileQuery(query);
    this.pendingDirty = 'all';
    this.attach();
    this.pendingReveal = true;
    this.refresh();
  }

  next(): void {
    this.step(1);
  }

  prev(): void {
    this.step(-1);
  }

  /** 内容或可见范围变了（新消息、流式增长、滚动挂载了新项）：重算计数并保持当前项。 */
  refresh(): void {
    if (!this.active) return;
    this.recompute();
    if (this.pendingReveal) this.reveal();
  }

  /** 关闭查找：清高亮、停监听。 */
  clear(): void {
    clearTimeout(this.settleTimer);
    this.query = '';
    this.active = false;
    this.cursor = null;
    this.pendingReveal = false;
    this.domCounts.clear();
    this.modelCounts.clear();
    this.mismatchSince.clear();
    this.live.clear();
    this.pendingDirty = null;
    this.queryRe = null;
    clearTimeout(this.settleRefresh);
    this.ranges.clear();
    this.detach();
    this.clearHighlights();
    this.report({ total: 0, current: 0 });
  }

  dispose(): void {
    clearTimeout(this.settleTimer);
    clearTimeout(this.settleRefresh);
    this.detach();
    contributions.delete(this.id);
    publishHighlights();
  }

  // —— 内部 ——

  private attach(): void {
    const root = this.options.getRoot();
    if (!root || this.observed === root) return;
    this.detach();
    this.observed = root;
    this.observer = new MutationObserver((records) => {
      this.noteMutations(records);
      this.schedule();
    });
    this.observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  private detach(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.observed = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.refresh();
    });
  }

  private clearHighlights(): void {
    this.ranges.clear();
    contributions.delete(this.id);
    publishHighlights();
  }

  private report(status: FindStatus): void {
    if (status.total === this.status.total && status.current === this.status.current) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private noteMutations(records: MutationRecord[]): void {
    if (this.pendingDirty === 'all') return;
    // 整块内容（文件预览）没有分项，任何 DOM 变化都重扫这一块。
    if (!this.options.items) {
      this.pendingDirty = 'all';
      return;
    }
    const dirty = this.pendingDirty ?? new Set<string>();
    for (const record of records) this.collectItemIds(record, dirty);
    this.pendingDirty = dirty.size > 0 ? dirty : null;
  }

  /** 变更落在哪些 `[data-find-item]` 上。列表外的垫片、高度变化不记，避免流式输出时整表重扫。 */
  private collectItemIds(record: MutationRecord, dirty: Set<string>): void {
    const mark = (node: Node | null) => {
      const el = node instanceof Element ? node : node?.parentElement ?? null;
      const item = el?.closest<HTMLElement>('[data-find-item]');
      const id = item?.dataset.findItem;
      if (id) dirty.add(id);
    };
    mark(record.target);
    const consider = (node: Node) => {
      mark(node);
      if (node instanceof Element) {
        for (const el of node.querySelectorAll<HTMLElement>('[data-find-item]')) {
          if (el.dataset.findItem) dirty.add(el.dataset.findItem);
        }
      }
    };
    record.addedNodes.forEach(consider);
    record.removedNodes.forEach(consider);
  }

  private itemList(): FinderItem[] {
    return this.options.items ? this.options.items() : [{ id: ROOT_ITEM, text: '' }];
  }

  /** 渲染出来的项：id → 元素。 */
  private renderedItems(root: HTMLElement): Map<string, HTMLElement> {
    const rendered = new Map<string, HTMLElement>();
    if (!this.options.items) {
      rendered.set(ROOT_ITEM, root);
      return rendered;
    }
    for (const el of root.querySelectorAll<HTMLElement>('[data-find-item]')) {
      const id = el.dataset.findItem;
      if (id) rendered.set(id, el);
    }
    return rendered;
  }

  private recompute(): void {
    const root = this.options.getRoot();
    if (!root) {
      this.ranges.clear();
      this.report({ total: 0, current: 0 });
      return;
    }
    this.attach();
    const items = this.itemList();
    const rendered = this.renderedItems(root);
    this.ranges.clear();

    const modelCountOf = (item: FinderItem): number => {
      let model = this.modelCounts.get(item.id);
      if (!model || model.text !== item.text) {
        model = { text: item.text, count: countMatches(item.text, this.queryRe ?? this.query) };
        this.modelCounts.set(item.id, model);
      }
      return model.count;
    };
    const dirty = this.pendingDirty;
    this.pendingDirty = null;
    const now = performance.now();
    let unsettled = false;
    const counts: number[] = [];
    let total = 0;
    const query = this.queryRe ?? this.query;
    for (const item of items) {
      const el = rendered.get(item.id);
      let count: number;
      if (el) {
        const prev = this.live.get(item.id);
        const mustScan =
          dirty === 'all' ||
          (dirty?.has(item.id) ?? false) ||
          !prev ||
          prev.modelText !== item.text ||
          prev.el !== el ||
          prev.unsettled;
        let found: Range[];
        let itemUnsettled = false;
        if (!mustScan && prev) {
          found = prev.ranges;
          count = prev.count;
        } else {
          this.scanCount += 1;
          found = findRanges(collectText(el), query, MAX_MATCHES - total);
          // 只对有文字估算的列表项做宽限；整块内容（文件预览）没有估算，model 恒为 0。
          const model = this.options.items ? modelCountOf(item) : 0;
          if (found.length < model) {
            const since = this.mismatchSince.get(item.id) ?? now;
            this.mismatchSince.set(item.id, since);
            if (now - since < SETTLE_MS) {
              count = model;
              itemUnsettled = true;
              unsettled = true;
            } else {
              count = found.length;
              this.domCounts.set(item.id, { text: item.text, count });
            }
          } else {
            this.mismatchSince.delete(item.id);
            count = found.length;
            this.domCounts.set(item.id, { text: item.text, count });
          }
        }
        this.ranges.set(item.id, found);
        this.live.set(item.id, { el, modelText: item.text, ranges: found, count, unsettled: itemUnsettled });
      } else {
        this.live.delete(item.id);
        const measured = this.domCounts.get(item.id);
        count = measured && measured.text === item.text ? measured.count : modelCountOf(item);
      }
      counts.push(count);
      total += count;
      if (total >= MAX_MATCHES) {
        total = MAX_MATCHES;
        counts.push(...new Array(items.length - counts.length).fill(0));
        break;
      }
    }

    this.reportedTotal = total;
    this.lastCounts = new Map(items.map((item, index) => [item.id, counts[index] ?? 0]));

    // 当前项：沿用原来的（按内容变化夹紧）；没有或已经没命中了就回到第一个。
    let cursor = this.cursor;
    const indexOfCursor = cursor ? items.findIndex((item) => item.id === cursor!.id) : -1;
    if (cursor && (indexOfCursor < 0 || counts[indexOfCursor] <= 0)) cursor = null;
    if (cursor) cursor = { id: cursor.id, occ: Math.min(cursor.occ, counts[indexOfCursor] - 1) };
    if (!cursor && total > 0) {
      const first = counts.findIndex((count) => count > 0);
      if (first >= 0) {
        cursor = { id: items[first].id, occ: 0 };
        this.pendingReveal = true;
      }
    }
    this.cursor = total > 0 ? cursor : null;

    // 宽限期内的「还没加载完」到点还要再算一次：可能不再有 DOM 变化来触发 MutationObserver。
    clearTimeout(this.settleRefresh);
    if (unsettled) this.settleRefresh = setTimeout(() => this.refresh(), SETTLE_MS + 50);

    this.emit();
  }

  /** 用已经扫好的 Range 更新高亮和计数，不再走 DOM。 */
  private emit(): void {
    const items = this.itemList();
    let current = 0;
    if (this.cursor && this.reportedTotal > 0) {
      let before = 0;
      for (let index = 0; index < items.length; index += 1) {
        if (items[index].id === this.cursor.id) break;
        before += this.lastCounts.get(items[index].id) ?? 0;
      }
      current = before + this.cursor.occ + 1;
    }
    const all: Range[] = [];
    for (const found of this.ranges.values()) all.push(...found);
    const currentRange = this.cursor ? (this.ranges.get(this.cursor.id)?.[this.cursor.occ] ?? null) : null;
    if (all.length > 0) contributions.set(this.id, { all, current: currentRange });
    else contributions.delete(this.id);
    publishHighlights();
    this.report({ total: this.reportedTotal, current });
  }

  private step(direction: 1 | -1): void {
    if (!this.active) return;
    this.recompute();
    const items = this.itemList();
    if (!this.cursor || items.length === 0) return;
    const countOf = (id: string): number => this.lastCounts.get(id) ?? 0;
    const at = items.findIndex((item) => item.id === this.cursor!.id);
    const occ = this.cursor.occ + direction;
    if (occ >= 0 && occ < countOf(this.cursor.id)) {
      this.cursor = { id: this.cursor.id, occ };
    } else {
      // 换到下一项 / 上一项里有命中的；走到头绕回另一端。
      for (let offset = 1; offset <= items.length; offset += 1) {
        const index = (((at + direction * offset) % items.length) + items.length) % items.length;
        const count = countOf(items[index].id);
        if (count > 0) {
          this.cursor = { id: items[index].id, occ: direction === 1 ? 0 : count - 1 };
          break;
        }
      }
    }
    this.pendingReveal = true;
    this.emit();
    this.reveal();
  }

  /** 把当前项滚进可见区：已渲染就直接定位；没渲染就请列表滚过去，渲染后再由 refresh 接着定位。 */
  private reveal(): void {
    const cursor = this.cursor;
    if (!cursor) {
      this.pendingReveal = false;
      return;
    }
    const range = this.ranges.get(cursor.id)?.[cursor.occ];
    if (!range) {
      if (this.options.scrollToItem) {
        this.options.scrollToItem(cursor.id);
        // 保持 pendingReveal：列表渲染出这一项后，MutationObserver 触发的 refresh 会再进来。
      } else {
        this.pendingReveal = false;
      }
      return;
    }
    this.pendingReveal = false;
    this.scrollRangeIntoView(range);
    // virtua 的 scrollToIndex 会在测高后再滚一次到条目顶部，可能把刚定位好的命中挡到视口外；
    // 等它安静下来再检查一次，当前项没变且不在可见区就再定位。
    clearTimeout(this.settleTimer);
    const snapshot = this.cursor;
    this.settleTimer = setTimeout(() => {
      if (!this.active || !snapshot || this.cursor?.id !== snapshot.id || this.cursor.occ !== snapshot.occ) return;
      const again = this.ranges.get(snapshot.id)?.[snapshot.occ];
      if (again) this.scrollRangeIntoView(again);
    }, 300);
  }

  private scrollRangeIntoView(range: Range): void {
    const listScroller = this.options.getScroller?.() ?? null;
    let node: HTMLElement | null = range.startContainer.parentElement;
    while (node) {
      if (node === listScroller || isScrollable(node)) {
        // 里层滚动区滚完位置变了，每一层都重新量。
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const box = node.getBoundingClientRect();
        const outside = rect.top < box.top + VISIBLE_MARGIN || rect.bottom > box.bottom - VISIBLE_MARGIN;
        if (outside) {
          const delta = rect.top - (box.top + box.height / 2 - rect.height / 2);
          if (node === listScroller && this.options.scrollBy) this.options.scrollBy(delta);
          else node.scrollBy({ top: delta });
        }
        if (node === listScroller) return;
      }
      node = node.parentElement;
    }
  }
}
