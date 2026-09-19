import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDockStore, type DockTab } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

vi.mock('@lobehub/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lobehub/ui')>();
  return {
    ...actual,
    Popover: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
      <div>
        {children}
        {content}
      </div>
    ),
  };
});

import { DockTabSwitcher } from './DockTabSwitcher';

afterEach(cleanup);

const openTab: DockTab = {
  id: 'browser-1',
  kind: 'browser',
  region: 'right',
  title: '百度一下，你就知道',
  closable: true,
  order: 0,
  payload: { url: 'https://www.baidu.com', title: '百度一下，你就知道' },
  touchedAt: Date.parse('2026-09-15T00:00:00Z'),
};

function resetStores() {
  localStorage.clear();
  useDockStore.setState({
    tabs: [openTab],
    closedTabs: [],
    activeByRegion: { right: 'browser-1', bottom: null },
  });
  useLayoutStore.setState({ rightPanelOpen: true, terminalOpen: false });
}

describe('DockTabSwitcher', () => {
  beforeEach(resetStores);

  it('lists open tabs and activates on row click', () => {
    const onActivate = vi.fn();
    render(
      <DockTabSwitcher region="right" tabs={[openTab]} onActivate={onActivate} onClose={() => undefined} />,
    );
    expect(screen.getByPlaceholderText('搜索标签页...')).toBeTruthy();
    expect(screen.getByText('打开的标签页')).toBeTruthy();
    fireEvent.click(screen.getByTestId('dock-switcher-open-browser-1'));
    expect(onActivate).toHaveBeenCalledWith('browser-1');
  });

  it('closes an open tab from the list without activating it', () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(<DockTabSwitcher region="right" tabs={[openTab]} onActivate={onActivate} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('dock-switcher-close-browser-1'));
    expect(onClose).toHaveBeenCalledWith('browser-1');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('shows recently closed tabs for this region and restores them', () => {
    useDockStore.getState().closeTab('browser-1');
    const keep: DockTab = {
      ...openTab,
      id: 'browser-keep',
      title: '保留',
    };
    useDockStore.setState({
      tabs: [keep],
      activeByRegion: { right: keep.id, bottom: null },
    });
    const closed = useDockStore.getState().closedTabs[0];
    expect(closed.title).toBe('百度一下，你就知道');

    render(
      <DockTabSwitcher region="right" tabs={[keep]} onActivate={() => undefined} onClose={() => undefined} />,
    );
    expect(screen.getByText('最近关闭的标签页')).toBeTruthy();
    fireEvent.click(screen.getByTestId('dock-switcher-closed-browser-1'));
    expect(useDockStore.getState().tabs.some((t) => t.id === 'browser-1')).toBe(true);
    expect(useDockStore.getState().closedTabs).toHaveLength(0);
  });

  it('filters open and closed rows by search', () => {
    useDockStore.setState({
      closedTabs: [
        {
          id: 'review:right',
          kind: 'review',
          region: 'right',
          title: '审查',
          closable: true,
          payload: {},
          closedAt: Date.now(),
        },
      ],
    });
    render(
      <DockTabSwitcher region="right" tabs={[openTab]} onActivate={() => undefined} onClose={() => undefined} />,
    );
    fireEvent.change(screen.getByTestId('dock-switcher-search'), { target: { value: '审查' } });
    expect(screen.queryByTestId('dock-switcher-open-browser-1')).toBeNull();
    expect(screen.getByTestId('dock-switcher-closed-review:right')).toBeTruthy();
  });
});
