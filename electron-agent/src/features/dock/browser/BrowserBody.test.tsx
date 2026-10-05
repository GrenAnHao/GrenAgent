// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updateTab, attachGuest, detachGuest, setActive, history } = vi.hoisted(() => ({
  updateTab: vi.fn(),
  attachGuest: vi.fn(),
  detachGuest: vi.fn(),
  setActive: vi.fn(),
  history: {
    remember: vi.fn(),
    entries: [] as Array<{ url: string; title: string; visitedAt: number }>,
    tabs: [] as Array<{
      id: string;
      kind: string;
      region: 'right' | 'bottom';
      title: string;
      closable: boolean;
      order: number;
      payload: { url: string; title?: string };
    }>,
  },
}));

vi.mock('../../../stores/dockStore', () => ({
  useDockStore: (selector: (state: {
    updateTab: typeof updateTab;
    setActive: typeof setActive;
    tabs: typeof history.tabs;
  }) => unknown) => selector({ updateTab, setActive, tabs: history.tabs }),
}));

vi.mock('./browserHistoryStore', () => ({
  useBrowserHistoryStore: (selector: (state: {
    entries: typeof history.entries;
    remember: typeof history.remember;
  }) => unknown) => selector({ entries: history.entries, remember: history.remember }),
}));

vi.mock('../../../platform/runtime', () => ({
  getBrowser: () => ({ attachGuest, detachGuest }),
}));

import { BrowserBody } from './BrowserBody';
import { isBrowserErrorPageUrl } from './browserNavigation';

let nextWebContentsId = 11;
let currentUrl = 'https://example.com/';
const originalCreateElement = document.createElement.bind(document);

function installFakeWebview(element: HTMLElement) {
  return Object.assign(element, {
    getWebContentsId: () => nextWebContentsId,
    getURL: () => currentUrl,
    canGoBack: () => false,
    canGoForward: () => false,
    loadURL: vi.fn(() => Promise.resolve()),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve({ status: 'cancelled' })),
  });
}

function browserTab(overrides: { id?: string; url?: string } = {}) {
  return {
    id: overrides.id ?? 'browser-9',
    kind: 'browser' as const,
    region: 'right' as const,
    title: '浏览器',
    closable: true,
    order: 0,
    payload: { url: overrides.url ?? 'https://example.com', title: '浏览器' },
  };
}

function getView() {
  return document.querySelector('webview') as HTMLElement & {
    loadURL: ReturnType<typeof vi.fn>;
    executeJavaScript: ReturnType<typeof vi.fn>;
  };
}

function dispatchFail(view: HTMLElement, details: {
  errorCode: number;
  errorDescription: string;
  isMainFrame: boolean;
  validatedURL?: string;
}) {
  act(() => {
    view.dispatchEvent(Object.assign(new Event('did-fail-load'), details));
  });
}

function dispatchGone(view: HTMLElement, details: { reason: string; exitCode?: number }) {
  act(() => {
    const gone = new Event('render-process-gone');
    Object.assign(gone, { details });
    view.dispatchEvent(gone);
  });
}

