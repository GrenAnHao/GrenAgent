import { generateColorPalette } from '@lobehub/ui';
import { blue, geekblue, gold, green, lime, red, volcano } from '@lobehub/ui/color';
import { theme, type ThemeConfig } from 'antd';

export const ANTD_CSS_VAR_KEY = 'gren-css-var';

// Only paint belongs in a palette. Controls, spacing and type roles are shared below.
const palettes = {
  light: {
    chrome: '#eceeeb', sidebar: '#f4f5f3', content: '#f8f9f8', layout: '#f8f9f8',
    surface: '#ffffff', elevated: '#ffffff', chartTooltip: '#ffffff', composer: '#ffffff', composerShadow: '0 5px 20px #00000014',
    border: 'rgba(0, 0, 0, 0.08)', divider: 'rgba(0, 0, 0, 0.08)',
    chromeBorder: 'rgba(0, 0, 0, 0.08)',
    text: '#18181b', secondaryText: '#52525b', mutedText: '#71717a', onPrimary: '#ffffff',
    accent: '#4a6b4e', hover: '#3d5940', active: '#344c37',
    sidebarActive: 'rgba(92, 128, 96, 0.10)', selectionHover: 'rgba(92, 128, 96, 0.16)',
    selectionBorder: 'rgba(92, 128, 96, 0.28)', selectionBorderHover: 'rgba(92, 128, 96, 0.48)',
    primaryFill: ['#5c806033', '#5c806026', '#5c80601a', '#5c80600d'],
    neutralFill: ['#18181b1f', '#18181b0f', '#18181b0a', '#18181b05'],
    description: '#71717a', inlineLink: '#339cff', toolCommand: '#50632b',
    scrollbar: 'rgba(0, 0, 0, 0.14)', scrollbarHover: 'rgba(0, 0, 0, 0.25)',
  },
  dark: {
    chrome: '#151719', sidebar: '#222325', content: '#191a1c', layout: '#222325',
    surface: '#191a1c', elevated: '#2b2c2e', chartTooltip: '#1f2220', composer: '#242527', composerShadow: '0 5px 20px #00000024',
    border: '#3a3c36', divider: '#30322d', chromeBorder: 'color-mix(in srgb, #30322d 55%, transparent)',
    text: '#ecece7', secondaryText: '#b3b5ad', mutedText: '#8d9088', onPrimary: '#191a1c',
    accent: '#adc399', hover: '#bdcfae', active: '#95ad7f',
    sidebarActive: '#343a2e', selectionHover: '#414b37',
    selectionBorder: '#6e805c', selectionBorderHover: '#8ca477',
    primaryFill: ['#adc39933', '#adc39926', '#adc3991a', '#adc3990d'],
    neutralFill: ['#ffffff1f', '#ffffff14', '#ffffff0d', '#ffffff08'],
    description: '#9ca3af', inlineLink: '#99ceff', toolCommand: '#bce641',
    scrollbar: 'rgba(255, 255, 255, 0.12)', scrollbarHover: 'rgba(255, 255, 255, 0.25)',
  },
} as const;

export function workbenchPalette(isDark: boolean) {
  return palettes[isDark ? 'dark' : 'light'];
}

const uiFontSize = 13;
const compactHeight = 25;
const components: NonNullable<ThemeConfig['components']> = {
  Button: { contentFontSize: uiFontSize, contentFontSizeSM: uiFontSize },
  Input: { inputFontSize: uiFontSize, inputFontSizeSM: uiFontSize },
  Segmented: {
    controlHeight: compactHeight, controlHeightSM: compactHeight, fontSize: 12, fontSizeSM: 12,
    trackBg: 'var(--ant-color-fill-secondary)', itemSelectedBg: 'var(--ant-color-bg-elevated)',
  },
};

/** All rendering entry points resolve the same component theme against one of two palettes. */
export function workbenchTheme(isDark: boolean): ThemeConfig {
  const p = workbenchPalette(isDark);
  const appearance = isDark ? 'dark' : 'light';
  const token = {
    ...generateColorPalette({ appearance, scale: isDark ? lime : green, type: 'Success' }),
    ...generateColorPalette({ appearance, scale: gold, type: 'Warning' }),
    ...generateColorPalette({ appearance, scale: isDark ? red : volcano, type: 'Error' }),
    ...generateColorPalette({ appearance, scale: isDark ? blue : geekblue, type: 'Info' }),
    ...(!isDark && {
      colorSuccess: '#15803d', colorSuccessText: '#15803d',
      colorError: '#dc2626', colorErrorText: '#dc2626', colorErrorHover: '#b91c1c', colorErrorBg: '#fef2f2',
    }),
    fontFamily: 'var(--font-sans)', fontFamilyCode: 'var(--font-mono)',
    fontSize: uiFontSize, fontSizeSM: 12, fontSizeLG: 16,
    fontSizeHeading1: 18, fontSizeHeading2: 16,
    colorBgLayout: p.layout, colorBgContainer: p.surface, colorBgElevated: p.elevated, colorBgSpotlight: p.elevated,
    colorBorder: p.border, colorBorderSecondary: p.divider,
    colorText: p.text, colorTextHeading: p.text, colorTextSecondary: p.secondaryText, colorTextLabel: p.secondaryText,
    colorTextTertiary: p.mutedText, colorTextQuaternary: p.mutedText, colorTextDescription: p.mutedText,
    colorTextPlaceholder: p.mutedText, colorTextLightSolid: p.onPrimary,
    colorFill: p.neutralFill[0], colorFillSecondary: p.neutralFill[1], colorFillTertiary: p.neutralFill[2], colorFillQuaternary: p.neutralFill[3],
    colorPrimary: p.accent, colorPrimaryHover: p.hover, colorPrimaryActive: p.active,
    colorPrimaryBg: p.sidebarActive, colorPrimaryBgHover: p.selectionHover,
    colorPrimaryBorder: p.selectionBorder, colorPrimaryBorderHover: p.selectionBorderHover,
    colorPrimaryText: p.accent, colorPrimaryTextHover: p.hover, colorPrimaryTextActive: p.active,
    colorPrimaryFill: p.primaryFill[0], colorPrimaryFillSecondary: p.primaryFill[1],
    colorPrimaryFillTertiary: p.primaryFill[2], colorPrimaryFillQuaternary: p.primaryFill[3],
    colorLink: p.accent, colorLinkHover: p.hover, colorLinkActive: p.active,
  };
  const baseAlgorithm = isDark ? theme.darkAlgorithm : theme.defaultAlgorithm;
  return {
    cssVar: { key: ANTD_CSS_VAR_KEY }, hashed: false, components, token,
    // Apply the palette last: Lobe's intermediate algorithm replaces Ant's primary family.
    algorithm: (seed, derived) => ({ ...(derived ?? baseAlgorithm(seed)), ...token }),
  };
}
