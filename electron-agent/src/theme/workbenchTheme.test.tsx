import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { useTheme } from 'antd-style';
import { describe, expect, it } from 'vitest';
import { workbenchTheme } from './workbenchTheme';

function Tokens() {
  const token = useTheme();
  return <output>{JSON.stringify({ primary: token.colorPrimary, container: token.colorBgContainer, elevated: token.colorBgElevated, text: token.colorText })}</output>;
}

describe('workbench theme through the real Lobe algorithm', () => {
  it.each([
    { dark: false, primary: '#566847', container: '#fffefa', elevated: '#ffffff', text: '#272923' },
    { dark: true, primary: '#adc399', container: '#191a1c', elevated: '#2b2c2e', text: '#ecece7' },
  ])('keeps fixed surfaces and accent in $dark mode', ({ dark, ...expected }) => {
    const mode = dark ? 'dark' : 'light';
    render(
      <ThemeProvider appearance={mode} themeMode={mode} theme={workbenchTheme(dark)} enableCustomFonts={false} enableGlobalStyle={false}>
        <Tokens />
      </ThemeProvider>,
    );
    expect(JSON.parse(screen.getByRole('status').textContent!)).toEqual(expected);
  });
});
