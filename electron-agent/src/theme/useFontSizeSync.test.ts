import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FONT_SIZE_DEFAULT } from './contentFont';
import { useThemeStore } from '../stores/themeStore';
import { useFontSizeSync } from './useFontSizeSync';

afterEach(() => {
  useThemeStore.setState({ fontSize: FONT_SIZE_DEFAULT });
  document.documentElement.style.removeProperty('--pi-font-size');
});

describe('useFontSizeSync', () => {
  it('writes --pi-font-size on the root', () => {
    useThemeStore.setState({ fontSize: 14 });
    renderHook(() => useFontSizeSync());
    expect(document.documentElement.style.getPropertyValue('--pi-font-size')).toBe('14px');
  });

  it('updates when the store changes', () => {
    useThemeStore.setState({ fontSize: 14 });
    renderHook(() => useFontSizeSync());
    act(() => {
      useThemeStore.getState().setFontSize(16);
    });
    expect(document.documentElement.style.getPropertyValue('--pi-font-size')).toBe('16px');
  });
});
