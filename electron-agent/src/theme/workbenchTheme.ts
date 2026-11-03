import { generateColorPalette } from '@lobehub/ui';
import { blue, geekblue, gold, green, lime, red, volcano } from '@lobehub/ui/color';
import { theme, type ThemeConfig } from 'antd';

export const ANTD_CSS_VAR_KEY = 'gren-css-var';

const lightPalette = {
  chrome: '#e7e9e4',
  rail: '#e7e9e4',
  sidebar: '#f3f3f0',
  content: '#fffefa',
  elevated: '#ffffff',
  composer: '#ffffff',
  sidebarActive: '#e5e8df',
  accent: '#566847',
  composerShadow: '0 4px 18px #2427220c',
};

const darkPalette = {
  chrome: '#151719',
  rail: '#151719',
  sidebar: '#222325',
  content: '#191a1c',
  elevated: '#2b2c2e',
  composer: '#242527',
  sidebarActive: '#343a2e',
  accent: '#adc399',
  composerShadow: '0 5px 20px #00000024',
};

export function workbenchPalette(isDark: boolean) {
  return isDark ? darkPalette : lightPalette;
}

/** All entry points share fixed workbench surfaces and a complete primary color family. */
export function workbenchTheme(isDark: boolean): ThemeConfig {
  const palette = workbenchPalette(isDark);
  const appearance = isDark ? 'dark' : 'light';
  const hover = isDark ? '#bdcfae' : '#657853';
  const active = isDark ? '#95ad7f' : '#46583a';
  const token = {
    // Keep Lobe's existing semantic palettes when replacing its primary/neutral algorithm.
    ...generateColorPalette({ appearance, scale: isDark ? lime : green, type: 'Success' }),
    ...generateColorPalette({ appearance, scale: gold, type: 'Warning' }),
    ...generateColorPalette({ appearance, scale: isDark ? red : volcano, type: 'Error' }),
    ...generateColorPalette({ appearance, scale: isDark ? blue : geekblue, type: 'Info' }),
    colorBgLayout: palette.sidebar,
    colorBgContainer: palette.content,
    colorBgElevated: palette.elevated,
    colorBgSpotlight: palette.elevated,
    colorBorder: isDark ? '#3a3c36' : '#dadcd3',
    colorBorderSecondary: isDark ? '#30322d' : '#e6e7df',
    colorText: isDark ? '#ecece7' : '#272923',
    colorTextSecondary: isDark ? '#b3b5ad' : '#62665d',
    colorTextTertiary: isDark ? '#8d9088' : '#777c72',
    colorTextQuaternary: isDark ? '#8d9088' : '#777c72',
    colorTextLightSolid: isDark ? '#191a1c' : '#ffffff',
    colorFill: isDark ? '#ffffff1f' : '#2427221f',
    colorFillSecondary: isDark ? '#ffffff14' : '#2427220f',
    colorFillTertiary: isDark ? '#ffffff0d' : '#2427220a',
    colorFillQuaternary: isDark ? '#ffffff08' : '#24272205',
    colorPrimary: palette.accent,
    colorPrimaryHover: hover,
    colorPrimaryActive: active,
    colorPrimaryBg: palette.sidebarActive,
    colorPrimaryBgHover: isDark ? '#414b37' : '#d9e0d0',
    colorPrimaryBorder: isDark ? '#6e805c' : '#a8b59a',
    colorPrimaryBorderHover: isDark ? '#8ca477' : '#7f916c',
    colorPrimaryText: palette.accent,
    colorPrimaryTextHover: hover,
    colorPrimaryTextActive: active,
    colorPrimaryFill: isDark ? '#adc39933' : '#56684733',
    colorPrimaryFillSecondary: isDark ? '#adc39926' : '#56684726',
    colorPrimaryFillTertiary: isDark ? '#adc3991a' : '#5668471a',
    colorPrimaryFillQuaternary: isDark ? '#adc3990d' : '#5668470d',
    colorLink: palette.accent,
    colorLinkHover: hover,
    colorLinkActive: active,
  };
  const baseAlgorithm = isDark ? theme.darkAlgorithm : theme.defaultAlgorithm;
  return {
    cssVar: { key: ANTD_CSS_VAR_KEY },
    hashed: false,
    token,
    // Lobe's algorithm resets seed colorPrimary to gray after antd derives it. Replace that
    // algorithm, then apply the fixed family after the base derivation so real controls match.
    algorithm: (seed, derived) => ({ ...(derived ?? baseAlgorithm(seed)), ...token }),
  };
}
