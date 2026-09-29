import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiBrandLogo } from '../components/PiBrandLogo';
import { RootErrorBoundary } from '../components/RootErrorBoundary';
import { useThemeStore } from '../stores/themeStore';
import { dismissBootSplash } from './bootSplash';

// 不写 new URL('../../index.html', import.meta.url)：jsdom 环境下 Vite 会把这种写法改写成 http 资源地址。
const indexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');
const parseIndexHtml = () => new DOMParser().parseFromString(indexHtml, 'text/html');

/** 把 index.html 里真实的首屏节点挂进当前 document。 */
function mountBootSplash(): HTMLElement {
  const splash = parseIndexHtml().getElementById('boot-splash');
  if (!splash) throw new Error('index.html 缺少 #boot-splash');
  return document.body.appendChild(document.importNode(splash, true));
}

/** 执行 index.html <head> 里的首帧明暗脚本，返回它写到 <html> 上的 data-theme。 */
function runBootThemeScript(systemDark = false): string | undefined {
  const script = parseIndexHtml().querySelector('head script:not([src])')?.textContent;
  if (!script) throw new Error('index.html 缺少首帧明暗脚本');
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: systemDark && query.includes('dark'), media: query }));
  new Function(script)();
  return document.documentElement.dataset.theme;
}

afterEach(() => {
  cleanup();
  document.getElementById('boot-splash')?.remove();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('index.html boot splash', () => {
  it("sits outside #root so React's first commit does not replace it", () => {
    const doc = parseIndexHtml();
    expect(doc.getElementById('boot-splash')?.parentElement).toBe(doc.body);
    expect(doc.getElementById('root')?.childElementCount).toBe(0);
  });

  it('draws the same π glyph as PiBrandLogo', () => {
    const { container } = render(<PiBrandLogo />);
    const splashPath = parseIndexHtml().querySelector('#boot-splash path')?.getAttribute('d');
    expect(splashPath).toBeTruthy();
    expect(splashPath).toBe(container.querySelector('path')?.getAttribute('d'));
  });
});

// 首帧前按「设置 → 外观」选明暗；值由真实 themeStore 写入，存储键或持久化格式一变这里就会失败。
describe('index.html boot theme', () => {
  it('uses the dark palette when nothing is saved yet (themeStore default)', () => {
    expect(runBootThemeScript()).toBe('dark');
  });

  it('follows a saved light or dark appearance', () => {
    useThemeStore.getState().setAppearance('light');
    expect(runBootThemeScript(true)).toBe('light');

    useThemeStore.getState().setAppearance('dark');
    expect(runBootThemeScript(false)).toBe('dark');
  });

  it('follows the system when appearance is auto', () => {
    useThemeStore.getState().setAppearance('auto');
    expect(runBootThemeScript(false)).toBe('light');
    expect(runBootThemeScript(true)).toBe('dark');
  });

  it('falls back to dark when the saved value is corrupted', () => {
    localStorage.setItem('pi-theme', '{');
    expect(runBootThemeScript()).toBe('dark');
  });
});

describe('dismissBootSplash', () => {
  it('fades the splash out, then removes it', () => {
    vi.useFakeTimers();
    const splash = mountBootSplash();

    dismissBootSplash();
    expect(splash.classList.contains('is-leaving')).toBe(true);
    expect(splash.isConnected).toBe(true);

    vi.runAllTimers();
    expect(splash.isConnected).toBe(false);
  });

  it('ignores repeated calls and a missing splash', () => {
    vi.useFakeTimers();
    mountBootSplash();

    dismissBootSplash();
    dismissBootSplash();
    expect(vi.getTimerCount()).toBe(1);

    vi.runAllTimers();
    expect(() => dismissBootSplash()).not.toThrow();
  });

  it('runs when the root error boundary catches a render crash', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const splash = mountBootSplash();
    const Crash = () => {
      throw new Error('boom');
    };

    render(
      <RootErrorBoundary>
        <Crash />
      </RootErrorBoundary>,
    );

    expect(screen.getByTestId('root-error-boundary')).toBeTruthy();
    expect(splash.classList.contains('is-leaving')).toBe(true);
  });
});
