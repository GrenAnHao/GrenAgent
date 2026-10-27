import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorFinder, EDITOR_FIND_REFRESH_MS } from './editorFinder';

describe('EditorFinder', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('连续改文档时合并重搜，跳转立刻按最新文档计', () => {
    vi.useFakeTimers();
    // CodeMirror 测字号会读 Range.getClientRects；jsdom 没有这个方法，假计时器一推进就会走到。
    const emptyRects = () => ({ length: 0, item: () => null }) as unknown as DOMRectList;
    Range.prototype.getClientRects = emptyRects;
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({ state: EditorState.create({ doc: 'login' }), parent });
    const statuses: Array<{ total: number; current: number }> = [];
    const finder = new EditorFinder(() => view, (status) => statuses.push(status));
    finder.setQuery('login');
    expect(statuses.at(-1)).toEqual({ total: 1, current: 1 });

    view.dispatch({ changes: { from: 5, insert: ' login' } });
    finder.refresh();
    finder.refresh();
    expect(statuses.at(-1)?.total).toBe(1);

    vi.advanceTimersByTime(EDITOR_FIND_REFRESH_MS);
    expect(statuses.at(-1)).toEqual({ total: 2, current: 1 });

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' login' } });
    finder.refresh();
    finder.next();
    expect(statuses.at(-1)?.total).toBe(3);

    finder.dispose();
    view.destroy();
    parent.remove();
  });
});
