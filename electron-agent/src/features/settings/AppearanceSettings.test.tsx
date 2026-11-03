import { ThemeProvider } from '@lobehub/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FONT_SIZE_DEFAULT } from '../../theme/contentFont';
import { useThemeStore } from '../../stores/themeStore';
import { AppearanceSettings } from './AppearanceSettings';

afterEach(() => {
  cleanup();
  useThemeStore.setState({ appearance: 'dark', fontSize: FONT_SIZE_DEFAULT });
});

function mount() {
  return render(
    <ThemeProvider themeMode="dark">
      <AppearanceSettings />
    </ThemeProvider>,
  );
}

describe('AppearanceSettings', () => {
  it('only offers appearance and font size controls', () => {
    mount();
    expect(screen.queryByText('配色方案')).not.toBeInTheDocument();
    expect(screen.queryByText('主题色')).not.toBeInTheDocument();
    expect(screen.queryByText('中性色')).not.toBeInTheDocument();
    expect(screen.getByText('对话字号')).toBeInTheDocument();
    expect(screen.getByText('主题')).toBeInTheDocument();
  });

  it('keeps light, dark, and system appearance available', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(useThemeStore.getState().appearance).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: '深色' }));
    expect(useThemeStore.getState().appearance).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: '跟随系统' }));
    expect(useThemeStore.getState().appearance).toBe('auto');
  });

  it('shows the store value', () => {
    mount();
    expect(screen.getByTestId('font-size-stepper').textContent).toContain('14');
  });

  it('increments and decrements the store', () => {
    mount();
    fireEvent.click(screen.getByTestId('font-size-inc'));
    expect(useThemeStore.getState().fontSize).toBe(15);
    fireEvent.click(screen.getByTestId('font-size-dec'));
    expect(useThemeStore.getState().fontSize).toBe(14);
  });

  it('disables decrement at 12 and increment at 17', () => {
    useThemeStore.setState({ fontSize: 12 });
    const { unmount } = mount();
    expect(screen.getByTestId('font-size-dec')).toBeDisabled();
    expect(screen.getByTestId('font-size-inc')).not.toBeDisabled();
    unmount();
    useThemeStore.setState({ fontSize: 17 });
    mount();
    expect(screen.getByTestId('font-size-inc')).toBeDisabled();
    expect(screen.getByTestId('font-size-dec')).not.toBeDisabled();
  });
});
