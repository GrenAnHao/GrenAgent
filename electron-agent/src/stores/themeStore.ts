import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_COLOR_SCHEME, type PrimaryColorName } from '../theme/colorSchemes';
import { clampFontSize, FONT_SIZE_DEFAULT } from '../theme/contentFont';

export type Appearance = 'light' | 'dark' | 'auto';

/** 主题色名（取值与 @lobehub/ui customTheme.primaryColor 预设一致）。undefined = 跟随配色方案。 */
export type PrimaryColor = PrimaryColorName;

/** 中性色名（取值与 @lobehub/ui customTheme.neutralColor 预设一致）。undefined = 库默认。 */
export type NeutralColor = 'mauve' | 'olive' | 'sage' | 'sand' | 'slate';

interface ThemeState {
  appearance: Appearance;
  primaryColor?: PrimaryColor;
  neutralColor?: NeutralColor;
  /** 配色预设 id（见 theme/colorSchemes）；驱动表面/文字/边框的整体方案，并给出默认主题色。 */
  colorScheme: string;
  fontSize: number;
  setAppearance: (appearance: Appearance) => void;
  setPrimaryColor: (color?: PrimaryColor) => void;
  setNeutralColor: (color?: NeutralColor) => void;
  setColorScheme: (id: string) => void;
  setFontSize: (fontSize: number) => void;
  toggleAppearance: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      appearance: 'dark',
      primaryColor: undefined,
      neutralColor: undefined,
      colorScheme: DEFAULT_COLOR_SCHEME,
      fontSize: FONT_SIZE_DEFAULT,
      setAppearance: (appearance) => set({ appearance }),
      setPrimaryColor: (primaryColor) => set({ primaryColor }),
      setNeutralColor: (neutralColor) => set({ neutralColor }),
      setColorScheme: (colorScheme) => set({ colorScheme }),
      setFontSize: (fontSize) => set({ fontSize: clampFontSize(fontSize) }),
      toggleAppearance: () =>
        set((state) => ({ appearance: state.appearance === 'dark' ? 'light' : 'dark' })),
    }),
    {
      name: 'pi-theme',
      partialize: (state) => ({
        appearance: state.appearance,
        primaryColor: state.primaryColor,
        neutralColor: state.neutralColor,
        colorScheme: state.colorScheme,
        fontSize: state.fontSize,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const next = clampFontSize(state.fontSize);
        if (next !== state.fontSize) useThemeStore.setState({ fontSize: next });
      },
    },
  ),
);
