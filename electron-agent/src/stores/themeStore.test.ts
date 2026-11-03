import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_SIZE_DEFAULT } from '../theme/contentFont';
import { useThemeStore } from './themeStore';

describe('themeStore fontSize first import', () => {
  it('clamps dirty fontSize on first hydrate', async () => {
    localStorage.setItem(
      'pi-theme',
      JSON.stringify({ state: { fontSize: 999, appearance: 'dark', colorScheme: 'github' }, version: 0 }),
    );
    vi.resetModules();
    const { useThemeStore: freshStore } = await import('./themeStore');
    expect(freshStore.getState().fontSize).toBe(17);
  });
});

afterEach(() => {
  localStorage.removeItem('pi-theme');
  useThemeStore.setState({
    appearance: 'dark',
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

describe('themeStore appearance preferences', () => {
  it('ignores legacy color choices while restoring appearance and font size', async () => {
    localStorage.setItem('pi-theme', JSON.stringify({
      state: { appearance: 'auto', fontSize: 16, colorScheme: 'nord', primaryColor: 'red', neutralColor: 'slate' },
      version: 0,
    }));
    await useThemeStore.persist.rehydrate();
    const state = useThemeStore.getState();
    expect(state.appearance).toBe('auto');
    expect(state.fontSize).toBe(16);
    expect(state).not.toHaveProperty('colorScheme');
    expect(state).not.toHaveProperty('primaryColor');
    expect(state).not.toHaveProperty('neutralColor');
  });

  it('persists only appearance and font size after restoring a legacy theme', async () => {
    localStorage.setItem('pi-theme', JSON.stringify({
      state: { appearance: 'dark', fontSize: 15, colorScheme: 'solarized', primaryColor: 'red' },
      version: 0,
    }));
    await useThemeStore.persist.rehydrate();
    useThemeStore.getState().setAppearance('light');
    expect(JSON.parse(localStorage.getItem('pi-theme')!).state).toEqual({ appearance: 'light', fontSize: 15 });
  });
});
