import { act, cleanup, render } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeBridge } from './ThemeBridge';
import { workbenchTheme } from '../theme/workbenchTheme';

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--boot-bg');
  delete window.gren;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ThemeBridge', () => {
  it.each([true, false])('only fades appearance changes when motion is enabled: %s', (motion) => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query, matches: motion && query === '(prefers-reduced-motion: no-preference)',
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
    }));
    window.gren = { window: {} } as never;
    const tree = (mode: 'light' | 'dark') => (
      <ThemeProvider appearance={mode} themeMode={mode} theme={workbenchTheme(mode === 'dark')} enableGlobalStyle={false} enableCustomFonts={false}>
        <ThemeBridge />
      </ThemeProvider>
    );
    const root = document.documentElement;
    const mounted = render(tree('dark'));
    expect(root.hasAttribute('data-theme-switching')).toBe(false);
    mounted.rerender(tree('light'));
    expect(root.dataset.theme).toBe('light');
    expect(root.hasAttribute('data-theme-switching')).toBe(motion);
    act(() => { vi.advanceTimersByTime(250); });
    expect(root.hasAttribute('data-theme-switching')).toBe(false);
  });

  it("syncs the native window background to the boot splash color of the current appearance", () => {
    const setBackgroundColor = vi.fn().mockResolvedValue(undefined);
    window.gren = { window: { setBackgroundColor } } as never;
    document.documentElement.style.setProperty('--boot-bg', '#ffffff');

    render(<ThemeBridge />);

    expect(setBackgroundColor).toHaveBeenCalledWith('#ffffff');
  });

  it('leaves the window alone on pages without the boot splash palette', () => {
    const setBackgroundColor = vi.fn().mockResolvedValue(undefined);
    window.gren = { window: { setBackgroundColor } } as never;

    render(<ThemeBridge />);

    expect(setBackgroundColor).not.toHaveBeenCalled();
  });

  it('does not crash when a stale preload bridge lacks setBackgroundColor', () => {
    // dev 版本错配：渲染层已热更新、preload 未重建，window.gren.window 上还没有该方法。
    window.gren = { window: {} } as never;
    document.documentElement.style.setProperty('--boot-bg', '#ffffff');

    expect(() => render(<ThemeBridge />)).not.toThrow();
  });
});
