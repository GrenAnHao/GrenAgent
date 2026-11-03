import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { AgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import { useSessionViewExpandedState } from './useSessionViewExpanded';
import {
  resetSessionViewStateForTests,
  sessionViewStateKeyFor,
  useSessionViewStateStore,
} from '../../stores/sessionViewStateStore';

const A = '/ws/.pi/a.jsonl';
const B = '/ws/.pi/b.jsonl';
const storageKey = (ownerKey: string) =>
  typeof ownerKey === 'string' ? sessionViewStateKeyFor(ownerKey) : '';

beforeEach(() => {
  localStorage.clear();
  resetSessionViewStateForTests();
  useSessionStore.setState({
    activeSessionPath: A,
    activeWorkspace: '/ws',
    draftConversationCwd: null,
    draftConversationId: null,
  });
});

afterEach(cleanup);

function Probe({ viewId, defaultExpanded }: { viewId: string; defaultExpanded?: boolean }) {
  const { expanded, toggle, setExpanded, persisted } = useSessionViewExpandedState(viewId, defaultExpanded);
  return (
    <>
      <button type="button" data-testid="toggle" data-expanded={String(expanded)} data-persisted={String(persisted)} onClick={toggle}>
        {expanded ? 'open' : 'closed'}
      </button>
      {/* 既有调用点的写法：setExpanded(v => !v)。 */}
      <button type="button" data-testid="updater" onClick={() => setExpanded((previous) => !previous)}>
        updater
      </button>
      {/* 同一次渲染/同一个 act 内连续翻转两次：第二次必须基于第一次写入后的最新值。 */}
      <button
        type="button"
        data-testid="toggle-twice"
        onClick={() => {
          toggle();
          toggle();
        }}
      >
        toggle twice
      </button>
    </>
  );
}

function renderInScope(ui: React.ReactElement, scope?: { sessionPath?: string | null; draftId?: string | null }) {
  return render(
    <AgentStoreContext.Provider
      value={{
        workspace: '/ws',
        store: {} as never,
        workspaceReady: true,
        setWorkspaceReady: () => {},
        appBooted: true,
        ...(scope ?? {}),
      }}
    >
      {ui}
    </AgentStoreContext.Provider>,
  );
}

const expandedOf = (view: ReturnType<typeof renderInScope>) =>
  within(view.container).getByTestId('toggle').dataset.expanded;

describe('useSessionViewExpandedState', () => {
  it('A 展开 → B 独立收起 → 回到 A 恢复；同一 toolCallId 不串', () => {
    const first = renderInScope(<Probe viewId="tool:c1" />);
    act(() => {
      within(first.container).getByTestId('toggle').click();
    });
    expect(expandedOf(first)).toBe('true');
    // 落到了会话 A 名下。
    expect(useSessionViewStateStore.getState().isExpanded(A, 'tool:c1')).toBe(true);
    expect(useSessionViewStateStore.getState().isExpanded(B, 'tool:c1')).toBeUndefined();
    first.unmount();

    act(() => {
      useSessionStore.setState({ activeSessionPath: B });
    });
    const second = renderInScope(<Probe viewId="tool:c1" />);
    expect(expandedOf(second)).toBe('false');
    second.unmount();

    act(() => {
      useSessionStore.setState({ activeSessionPath: A });
    });
    const third = renderInScope(<Probe viewId="tool:c1" />);
    expect(expandedOf(third)).toBe('true');
  });

  it('卸载重挂与页面重载后恢复', () => {
    const first = renderInScope(<Probe viewId="context:c2" />);
    act(() => {
      within(first.container).getByTestId('toggle').click();
    });
    first.unmount();

    const again = renderInScope(<Probe viewId="context:c2" />);
    expect(expandedOf(again)).toBe('true');
    again.unmount();

    // 整页重载：内存清空，只剩 localStorage。
    resetSessionViewStateForTests({ keepStorage: true });
    act(() => {
      useSessionViewStateStore.getState().hydrateFromStorage();
    });
    const reloaded = renderInScope(<Probe viewId="context:c2" />);
    expect(expandedOf(reloaded)).toBe('true');
  });

  it('用户关闭后，默认自动展开不再把它重新打开', () => {
    const { getByTestId, unmount } = renderInScope(<Probe viewId="tool:auto" defaultExpanded />);
    expect(getByTestId('toggle').dataset.expanded).toBe('true');
    act(() => {
      getByTestId('toggle').click();
    });
    expect(getByTestId('toggle').dataset.expanded).toBe('false');
    unmount();

    const again = renderInScope(<Probe viewId="tool:auto" defaultExpanded />);
    expect(again.getByTestId('toggle').dataset.expanded).toBe('false');
  });

  it('Provider 显式 scope 优先于全局 activeSessionPath（同 renderer 两个视图）', () => {
    const viewA = renderInScope(<Probe viewId="tool:dup" />, { sessionPath: A });
    const viewB = renderInScope(<Probe viewId="tool:dup" />, { sessionPath: B });
    const probeA = within(viewA.container).getByTestId('toggle');
    const probeB = within(viewB.container).getByTestId('toggle');
    act(() => {
      probeA.click();
    });
    expect(probeA.dataset.expanded).toBe('true');
    expect(probeB.dataset.expanded).toBe('false');
    expect(useSessionViewStateStore.getState().isExpanded(B, 'tool:dup')).toBeUndefined();
  });

  it('草稿用 draftId 隔离：另一份草稿看不到、看不到同项目会话的记录', () => {
    const draftOne = renderInScope(<Probe viewId="tool:d" />, { sessionPath: null, draftId: 'draft:one' });
    act(() => {
      within(draftOne.container).getByTestId('toggle').click();
    });
    expect(useSessionViewStateStore.getState().isExpanded('draft:one', 'tool:d')).toBe(true);
    draftOne.unmount();

    const draftTwo = renderInScope(<Probe viewId="tool:d" />, { sessionPath: null, draftId: 'draft:two' });
    expect(expandedOf(draftTwo)).toBe('false');
    expect(useSessionViewStateStore.getState().isExpanded(A, 'tool:d')).toBeUndefined();
  });

  it('函数式 setter：落盘布尔值，连续调用读最新值', () => {
    const view = renderInScope(<Probe viewId="tool:updater" />);
    act(() => {
      within(view.container).getByTestId('updater').click();
      within(view.container).getByTestId('updater').click();
    });
    expect(typeof useSessionViewStateStore.getState().isExpanded(A, 'tool:updater')).toBe('boolean');
    expect(useSessionViewStateStore.getState().isExpanded(A, 'tool:updater')).toBe(false);
    expect(JSON.parse(localStorage.getItem(storageKey(A))!).tool).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(storageKey(A))!)['tool:updater']).toBe(false);
  });

  it('函数式 setter：默认自动展开时 previous 取生效值，不是 undefined', () => {
    const view = renderInScope(<Probe viewId="tool:updater-default" defaultExpanded />);
    expect(expandedOf(view)).toBe('true');
    act(() => {
      within(view.container).getByTestId('updater').click();
    });
    expect(expandedOf(view)).toBe('false');
    expect(useSessionViewStateStore.getState().isExpanded(A, 'tool:updater-default')).toBe(false);
  });

  it('无身份时函数式 setter 走本地 state，不写全局 key', () => {
    const view = renderInScope(<Probe viewId="tool:local-updater" />, { sessionPath: null, draftId: null });
    act(() => {
      fireEvent.click(within(view.container).getByTestId('updater'));
    });
    expect(expandedOf(view)).toBe('true');
    act(() => {
      fireEvent.click(within(view.container).getByTestId('updater'));
    });
    expect(expandedOf(view)).toBe('false');
    expect(localStorage.length).toBe(0);
  });

  it('toggle：同一 act 连续两次基于最新值翻转，落回原状态', () => {
    const view = renderInScope(<Probe viewId="tool:toggle-twice" />);
    expect(expandedOf(view)).toBe('false');
    act(() => {
      within(view.container).getByTestId('toggle-twice').click();
    });
    expect(useSessionViewStateStore.getState().isExpanded(A, 'tool:toggle-twice')).toBe(false);
    expect(expandedOf(view)).toBe('false');

    // 一开始就是自动展开的项：连续两次也应回到展开。
    cleanup();
    const auto = renderInScope(<Probe viewId="tool:toggle-twice-auto" defaultExpanded />);
    expect(expandedOf(auto)).toBe('true');
    act(() => {
      within(auto.container).getByTestId('toggle-twice').click();
    });
    expect(useSessionViewStateStore.getState().isExpanded(A, 'tool:toggle-twice-auto')).toBe(true);
    expect(expandedOf(auto)).toBe('true');
  });

  it('没有身份的视图只保留本地 state，不写全局 key', () => {
    const { getByTestId } = renderInScope(<Probe viewId="tool:none" />, { sessionPath: null, draftId: null });
    expect(getByTestId('toggle').dataset.persisted).toBe('false');
    act(() => {
      getByTestId('toggle').click();
    });
    expect(getByTestId('toggle').dataset.expanded).toBe('true');
    expect(localStorage.getItem('pi-session-view-state')).toBeNull();
    expect(Object.keys(useSessionViewStateStore.getState().byOwner)).toEqual([]);
  });
});
