import { afterEach, describe, expect, it } from 'vitest';
import { FONT_SIZE_DEFAULT } from '../theme/contentFont';
import { useThemeStore } from './themeStore';

afterEach(() => {
  localStorage.removeItem('pi-theme');
  useThemeStore.setState({
    appearance: 'dark',
    primaryColor: undefined,
    neutralColor: undefined,
    colorScheme: useThemeStore.getState().colorScheme,
    fontSize: FONT_SIZE_DEFAULT,
  });
});

describe('themeStore fontSize', () => {
  it('defaults to 14', () => {
    expect(useThemeStore.getState().fontSize).toBe(14);
  });

  it('setFontSize writes and clamps', () => {
    useThemeStore.getState().setFontSize(17);
    expect(useThemeStore.getState().fontSize).toBe(17);
    useThemeStore.getState().setFontSize(99);
    expect(useThemeStore.getState().fontSize).toBe(17);
  });

  it('partializes fontSize', () => {
    useThemeStore.getState().setFontSize(16);
    const raw = localStorage.getItem('pi-theme');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.fontSize).toBe(16);
  });

  it('rehydrate clamps dirty fontSize', async () => {
    localStorage.setItem(
      'pi-theme',
      JSON.stringify({ state: { fontSize: 999, appearance: 'dark', colorScheme: 'github' }, version: 0 }),
    );
    await useThemeStore.persist.rehydrate();
    expect(useThemeStore.getState().fontSize).toBe(17);
  });
});
