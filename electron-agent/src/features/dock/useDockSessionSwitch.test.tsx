import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useDockSessionSwitch } from './useDockSessionSwitch';
import { currentDockView, useDockStore, visibleRegionTabs } from '../../stores/dockStore';
import { useSessionStore } from '../../store/session';
import { useLayoutStore } from '../../stores/layoutStore';

function Harness() {
  useDockSessionSwitch();
  return null;
}

function reset() {
  localStorage.clear();
  useDockStore.setState({
    tabs: [],
    closedTabs: [],
    activeByRegion: { right: null, bottom: null },
    activeBySession: {},
    rightOpenBySession: {},
    rightFillBySession: {},
  });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false, rightPanelFill: false });
  useSessionStore.setState({
    worksDir: '/home/.pi/agent/works',
    activeSessionPath: '',
    activeWorkspace: '/ws',
    draftConversationCwd: '/ws',
    draftConversationId: 'draft:one',
  });
}

beforeEach(reset);
afterEach(cleanup);

/** 让微任务合并的那次切换跑完。 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useDockSessionSwitch', () => {
  it('当前草稿换成另一份（activeSessionPath 都没变）也触发一次会话视图切换', async () => {
    render(<Harness />);
    act(() => {
      useDockStore.getState().openPage({ url: 'https://one', content: '' });
    });
    expect(useDockStore.getState().tabs[0]).toMatchObject({ ownerSessionPath: null, ownerDraftId: 'draft:one' });

    act(() => {
      useSessionStore.setState({ draftConversationId: 'draft:two' });
    });
    await flush();

    // 草稿 one 的状态被存下来，画面切到全新的草稿 two（没有标签、右面板收起）。
    expect(useDockStore.getState().activeBySession['d:/ws#draft:one']?.right).toBe('page:https://one');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
    expect(visibleRegionTabs(useDockStore.getState().tabs, 'right', currentDockView())).toEqual([]);
  });

  it('草稿首发落盘（同一份 draftId 过户）：不按换会话处理，标签与展开态跟着新会话', async () => {
    render(<Harness />);
    act(() => {
      useDockStore.getState().openPage({ url: 'https://one', content: '' });
    });

    act(() => {
      useDockStore.getState().adoptDraftView('/ws', '/ws/new.jsonl', 'draft:one');
      useSessionStore.setState({
        activeSessionPath: '/ws/new.jsonl',
        draftConversationCwd: null,
        draftConversationId: null,
      });
    });
    await flush();

    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    expect(
      visibleRegionTabs(useDockStore.getState().tabs, 'right', currentDockView()).map((t) => t.id),
    ).toEqual(['page:https://one']);
  });
});
