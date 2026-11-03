import { describe, expect, it } from 'vitest';
import iconSource from '../../../../brand/source/grenagent-icon.svg?raw';
import {
  browserErrorPageUrl,
  describeBrowserGuestFailure,
  describeBrowserLoadError,
  isAbortedNavigation,
  isBrowserErrorPageUrl,
  isCertificateError,
  isExpectedNavigationFailure,
} from './browserNavigation';

describe('isCertificateError', () => {
  it('marks Chromium ERR_CERT_* codes', () => {
    expect(isCertificateError(-200)).toBe(true);
    expect(isCertificateError(-219)).toBe(true);
    expect(isCertificateError(-105)).toBe(false);
    expect(isCertificateError(-3)).toBe(false);
  });
});

describe('isAbortedNavigation', () => {
  it('accepts ERR_ABORTED code and errno -3', () => {
    expect(isAbortedNavigation({ code: 'ERR_ABORTED' })).toBe(true);
    expect(isAbortedNavigation({ errno: -3 })).toBe(true);
    expect(isAbortedNavigation(new Error('other'))).toBe(false);
  });
});

describe('isExpectedNavigationFailure', () => {
  it('treats DNS and GuestView Chromium net errors as expected', () => {
    expect(
      isExpectedNavigationFailure(
        new Error(
          "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_NAME_NOT_RESOLVED (-105) loading 'https://www.bing.cn/'",
        ),
      ),
    ).toBe(true);
    expect(isExpectedNavigationFailure(new Error('ERR_CONNECTION_REFUSED'))).toBe(true);
    expect(isExpectedNavigationFailure({ code: 'ERR_ABORTED' })).toBe(true);
    expect(isExpectedNavigationFailure(new Error('disk exploded'))).toBe(false);
  });
});

describe('describeBrowserLoadError', () => {
  it('matches Chromium copy for connection refused', () => {
    const view = describeBrowserLoadError({
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      url: 'http://127.0.0.1:5191/task-layout-preview/',
    });
    expect(view.title).toBe('无法访问此站点');
    expect(view.summary).toBe('127.0.0.1 拒绝建立连接');
    expect(view.suggestions).toEqual(['检查网络连接', '检查代理、防火墙和 DNS 配置']);
    expect(view.errorCode).toBe('ERR_CONNECTION_REFUSED');
    expect(view.certificate).toBe(false);
  });

  it('uses the private-connection heading for certificate errors', () => {
    const view = describeBrowserLoadError({
      errorCode: -202,
      errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
      url: 'https://bad.test/',
    });
    expect(view.title).toBe('您的连接不是私密连接');
    expect(view.summary).toBe('攻击者可能试图从 bad.test 窃取您的信息');
    expect(view.suggestions).toEqual(['检查系统时间是否正确']);
    expect(view.certificate).toBe(true);
  });
});

describe('browserErrorPageUrl', () => {
  it('builds a guest error document with the approved G and a details link', () => {
    const pageUrl = browserErrorPageUrl({
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      url: 'http://127.0.0.1:5191/task-layout-preview/',
    });
    expect(isBrowserErrorPageUrl(pageUrl)).toBe(true);
    const html = decodeURIComponent(pageUrl.slice('data:text/html;charset=utf-8,'.length));
    expect(html).toContain('class="icon"');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const original = new DOMParser().parseFromString(iconSource, 'image/svg+xml');
    const icon = doc.querySelector('.icon svg')!;
    expect(icon.getAttribute('viewBox')).toBe('0 0 352 352');
    expect(icon.querySelector('path')?.getAttribute('d')).toBe(original.querySelector('path')?.getAttribute('d'));
    expect(icon.querySelector('path')?.getAttribute('transform')).toBe('translate(16 19)');
    expect(doc.querySelector('.icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(html).toContain('id="details-link"');
    expect(html).toContain('id="reload-button"');
    expect(html).toContain('无法访问此站点');
    expect(html).toContain('127.0.0.1 拒绝建立连接');
    expect(html).toContain('ERR_CONNECTION_REFUSED');
    expect(html).toContain('http://127.0.0.1:5191/task-layout-preview/');
    expect(html).toContain('data-gren-browser-error="1"');
  });
});

describe('describeBrowserGuestFailure', () => {
  it('uses the Chromium crashed-tab heading', () => {
    expect(describeBrowserGuestFailure('launch-failed')).toEqual({
      title: '此网页无法正常运行',
      summary: '网页进程已退出',
      suggestions: ['重新打开此标签页'],
      errorCode: 'launch-failed',
      certificate: false,
    });
  });
});
