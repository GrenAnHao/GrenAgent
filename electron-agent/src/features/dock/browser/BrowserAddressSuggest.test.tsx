// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserAddressSuggest } from './BrowserAddressSuggest';
import type { BrowserHistorySuggestion } from './browserHistory';

const items: BrowserHistorySuggestion[] = [
  { kind: 'typed', url: 'https://123pan.com', title: '123pan.com' },
  {
    kind: 'tab',
    url: 'https://123pan.com/',
    title: '123云盘',
    openTabId: 'tab-2',
    openTabRegion: 'right',
  },
];

describe('BrowserAddressSuggest', () => {
  it('does not render when closed', () => {
    render(
      <BrowserAddressSuggest
        open={false}
        items={items}
        filter="all"
        activeIndex={0}
        onFilter={() => {}}
        onHover={() => {}}
        onPick={() => {}}
        onSwitchTab={() => {}}
      />,
    );
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picks a typed row and switches an open tab', () => {
    const onPick = vi.fn();
    const onSwitchTab = vi.fn();
    render(
      <BrowserAddressSuggest
        open
        items={items}
        filter="all"
        activeIndex={0}
        onFilter={() => {}}
        onHover={() => {}}
        onPick={onPick}
        onSwitchTab={onSwitchTab}
      />,
    );
    fireEvent.click(screen.getByRole('option', { name: /^123pan.com/ }));
    expect(onPick).toHaveBeenCalledWith(items[0]);
    fireEvent.click(screen.getByRole('button', { name: '切换到此标签页' }));
    expect(onSwitchTab).toHaveBeenCalledWith(items[1]);
  });

  it('toggles the history filter', () => {
    const onFilter = vi.fn();
    render(
      <BrowserAddressSuggest
        open
        items={[]}
        filter="all"
        activeIndex={0}
        onFilter={onFilter}
        onHover={() => {}}
        onPick={() => {}}
        onSwitchTab={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '历史记录' }));
    expect(onFilter).toHaveBeenCalledWith('history');
    expect(screen.getByText('暂无访问记录')).toBeTruthy();
  });
});
