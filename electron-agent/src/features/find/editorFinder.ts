import { closeSearchPanel, openSearchPanel, SearchQuery, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import type { FindDriver, FindStatus } from './domFinder';
import { MAX_MATCHES } from './findMatch';

/** 打字时合并重搜。跳转和换查询不走这个延迟，立刻用当前文档。 */
export const EDITOR_FIND_REFRESH_MS = 200;

interface Match {
  from: number;
  to: number;
}

/**
 * CodeMirror 的查找驱动。编辑器只渲染视口内的行，DOM 里扫不全，所以用它自己的 SearchQuery 在整份文档里数。
 * 高亮交给 CodeMirror（`.cm-searchMatch` / `.cm-searchMatch-selected`，样式见 CodeEditor 的主题）；它只在「搜索面板处于打开状态」时才画，
 * 所以这里打开一个隐藏的面板来激活高亮，真正的界面是我们自己的查找栏。
 * 当前项 = 被选中的那一处，跳转就是移动编辑器选区并滚到视口中部。
 */
export class EditorFinder implements FindDriver {
  private query = '';
  private matches: Match[] = [];
  private index = -1;
  private active = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly getView: () => EditorView | null,
    private readonly onStatus: (status: FindStatus) => void,
  ) {}

  setQuery(query: string): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    const view = this.getView();
    this.query = query;
    this.active = query.trim() !== '';
    if (!view) return;
    if (!this.active) {
      this.deactivate(view);
      this.report();
      return;
    }
    if (!searchPanelOpen(view.state)) openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query, caseSensitive: false, literal: true })) });
    this.collect(view);
    this.index = this.matches.length > 0 ? 0 : -1;
    this.select(view);
    this.report();
  }

  next(): void {
    this.step(1);
  }

  prev(): void {
    this.step(-1);
  }

  /** 文档变了（在编辑模式里打字）：合并到一次重搜，当前项尽量保持。 */
  refresh(): void {
    if (!this.active) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.recollect();
    }, EDITOR_FIND_REFRESH_MS);
  }

  clear(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    const view = this.getView();
    this.active = false;
    this.query = '';
    this.matches = [];
    this.index = -1;
    if (view) this.deactivate(view);
    this.report();
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    const view = this.getView();
    if (view && this.active) this.deactivate(view);
    this.active = false;
  }

  private deactivate(view: EditorView): void {
    if (searchPanelOpen(view.state)) closeSearchPanel(view);
    this.matches = [];
    this.index = -1;
  }

  private collect(view: EditorView): void {
    const matches: Match[] = [];
    const cursor = new SearchQuery({ search: this.query, caseSensitive: false, literal: true }).getCursor(view.state);
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      matches.push({ from: step.value.from, to: step.value.to });
      if (matches.length >= MAX_MATCHES) break;
    }
    this.matches = matches;
  }

  private recollect(): void {
    const view = this.getView();
    if (!view || !this.active) return;
    this.collect(view);
    this.index = this.matches.length === 0 ? -1 : Math.min(Math.max(this.index, 0), this.matches.length - 1);
    this.report();
  }

  private step(direction: 1 | -1): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    const view = this.getView();
    if (!view || !this.active) return;
    this.collect(view);
    if (this.matches.length === 0) {
      this.index = -1;
      this.report();
      return;
    }
    const length = this.matches.length;
    this.index = this.index < 0 ? 0 : (this.index + direction + length) % length;
    this.select(view);
    this.report();
  }

  private select(view: EditorView): void {
    const match = this.matches[this.index];
    if (!match) return;
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
    });
  }

  private report(): void {
    this.onStatus({ total: this.matches.length, current: this.index + 1 });
  }
}
