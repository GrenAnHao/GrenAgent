import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../store/session';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

const { ctx } = vi.hoisted(() => ({ ctx: { workspace: '/repo' } }));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ctx,
  useOptionalAgentStoreContext: () => ctx,
  useAgentStore: () => ({
    useStore: (selector: (s: { messages: unknown[] }) => unknown) => selector({ messages: [] }),
  }),
}));

import { DockPanel } from './DockPanel';
import { useDockSessionSwitch } from './useDockSessionSwitch';

function renderPanel(region: 'right' | 'bottom' = 'right', onCollapse?: () => void) {
  return render(
    <DndContext>
      <DockPanel region={region} onCollapse={onCollapse} />
    </DndContext>,
  );
}

describe('DockPanel empty launcher', () => {
  beforeEach(() => {
    localStorage.clear();
    useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
    useLayoutStore.setState({ rightPanelOpen: true, terminalOpen: true, rightPanelFill: false });
    useSessionStore.setState({ worksDir: '/home/.pi/agent/works' });
    ctx.workspace = '/repo';
  });
  afterEach(cleanup);

  it('renders the launcher and no tab strip or empty hint when there are no tabs', () => {
    renderPanel('right', () => undefined);
    expect(screen.getByTestId('dock-launcher-right')).toBeTruthy();
    expect(screen.queryByTestId('dock-strip-right')).toBeNull();
    expect(screen.queryByText(/暂无内容/)).toBeNull();
    expect(screen.queryByTitle('打开浏览器')).toBeNull();
    expect(screen.queryByTitle('新建标签')).toBeNull();
    expect(screen.queryByTitle('搜索标签页')).toBeNull();
    expect(screen.getByTitle('Collapse panel')).toBeTruthy();
    expect(screen.getByRole('button', { name: '占满界面' })).toBeTruthy();
  });

  it('占满按钮在右侧面板里切换成还原', () => {
    renderPanel('right', () => undefined);
    fireEvent.click(screen.getByRole('button', { name: '占满界面' }));
    expect(screen.getByRole('button', { name: '还原面板' })).toBeTruthy();
    expect(useLayoutStore.getState().rightPanelFill).toBe(true);
  });

  it('shows the tab strip with list and add buttons once a tab exists', () => {
    useDockStore.getState().addTab({
      id: 'browser-1',
      kind: 'browser',
      region: 'right',
      title: '浏览器',
      closable: true,
      payload: { url: 'https://example.com', title: '浏览器' },
    });
    renderPanel('right', () => undefined);
    expect(screen.queryByTestId('dock-launcher-right')).toBeNull();
    expect(screen.getByTestId('dock-strip-right')).toBeTruthy();
    expect(screen.getByTitle('搜索标签页')).toBeTruthy();
    expect(screen.getByTitle('新建标签')).toBeTruthy();
    expect(screen.queryByTitle('打开浏览器')).toBeNull();
  });

  it('hides strip chrome on an empty bottom dock', () => {
    renderPanel('bottom');
    expect(screen.getByTestId('dock-launcher-bottom')).toBeTruthy();
    expect(screen.queryByTitle('新建终端')).toBeNull();
    expect(screen.queryByTitle('新建标签')).toBeNull();
    expect(screen.queryByTestId('dock-strip-bottom')).toBeNull();
    expect(screen.queryByRole('button', { name: '占满界面' })).toBeNull();
  });
});

describe('DockPanel session-owned tabs', () => {
  function Harness() {
    useDockSessionSwitch();
    return (
      <DndContext>
        <DockPanel region="right" />
      </DndContext>
    );
  }

  beforeEach(() => {
    localStorage.clear();
    useDockStore.setState({
      tabs: [],
      closedTabs: [],
      activeByRegion: { right: null, bottom: null },
      activeBySession: {},
      rightOpenBySession: {},
    });
    useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false, rightPanelFill: false });
    useSessionStore.setState({ worksDir: '/home/.pi/agent/works', activeSessionPath: '/ws/a.jsonl', activeWorkspace: '/ws' });
  });
  afterEach(cleanup);

  async function switchSession(path: string, workspace = '/ws') {
    await act(async () => {
      useSessionStore.setState({ activeSessionPath: path, activeWorkspace: workspace });
      await Promise.resolve();
    });
  }

  it('does not carry a subagent tab from session A into session B', async () => {
    render(<Harness />);
    act(() => {
      useDockStore.getState().openSubAgent({ messageId: 'm1', toolCallId: 'c1', subIndex: 2, title: '#2 接着完成「子账号」' });
    });
    expect(screen.getByText('#2 接着完成「子账号」')).toBeTruthy();
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);

    await switchSession('/other/b.jsonl', '/other');
    expect(screen.queryByText('#2 接着完成「子账号」')).toBeNull();
    expect(screen.getByTestId('dock-launcher-right')).toBeTruthy();
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);

    await switchSession('/ws/a.jsonl');
    expect(screen.getByText('#2 接着完成「子账号」')).toBeTruthy();
    expect(screen.getByTestId('dock-body-m1#2').style.display).toBe('flex');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('在 A 里用启动页打开的标签不会在 B 的右栏里出现，B 看到的是自己的空右栏', async () => {
    render(<Harness />);
    act(() => {
      useLayoutStore.getState().setRightPanelOpen(true);
    });
    fireEvent.click(screen.getByTestId('dock-launcher-browser'));
    expect(screen.getByTestId('dock-strip-right')).toBeTruthy();
    expect(useDockStore.getState().tabs[0]).toMatchObject({ kind: 'browser', ownerSessionPath: '/ws/a.jsonl' });

    await switchSession('/ws/b.jsonl');
    expect(screen.queryByTestId('dock-strip-right')).toBeNull();
    expect(screen.getByTestId('dock-launcher-right')).toBeTruthy();
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);

    await switchSession('/ws/a.jsonl');
    expect(screen.getByTestId('dock-strip-right')).toBeTruthy();
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('切到 B 时 A 的常驻标签（网页 / 终端一类）只藏起来，切回 A 还是同一个实例', async () => {
    render(<Harness />);
    act(() => {
      useDockStore.getState().openPage({ url: 'https://a', content: 'A 的网页', title: 'A 页' });
    });
    const body = screen.getByTestId('dock-body-page:https://a');

    await switchSession('/ws/b.jsonl');
    expect(screen.queryByTestId('dock-strip-right')).toBeNull();
    expect(screen.getByTestId('dock-launcher-right')).toBeTruthy();
    expect(screen.getByTestId('dock-body-page:https://a')).toBe(body);
    expect((body.parentElement as HTMLElement).style.display).toBe('none');

    await switchSession('/ws/a.jsonl');
    expect(screen.getByTestId('dock-body-page:https://a')).toBe(body);
    expect(body.style.display).toBe('flex');
    expect((body.parentElement as HTMLElement).style.display).toBe('');
  });
});
