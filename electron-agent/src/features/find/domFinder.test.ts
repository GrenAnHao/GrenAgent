import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomFinder, highlightedRangeCount, type FindStatus, type FinderItem } from './domFinder';

// jsdom 没有 CSS Custom Highlight API 和 Range 的几何：装桩，记下注册了什么。
const registered = new Map<string, unknown[]>();
beforeEach(() => {
  registered.clear();
  class FakeHighlight {
    priority = 0;
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  Object.assign(globalThis, { Highlight: FakeHighlight });
  Object.assign(globalThis.CSS ?? (globalThis.CSS = {} as typeof CSS), {
    highlights: {
      set: (name: string, value: { ranges: Range[] }) => registered.set(name, value.ranges),
      delete: (name: string) => registered.delete(name),
    },
  });
  Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) });
});
// 高亮注册表是模块级的（会话和文件预览共用），每个用例用完要 dispose，不然会把上一个用例的命中带进来。
const finders: DomFinder[] = [];
afterEach(() => {
  for (const finder of finders.splice(0)) finder.dispose();
  document.body.innerHTML = '';
});

interface Setup {
  root: HTMLElement;
  statuses: FindStatus[];
  scrollToItem: ReturnType<typeof vi.fn>;
  finder: DomFinder;
  /** 让某些项处于「渲染出来」的状态。 */
  render: (ids: string[]) => void;
}

function setup(items: FinderItem[], domText: Record<string, string>, rendered: string[]): Setup {
  const root = document.createElement('div');
  document.body.append(root);
  const statuses: FindStatus[] = [];
  const scrollToItem = vi.fn();
  const render = (ids: string[]) => {
    root.innerHTML = '';
    for (const id of ids) {
      const el = document.createElement('div');
      el.dataset.findItem = id;
      el.innerHTML = `<p>${domText[id] ?? ''}</p>`;
      root.append(el);
    }
  };
  render(rendered);
  const finder = new DomFinder({
    getRoot: () => root,
    items: () => items,
    scrollToItem,
    onStatus: (status) => statuses.push(status),
  });
  finders.push(finder);
  return { root, statuses, scrollToItem, finder, render };
}

const last = (s: Setup) => s.statuses.at(-1);

