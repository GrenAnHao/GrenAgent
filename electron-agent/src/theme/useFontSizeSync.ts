import { useLayoutEffect } from 'react';
import { useThemeStore } from '../stores/themeStore';
import { clampFontSize } from './contentFont';

export function useFontSizeSync(): void {
  const fontSize = useThemeStore((s) => s.fontSize);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--pi-font-size', `${clampFontSize(fontSize)}px`);
  }, [fontSize]);
}
