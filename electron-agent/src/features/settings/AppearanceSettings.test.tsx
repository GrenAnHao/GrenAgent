import { ThemeProvider } from '@lobehub/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_SIZE_DEFAULT } from '../../theme/contentFont';
import { useThemeStore } from '../../stores/themeStore';
import { AppearanceSettings } from './AppearanceSettings';

vi.mock('@lobehub/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lobehub/ui')>();
  return { ...actual, ColorSwatches: () => null };
});

afterEach(() => {
  cleanup();
  useThemeStore.setState({ fontSize: FONT_SIZE_DEFAULT });
});

function mount() {
  return render(
    <ThemeProvider themeMode="dark">
      <AppearanceSettings />
    </ThemeProvider>,
  );
}

describe('AppearanceSettings font size', () => {
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