describe('DomFinder（列表型：会话）', () => {
  const items: FinderItem[] = [
    { id: 'a', text: 'login here' },
    { id: 'b', text: 'nothing' },
    { id: 'c', text: 'login and login' },
  ];
  const dom = { a: 'login here', b: 'nothing', c: 'login and login' };

  it('渲染出来的项按 DOM 计数，当前项从第一个开始', () => {
    const s = setup(items, dom, ['a', 'b', 'c']);
    s.finder.setQuery('login');
    expect(last(s)).toEqual({ total: 3, current: 1 });
    expect(registered.get('gren-find')).toHaveLength(3);
    expect(registered.get('gren-find-current')).toHaveLength(1);
  });

  it('没渲染的项先按文字估算计数', () => {
    const s = setup(items, dom, ['a']);
    s.finder.setQuery('login');
    expect(last(s)).toEqual({ total: 3, current: 1 });
    // 只有渲染出来的那一项有高亮
    expect(registered.get('gren-find')).toHaveLength(1);
  });

  it('上一个 / 下一个逐个走，末尾回到开头，开头往前回到末尾', () => {
    const s = setup(items, dom, ['a', 'b', 'c']);
    s.finder.setQuery('login');
    s.finder.next();
    expect(last(s)?.current).toBe(2);
    s.finder.next();
    expect(last(s)?.current).toBe(3);
    s.finder.next();
    expect(last(s)?.current).toBe(1);
    s.finder.prev();
    expect(last(s)?.current).toBe(3);
    s.finder.prev();
    expect(last(s)?.current).toBe(2);
  });

  it('当前项在没渲染的消息里：请列表滚过去，渲染后再精确定位', async () => {
    const s = setup(items, dom, ['a']);
    s.finder.setQuery('login');
    s.finder.next(); // 第 2 处在 c（没渲染）
    expect(s.scrollToItem).toHaveBeenCalledWith('c');
    expect(last(s)?.current).toBe(2);
    s.render(['a', 'c']);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(last(s)).toEqual({ total: 3, current: 2 });
    expect(registered.get('gren-find-current')).toHaveLength(1);
    expect(registered.get('gren-find')).toHaveLength(3);
  });

  it('渲染后真实命中数和估算不同：以 DOM 为准，卸载后保留', async () => {
    const s = setup([{ id: 'a', text: 'login' }], { a: 'login login login' }, ['a']);
    s.finder.setQuery('login');
    expect(last(s)?.total).toBe(3);
    s.render([]);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(last(s)?.total).toBe(3);
  });

  it('刚挂上来的项内容还是空的（懒加载的代码块）：宽限期内按估算计，当前项不被重置，加载完后以 DOM 为准', async () => {
    const lazy: FinderItem[] = [
      { id: 'a', text: 'login here' },
      { id: 'b', text: 'const login = 1\nlogin()' },
    ];
    const s = setup(lazy, { a: 'login here', b: '' }, ['a']);
    s.finder.setQuery('login');
    s.finder.next();
    expect(last(s)).toEqual({ total: 3, current: 2 });
    s.render(['a', 'b']); // b 挂上来了，代码块还是空的
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(last(s)).toEqual({ total: 3, current: 2 });
    s.root.querySelector('[data-find-item="b"] p')!.textContent = 'const login = 1\nlogin()'; // 加载完
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))));
    expect(last(s)).toEqual({ total: 3, current: 2 });
    expect(registered.get('gren-find')).toHaveLength(3);
  });

  it('宽限期过后 DOM 仍然比估算少：真的少（折叠等），以 DOM 为准', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const s = setup([{ id: 'a', text: 'login login' }], { a: 'login' }, ['a']);
      s.finder.setQuery('login');
      expect(last(s)?.total).toBe(2);
      vi.advanceTimersByTime(1700);
      expect(last(s)?.total).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('改查询回到第一个命中；没有命中显示 0 / 0 并清掉高亮', () => {
    const s = setup(items, dom, ['a', 'b', 'c']);
    s.finder.setQuery('login');
    s.finder.next();
    s.finder.setQuery('and');
    expect(last(s)).toEqual({ total: 1, current: 1 });
    s.finder.setQuery('zzz');
    expect(last(s)).toEqual({ total: 0, current: 0 });
    expect(highlightedRangeCount()).toBe(0);
    expect(registered.has('gren-find')).toBe(false);
    s.finder.next();
    expect(last(s)).toEqual({ total: 0, current: 0 });
  });

  it('清空查询和关闭都清掉高亮', () => {
    const s = setup(items, dom, ['a', 'b', 'c']);
    s.finder.setQuery('login');
    s.finder.setQuery('');
    expect(highlightedRangeCount()).toBe(0);
    s.finder.setQuery('login');
    s.finder.clear();
    expect(registered.size).toBe(0);
    expect(last(s)).toEqual({ total: 0, current: 0 });
  });

  it('内容变化（流式增长）时 MutationObserver 重算，当前项保持', async () => {
    const s = setup(items, dom, ['a', 'b', 'c']);
    s.finder.setQuery('login');
    s.finder.next();
    expect(last(s)?.current).toBe(2);
    s.root.querySelector('[data-find-item="b"] p')!.textContent = 'now has login too';
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))));
    expect(last(s)?.total).toBe(4);
    // 第 2 处原本是 c 的第 1 处，b 多出一处之后它变成第 3
    expect(last(s)?.current).toBe(3);
  });

  it('只有文本变了的那一项重扫 DOM，上一项 / 下一项不再整表重扫', async () => {
    const s = setup(items, dom, ['a', 'b', 'c']);
    s.finder.setQuery('login');
    const scanned = s.finder.scanCount;
    s.finder.next();
    expect(s.finder.scanCount).toBe(scanned);
    expect(last(s)?.current).toBe(2);
    s.root.querySelector('[data-find-item="a"] p')!.textContent = 'login here login';
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))));
    expect(s.finder.scanCount - scanned).toBe(1);
    expect(last(s)?.total).toBe(4);
  });

  it('两个查找器同时在查：高亮取并集，互不覆盖', () => {
    const one = setup(items, dom, ['a', 'b', 'c']);
    const other = setup([{ id: 'x', text: 'login' }], { x: 'login' }, ['x']);
    one.finder.setQuery('login');
    other.finder.setQuery('login');
    expect(registered.get('gren-find')).toHaveLength(4);
    other.finder.dispose();
    expect(registered.get('gren-find')).toHaveLength(3);
  });
});

describe('DomFinder（整块：文件预览）', () => {
  it('没有 items 时把整个 root 当作一项', () => {
    const root = document.createElement('div');
    root.innerHTML = '<h1>Guide guide</h1><p>read the <b>guide</b></p>';
    document.body.append(root);
    const statuses: FindStatus[] = [];
    const finder = new DomFinder({ getRoot: () => root, onStatus: (s) => statuses.push(s) });
    finders.push(finder);
    finder.setQuery('guide');
    expect(statuses.at(-1)).toEqual({ total: 3, current: 1 });
    finder.next();
    finder.next();
    finder.next();
    expect(statuses.at(-1)?.current).toBe(1);
    expect(root.innerHTML).toBe('<h1>Guide guide</h1><p>read the <b>guide</b></p>');
  });
});
