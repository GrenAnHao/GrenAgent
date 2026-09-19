import { cleanup, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../store/session';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

const { ctx } = vi.hoisted(() => ({ ctx: { workspace: '/repo' } }));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ctx,
  useAgentStore: () => ({
    useStore: (selector: (s: { messages: unknown[] }) => unknown) => selector({ messages: [] }),
  }),
}));

import { DockPanel } from './DockPanel';

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
    useLayoutStore.setState({ rightPanelOpen: true, terminalOpen: true });
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
  });
});