describe('BrowserBody', () => {
  beforeEach(() => {
    nextWebContentsId = 11;
    currentUrl = 'https://example.com/';
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      return tagName === 'webview' ? installFakeWebview(element) : element;
    }) as typeof document.createElement;
    cleanup();
    updateTab.mockReset();
    attachGuest.mockReset();
    detachGuest.mockReset();
    setActive.mockReset();
    history.remember.mockReset();
    history.entries.splice(0);
    history.tabs.splice(0);
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
  });

  it('sets allowpopups as the string true and keeps the toolbar without webpreferences', () => {
    render(<BrowserBody tab={browserTab({ id: 'browser-9' })} active />);

    expect(document.querySelector('.gren-browser-toolbar')).toBeTruthy();
    expect(screen.getByRole('button', { name: '后退' })).toBeTruthy();
    const view = getView();
    expect(view.getAttribute('allowpopups')).toBe('true');
    expect(view.hasAttribute('webpreferences')).toBe(false);
  });

  it('loads a host entered in the address bar with https', () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    const address = screen.getByRole('textbox', { name: '地址' });
    fireEvent.change(address, { target: { value: 'example.org' } });
    fireEvent.submit(address.closest('form')!);
    expect(view.loadURL).toHaveBeenCalledWith('https://example.org');
  });

  it('does not loadURL when new-window is dispatched', () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    act(() => {
      view.dispatchEvent(Object.assign(new Event('new-window'), { url: 'https://example.org/next' }));
    });
    expect(view.loadURL).not.toHaveBeenCalled();
  });

  it('ignores subframe and aborted did-fail-load errors', () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    dispatchFail(view, { errorCode: -2, errorDescription: 'ERR_FAILED', isMainFrame: false });
    dispatchFail(view, { errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true });
    expect(view.loadURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: '无法访问此站点' })).toBeNull();
  });

  it('loads a guest error document and pins the address bar to the failed URL', () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    currentUrl = 'chrome-error://chromewebdata/';
    dispatchFail(view, {
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      validatedURL: 'http://127.0.0.1:5191/task-layout-preview/',
      isMainFrame: true,
    });
    act(() => {
      view.dispatchEvent(new Event('did-navigate'));
    });
    expect(view.loadURL).toHaveBeenCalledTimes(1);
    const pageUrl = String(view.loadURL.mock.calls[0][0]);
    expect(isBrowserErrorPageUrl(pageUrl)).toBe(true);
    expect(decodeURIComponent(pageUrl)).toContain('无法访问此站点');
    expect(decodeURIComponent(pageUrl)).toContain('127.0.0.1 拒绝建立连接');
    expect(screen.queryByRole('heading', { name: '无法访问此站点' })).toBeNull();
    expect(view.style.display).not.toBe('none');
    expect(screen.getByRole('textbox', { name: '地址' })).toHaveValue('http://127.0.0.1:5191/task-layout-preview/');
    expect(updateTab.mock.calls.some(([, patch]) => String(patch?.payload?.url ?? '').startsWith('chrome-error:'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(view.loadURL).toHaveBeenLastCalledWith('http://127.0.0.1:5191/task-layout-preview/');
  });

  it('does not cover a loaded page with a full-viewport loading overlay', () => {
    render(<BrowserBody tab={browserTab()} active />);
    expect(screen.queryByText('正在加载…')).toBeNull();
    act(() => {
      getView().dispatchEvent(new Event('did-start-loading'));
    });
    expect(screen.queryByText('正在加载…')).toBeNull();
    expect(screen.getByRole('button', { name: '刷新' })).toHaveAttribute('aria-busy', 'true');
    act(() => {
      getView().dispatchEvent(new Event('did-stop-loading'));
    });
    expect(screen.getByRole('button', { name: '刷新' })).toHaveAttribute('aria-busy', 'false');
  });

  it('drops the bootstrap src after did-attach so later renders cannot reload it', () => {
    const tab = browserTab({ url: 'https://example.com' });
    const { rerender } = render(<BrowserBody tab={tab} active />);
    const view = getView();
    expect(view.getAttribute('src')).toBe('https://example.com');
    act(() => {
      view.dispatchEvent(new Event('did-attach'));
    });
    expect(view.hasAttribute('src')).toBe(false);
    rerender(<BrowserBody tab={{ ...tab, payload: { url: 'https://www.bilibili.com/', title: '浏览器' } }} active />);
    expect(getView().hasAttribute('src')).toBe(false);
  });

  it('does not console.error when loadURL rejects with a Chromium network error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    view.loadURL.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_NAME_NOT_RESOLVED (-105) loading 'https://www.bing.cn/'",
      ),
    );
    const address = screen.getByRole('textbox', { name: '地址' });
    fireEvent.change(address, { target: { value: 'www.bing.cn' } });
    fireEvent.submit(address.closest('form')!);
    await waitFor(() => {
      expect(view.loadURL).toHaveBeenCalledWith('https://www.bing.cn');
    });
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('attaches the guest after did-attach with tabId and webContentsId', () => {
    const tab = browserTab({ id: 'browser-9' });
    render(<BrowserBody tab={tab} active />);
    act(() => {
      getView().dispatchEvent(new Event('did-attach'));
    });
    expect(attachGuest).toHaveBeenCalledWith({ tabId: tab.id, webContentsId: 11 });
  });

  it('does not change webview src when the payload url changes', () => {
    const tab = browserTab({ url: 'https://example.com' });
    const { rerender } = render(<BrowserBody tab={tab} active />);
    const view = getView();
    rerender(<BrowserBody tab={{ ...tab, payload: { url: 'https://www.bilibili.com/', title: '浏览器' } }} active />);
    expect(view.getAttribute('src')).toBe('https://example.com');
  });

  it('does not loadURL on gren:webview-open ipc-message', () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    act(() => {
      view.dispatchEvent(Object.assign(new Event('ipc-message'), {
        channel: 'gren:webview-open',
        args: ['https://example.org/from-ipc'],
      }));
    });
    expect(view.loadURL).not.toHaveBeenCalled();
  });

  it('does not load javascript: URLs from the address bar', () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    const address = screen.getByRole('textbox', { name: '地址' });
    fireEvent.change(address, { target: { value: 'javascript:alert(1)' } });
    fireEvent.submit(address.closest('form')!);
    expect(view.loadURL).not.toHaveBeenCalled();
  });

  it('detaches the guest on unmount', () => {
    const tab = browserTab({ id: 'browser-9' });
    const { unmount } = render(<BrowserBody tab={tab} active />);
    unmount();
    expect(detachGuest).toHaveBeenCalledWith({ tabId: tab.id });
  });

  it('does not overlay a certificate failure; the guest loads the error document', () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    currentUrl = 'chrome-error://chromewebdata/';
    dispatchFail(view, {
      errorCode: -202,
      errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
      validatedURL: 'https://bad.test/',
      isMainFrame: true,
    });
    expect(isBrowserErrorPageUrl(String(view.loadURL.mock.calls[0][0]))).toBe(true);
    expect(decodeURIComponent(String(view.loadURL.mock.calls[0][0]))).toContain('您的连接不是私密连接');
    expect(screen.queryByRole('heading', { name: '您的连接不是私密连接' })).toBeNull();
    expect(view.style.display).not.toBe('none');
    expect(screen.getByRole('textbox', { name: '地址' })).toHaveValue('https://bad.test/');
    expect(document.querySelectorAll('webview')).toHaveLength(1);
  });

  it('rebuilds the webview after a recoverable crash', async () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    currentUrl = 'https://live.test/';
    act(() => {
      view.dispatchEvent(new Event('did-navigate'));
    });
    dispatchGone(view, { reason: 'crashed', exitCode: 1 });
    expect(detachGuest).toHaveBeenCalled();
    await waitFor(() => {
      expect(document.querySelectorAll('webview')).toHaveLength(1);
      expect(document.querySelector('webview')).not.toBe(view);
    });
    const rebuilt = document.querySelector('webview')!;
    expect(rebuilt).not.toBe(view);
    expect(rebuilt.getAttribute('src')).toBe('https://live.test/');
  });

  it('re-attaches the rebuilt guest with the new webContentsId', async () => {
    render(<BrowserBody tab={browserTab({ id: 'browser-9' })} active />);
    const view = getView();
    currentUrl = 'https://live.test/';
    act(() => {
      view.dispatchEvent(new Event('did-navigate'));
    });
    nextWebContentsId = 12;
    dispatchGone(view, { reason: 'crashed', exitCode: 1 });
    await waitFor(() => {
      expect(attachGuest).toHaveBeenLastCalledWith({ tabId: 'browser-9', webContentsId: 12 });
    });
  });

  it('ignores a second recoverable gone until the rebuilt guest is ready', async () => {
    render(<BrowserBody tab={browserTab({ id: 'browser-9' })} active />);
    const view = getView();
    currentUrl = 'https://live.test/';
    act(() => {
      view.dispatchEvent(new Event('did-navigate'));
    });
    dispatchGone(view, { reason: 'crashed', exitCode: 1 });
    await waitFor(() => {
      expect(document.querySelector('webview')).not.toBe(view);
    });
    const rebuilt = document.querySelector('webview')!;
    dispatchGone(rebuilt, { reason: 'crashed', exitCode: 1 });
    expect(document.querySelector('webview')).toBe(rebuilt);
    act(() => {
      rebuilt.dispatchEvent(new Event('dom-ready'));
    });
    nextWebContentsId = 13;
    dispatchGone(rebuilt, { reason: 'crashed', exitCode: 1 });
    await waitFor(() => {
      expect(document.querySelector('webview')).not.toBe(rebuilt);
    });
    expect(attachGuest).toHaveBeenLastCalledWith({ tabId: 'browser-9', webContentsId: 13 });
  });

  it.each(['launch-failed', 'clean-exit'] as const)('does not rebuild the webview on unrecoverable %s', (reason) => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    dispatchGone(view, { reason });
    expect(document.querySelector('webview')).toBe(view);
    expect(screen.getByRole('heading', { name: '此网页无法正常运行' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新打开' })).toBeTruthy();
    expect(screen.getByText(new RegExp(reason))).toBeTruthy();
  });

  it('reopens a hidden webview at the last restorable URL', async () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    currentUrl = 'https://live.test/';
    act(() => {
      view.dispatchEvent(new Event('did-navigate'));
    });
    dispatchGone(view, { reason: 'launch-failed' });
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    await waitFor(() => {
      expect(document.querySelector('webview')).not.toBe(view);
    });
    expect(document.querySelector('webview')!.getAttribute('src')).toBe('https://live.test/');
  });

  it('clears the guest failure overlay after the rebuilt webview is ready', async () => {
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    currentUrl = 'https://live.test/';
    act(() => {
      view.dispatchEvent(new Event('did-navigate'));
    });
    dispatchGone(view, { reason: 'launch-failed' });
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    await waitFor(() => {
      expect(document.querySelector('webview')).not.toBe(view);
    });
    act(() => {
      document.querySelector('webview')!.dispatchEvent(new Event('dom-ready'));
    });
    expect(screen.queryByRole('button', { name: '重新打开' })).toBeNull();
  });

  it('records a successful navigation into address-bar history', () => {
    render(<BrowserBody tab={browserTab()} active />);
    currentUrl = 'https://123pan.com/';
    act(() => {
      getView().dispatchEvent(new Event('did-navigate'));
    });
    expect(history.remember).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://123pan.com/' }),
    );
  });

  it('suggests remembered URLs and switches to an already-open browser tab', () => {
    history.tabs.push(
      {
        id: 'browser-9',
        kind: 'browser',
        region: 'right',
        title: '当前',
        closable: true,
        order: 0,
        payload: { url: 'https://example.com' },
      },
      {
        id: 'browser-other',
        kind: 'browser',
        region: 'right',
        title: '123云盘',
        closable: true,
        order: 1,
        payload: { url: 'https://123pan.com/' },
      },
    );
    history.entries.push({ url: 'https://123pan.com/', title: '123云盘', visitedAt: 1 });
    render(<BrowserBody tab={browserTab({ id: 'browser-9' })} active />);
    fireEvent.focus(screen.getByRole('textbox', { name: '地址' }));
    expect(screen.getByRole('listbox', { name: '地址建议' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '切换到此标签页' }));
    expect(setActive).toHaveBeenCalledWith('right', 'browser-other');
    expect(getView().loadURL).not.toHaveBeenCalled();
  });

  it('loads a remembered URL into the current tab when it is not already open', () => {
    history.entries.push({ url: 'https://zhihu.com/p/1', title: '知乎文章', visitedAt: 1 });
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    fireEvent.focus(screen.getByRole('textbox', { name: '地址' }));
    fireEvent.click(screen.getByRole('option', { name: /知乎文章/ }));
    expect(view.loadURL).toHaveBeenCalledWith('https://zhihu.com/p/1');
  });

  it('closes address suggestions when the page surface is clicked', () => {
    history.entries.push({ url: 'https://zhihu.com/p/1', title: '知乎文章', visitedAt: 1 });
    render(<BrowserBody tab={browserTab()} active />);
    const address = screen.getByRole('textbox', { name: '地址' });
    fireEvent.focus(address);
    expect(screen.getByRole('listbox', { name: '地址建议' })).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId('gren-browser-suggest-dismiss'));
    expect(screen.queryByRole('listbox', { name: '地址建议' })).toBeNull();
    expect(address).not.toHaveFocus();
  });

  it('keeps a blank tab address empty with a search placeholder and a new-tab surface', () => {
    currentUrl = 'about:blank';
    render(<BrowserBody tab={browserTab({ url: 'about:blank' })} active />);
    const address = screen.getByRole('textbox', { name: '地址' }) as HTMLInputElement;
    expect(address).toHaveValue('');
    expect(address.placeholder).toBe('搜索或输入网址');
    expect(address).not.toHaveValue('about:blank');
    expect(screen.getByTestId('gren-browser-ntp')).toBeTruthy();
    expect(screen.getByRole('button', { name: '搜索或输入网址' })).toBeTruthy();
  });

  it('hides the new-tab surface after the guest navigates to a document', () => {
    currentUrl = 'about:blank';
    render(<BrowserBody tab={browserTab({ url: 'about:blank' })} active />);
    expect(screen.getByTestId('gren-browser-ntp')).toBeTruthy();
    currentUrl = 'https://example.com/';
    act(() => {
      getView().dispatchEvent(new Event('did-navigate'));
    });
    expect(screen.queryByTestId('gren-browser-ntp')).toBeNull();
    expect(screen.getByRole('textbox', { name: '地址' })).toHaveValue('https://example.com/');
  });

  it('opens a remembered shortcut from the new-tab surface', () => {
    currentUrl = 'about:blank';
    history.entries.push({ url: 'https://zhihu.com/', title: '知乎', visitedAt: 1 });
    render(<BrowserBody tab={browserTab({ url: 'about:blank' })} active />);
    fireEvent.click(screen.getByRole('button', { name: /知乎/ }));
    expect(getView().loadURL).toHaveBeenCalledWith('https://zhihu.com/');
  });

  it('toggles a free-size viewport around the guest', () => {
    render(<BrowserBody tab={browserTab()} active />);
    const canvas = screen.getByTestId('gren-browser-viewport-canvas');
    const frame = screen.getByTestId('gren-browser-viewport-frame');
    expect(canvas.className).not.toContain('gren-browser-viewport-canvas-active');
    expect(frame.style.width).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '自由尺寸' }));
    expect(canvas.className).toContain('gren-browser-viewport-canvas-active');
    expect(frame.style.width).toBe('393px');
    expect(frame.style.height).toBe('852px');
    expect(screen.getByRole('textbox', { name: '视口宽度' })).toHaveValue('393');
    fireEvent.change(screen.getByRole('textbox', { name: '视口宽度' }), { target: { value: '1280' } });
    fireEvent.blur(screen.getByRole('textbox', { name: '视口宽度' }));
    expect(frame.style.width).toBe('1280px');
    fireEvent.click(screen.getByRole('button', { name: '自由尺寸' }));
    expect(canvas.className).not.toContain('gren-browser-viewport-canvas-active');
  });

  it('disables element picking on a blank tab', () => {
    currentUrl = 'about:blank';
    render(<BrowserBody tab={browserTab({ url: 'about:blank' })} active />);
    expect(screen.getByRole('button', { name: '选择元素' })).toBeDisabled();
  });

  it('injects the guest picker and offers the selected element to chat', async () => {
    const received: Array<{ title: string; text: string }> = [];
    const { bindBrowserElementChatSink } = await import('./browserElementPicker');
    bindBrowserElementChatSink((offer) => received.push(offer));
    render(<BrowserBody tab={browserTab()} active />);
    const view = getView();
    view.executeJavaScript.mockResolvedValueOnce({
      status: 'selected',
      element: {
        tagName: 'button',
        selector: 'button#go',
        pageUrl: 'https://example.com/app',
        text: '提交',
        html: '<button id="go">提交</button>',
        background: 'rgb(0, 0, 0)',
        color: 'rgb(255, 255, 255)',
        font: '500 14px/20px sans-serif',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '选择元素' }));
    await waitFor(() => expect(received).toHaveLength(1));
    expect(view.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('__grenBrowserElementPicker'), true);
    expect(received[0]?.title).toBe('button#go');
    expect(received[0]?.text).toContain('标签页 id: browser-9');
    expect(received[0]?.text).toContain('button#go');
    bindBrowserElementChatSink(null);
  });
});
