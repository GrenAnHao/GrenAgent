import { describe, expect, it } from 'vitest';
import { applyWillAttachPolicy, isAllowedPopupUrl, isAllowedWebviewUrl } from './webviewPolicy';

describe('isAllowedWebviewUrl', () => {
  it('allows http(s) documents and exact about:blank', () => {
    expect(isAllowedWebviewUrl('https://example.com')).toBe(true);
    expect(isAllowedWebviewUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedWebviewUrl('about:blank')).toBe(true);
  });

  it('rejects executable, file, data, and other about URLs', () => {
    expect(isAllowedWebviewUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedWebviewUrl('file:///C:/secret.txt')).toBe(false);
    expect(isAllowedWebviewUrl('data:text/html,hi')).toBe(false);
    expect(isAllowedWebviewUrl('about:srcdoc')).toBe(false);
    expect(isAllowedWebviewUrl('chrome://settings')).toBe(false);
    expect(isAllowedWebviewUrl('not a url')).toBe(false);
  });

  it('allows Chromium neterror documents so the guest can commit them', () => {
    expect(isAllowedWebviewUrl('chrome-error://chromewebdata/')).toBe(true);
  });
});

describe('isAllowedPopupUrl', () => {
  it('allows only http(s)', () => {
    expect(isAllowedPopupUrl('https://example.com/a')).toBe(true);
    expect(isAllowedPopupUrl('http://127.0.0.1/')).toBe(true);
    expect(isAllowedPopupUrl('about:blank')).toBe(false);
    expect(isAllowedPopupUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('applyWillAttachPolicy', () => {
  it('hardens preferences, strips attacker params, and keeps allowpopups untouched', () => {
    const webPreferences = {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      preload: 'https://evil.test/preload.js',
    };
    const params: Record<string, unknown> = {
      src: 'https://example.com',
      preload: 'https://evil.test/preload.js',
      nodeintegration: 'true',
      disablewebsecurity: 'true',
      allowpopups: true,
    };
    expect(applyWillAttachPolicy(webPreferences, params, '/app/preload/webviewPreload.js')).toBe(true);
    expect(webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: '/app/preload/webviewPreload.js',
    });
    expect(params.preload).toBeUndefined();
    expect(params.nodeintegration).toBeUndefined();
    expect(params.disablewebsecurity).toBeUndefined();
    expect(params.allowpopups).toBe(true);
  });

  it('rejects disallowed src so the caller can preventDefault', () => {
    const webPreferences = {};
    const params = { src: 'file:///C:/secret.txt' };
    expect(applyWillAttachPolicy(webPreferences as never, params, '/preload.js')).toBe(false);
  });
});
