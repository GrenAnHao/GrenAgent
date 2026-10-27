import { describe, expect, it, vi } from 'vitest';
import { appCommandDirection, forwardAppCommands, guardMainWindowNavigation, isSameAppPage, isWebUrl } from './mainWindowNavigation';

describe('app-command → 前进 / 后退', () => {
  it('只认浏览器前进 / 后退，别的命令忽略', () => {
    expect(appCommandDirection('browser-backward')).toBe('back');
    expect(appCommandDirection('browser-forward')).toBe('forward');
    for (const other of ['volume-up', 'browser-refresh', 'browser-search', 'media-play-pause', '']) {
      expect(appCommandDirection(other)).toBeNull();
    }
  });

  it('窗口收到 app-command 就把方向转给渲染进程', () => {
    let handler: (event: unknown, command: string) => void = () => {};
    const win = { on: vi.fn((_name: string, fn: typeof handler) => void (handler = fn)) };
    const send = vi.fn();
    forwardAppCommands(win as never, send);
    expect(win.on).toHaveBeenCalledWith('app-command', expect.any(Function));
    handler({}, 'browser-backward');
    handler({}, 'browser-forward');
    handler({}, 'volume-up');
    expect(send.mock.calls).toEqual([['back'], ['forward']]);
  });
});

const APP = 'file:///C:/app/dist/index.html';

function setup(appUrl = APP) {
  let navigate: (event: { preventDefault: () => void }, url: string) => void = () => {};
  let openHandler: (details: { url: string }) => { action: string } = () => ({ action: 'allow' });
  const contents = {
    on: vi.fn((event: string, handler: typeof navigate) => {
      if (event === 'will-navigate') navigate = handler;
    }),
    setWindowOpenHandler: vi.fn((handler: typeof openHandler) => {
      openHandler = handler;
    }),
  };
  const openInApp = vi.fn();
  guardMainWindowNavigation(contents as never, { appUrl, openInApp });
  return { navigate: (url: string) => {
    const event = { preventDefault: vi.fn() };
    navigate(event, url);
    return event;
  }, open: (url: string) => openHandler({ url }), openInApp };
}

describe('isSameAppPage', () => {
  it('hash / query 变化仍是应用页面，换路径或换主机不是', () => {
    expect(isSameAppPage(`${APP}#/chat`, APP)).toBe(true);
    expect(isSameAppPage(`${APP}?x=1`, APP)).toBe(true);
    expect(isSameAppPage('file:///C:/other.html', APP)).toBe(false);
    expect(isSameAppPage('http://localhost:5173/', 'http://localhost:5173/')).toBe(true);
    expect(isSameAppPage('http://evil.test/', 'http://localhost:5173/')).toBe(false);
    expect(isSameAppPage('not a url', APP)).toBe(false);
  });
});

describe('isWebUrl', () => {
  it('只认 http / https', () => {
    expect(isWebUrl('https://a.b')).toBe(true);
    expect(isWebUrl('file:///x')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('guardMainWindowNavigation', () => {
  it('导航到网页：拦下并转给内置浏览器', () => {
    const { navigate, openInApp } = setup();
    const event = navigate('https://example.com/a');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openInApp).toHaveBeenCalledWith('https://example.com/a');
  });

  it('导航到其它本地页面：拦下，不转发', () => {
    const { navigate, openInApp } = setup();
    expect(navigate('file:///C:/Windows/system.ini').preventDefault).toHaveBeenCalled();
    expect(openInApp).not.toHaveBeenCalled();
  });

  it('应用自己的页面（含 hash 路由）不拦', () => {
    const { navigate, openInApp } = setup();
    expect(navigate(`${APP}#/x`).preventDefault).not.toHaveBeenCalled();
    expect(openInApp).not.toHaveBeenCalled();
  });

  it('window.open / target=_blank：一律拒绝开新窗口，网页链接转内置浏览器', () => {
    const { open, openInApp } = setup();
    expect(open('https://example.com/')).toEqual({ action: 'deny' });
    expect(openInApp).toHaveBeenCalledWith('https://example.com/');
    expect(open('javascript:alert(1)')).toEqual({ action: 'deny' });
    expect(openInApp).toHaveBeenCalledTimes(1);
  });
});
