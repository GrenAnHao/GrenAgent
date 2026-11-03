import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { clampFontSize, FONT_SIZE_DEFAULT } from '../theme/contentFont';

export type Appearance = 'light' | 'dark' | 'auto';

interface ThemeState {
  appearance: Appearance;
  fontSize: number;
  setAppearance: (appearance: Appearance) => void;
  setFontSize: (fontSize: number) => void;
  toggleAppearance: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      appearance: 'dark',
      fontSize: FONT_SIZE_DEFAULT,
      setAppearance: (appearance) => set({ appearance }),
      setFontSize: (fontSize) => set({ fontSize: clampFontSize(fontSize) }),
      toggleAppearance: () =>
        set((state) => ({ appearance: state.appearance === 'dark' ? 'light' : 'dark' })),
    }),
    {
      name: 'pi-theme',
      partialize: (state) => ({
        appearance: state.appearance,
        fontSize: state.fontSize,
      }),
      // 只恢复仍受支持的偏好，旧配色字段不能被 zustand 默认浅合并带回运行态。
      merge: (persistedState, currentState) => {
        const saved = persistedState as Partial<ThemeState> | undefined;
        return {
          ...currentState,
          appearance: saved?.appearance ?? currentState.appearance,
          fontSize: clampFontSize(saved?.fontSize ?? currentState.fontSize),
        };
      },
    },
  ),
);
