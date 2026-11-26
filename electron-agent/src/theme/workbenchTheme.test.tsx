import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { useTheme } from 'antd-style';
import { describe, expect, it } from 'vitest';
import { workbenchTheme } from './workbenchTheme';

function Tokens() {
  const token = useTheme();
  return <output>{JSON.stringify({
    primary: token.colorPrimary, selected: token.colorPrimaryBg, selectedBorder: token.colorPrimaryBorder,
    divider: token.colorBorderSecondary, container: token.colorBgContainer, elevated: token.colorBgElevated,
    text: token.colorText, fontSize: token.fontSize,
  })}</output>;
}

describe('workbench theme through the real Lobe algorithm', () => {
  it.each([
    {
      dark: false, primary: '#4a6b4e', selected: 'rgba(92, 128, 96, 0.10)', selectedBorder: 'rgba(92, 128, 96, 0.28)',
      divider: 'rgba(0, 0, 0, 0.08)', container: '#ffffff', elevated: '#ffffff', text: '#18181b', fontSize: 13,
    },
    {
      dark: true, primary: '#adc399', selected: '#343a2e', selectedBorder: '#6e805c',
      divider: '#30322d', container: '#191a1c', elevated: '#2b2c2e', text: '#ecece7', fontSize: 13,
    },
  ])('keeps fixed surfaces and accent in $dark mode', ({ dark, ...expected }) => {
    const mode = dark ? 'dark' : 'light';
    render(
      <ThemeProvider appearance={mode} themeMode={mode} theme={workbenchTheme(dark)} enableCustomFonts={false} enableGlobalStyle={false}>
        <Tokens />
      </ThemeProvider>,
    );
    expect(JSON.parse(screen.getByRole('status').textContent!)).toEqual(expected);
  });

  it('uses one control baseline regardless of appearance', () => {
    expect(workbenchTheme(false).components).toBe(workbenchTheme(true).components);
    expect(workbenchTheme(true).components).toMatchObject({
      Segmented: { controlHeight: 25, controlHeightSM: 25, fontSize: 12 },
      Button: { contentFontSize: 13, contentFontSizeSM: 13 },
      Input: { inputFontSize: 13, inputFontSizeSM: 13 },
    });
  });

});
