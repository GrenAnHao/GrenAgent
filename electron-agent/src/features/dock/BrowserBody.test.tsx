// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { updateTab } = vi.hoisted(() => ({ updateTab: vi.fn() }));
vi.mock('../../stores/dockStore', () => ({
  useDockStore: (selector: (state: { updateTab: typeof updateTab }) => unknown) => selector({ updateTab }),
}));
import { BrowserBody } from './BrowserBody';

describe('BrowserBody', () => {
  beforeEach(() => {
    cleanup();
    updateTab.mockReset();
  });

  it('keeps the webview below a DOM-owned browser toolbar', () => {
    const tab = {
      id: 'browser-1',
      kind: 'browser' as const,
      region: 'right' as const,
      title: '浏览器',
      closable: true,
      order: 0,
      payload: { url: 'https://example.com', title: '浏览器' },
    };
    render(<BrowserBody tab={tab} active />);

    expect((screen.getByRole('textbox', { name: '地址' }) as HTMLInputElement).value).toBe('https://example.com');
    expect((screen.getByRole('button', { name: '后退' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.gren-browser-toolbar')).toBeTruthy();
    expect(document.querySelector('.gren-browser-content webview')).toBeTruthy();
  });

  it('normalizes a host entered in the address bar', () => {
    const loadURL = vi.fn(() => Promise.resolve());
    const tab = {
      id: 'browser-2',
      kind: 'browser' as const,
      region: 'right' as const,
      title: '浏览器',
      closable: true,
      order: 0,
      payload: { url: 'about:blank' },
    };
    render(<BrowserBody tab={tab} active />);
    const view = document.querySelector('webview') as HTMLElement & { loadURL: typeof loadURL };
    view.loadURL = loadURL;
    const address = screen.getByRole('textbox', { name: '地址' });
    fireEvent.change(address, { target: { value: 'example.org' } });
    fireEvent.submit(address.closest('form')!);
    expect(loadURL).toHaveBeenCalledWith('https://example.org');
  });
});
