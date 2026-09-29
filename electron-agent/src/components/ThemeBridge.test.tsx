import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeBridge } from './ThemeBridge';

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--boot-bg');
  delete window.gren;
});

describe('ThemeBridge', () => {
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
