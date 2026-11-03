import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { m } from 'motion/react';
import { ThemeBridge } from '../components/ThemeBridge';
import { workbenchTheme } from './workbenchTheme';

export function WorkbenchThemeProvider({ appearance, children }: {
  appearance: 'light' | 'dark' | 'auto';
  children: ReactNode;
}) {
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    if (appearance !== 'auto' || typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [appearance]);
  const dark = appearance === 'dark' || (appearance === 'auto' && systemDark);
  const mode = dark ? 'dark' : 'light';
  const antdTheme = useMemo(() => workbenchTheme(dark), [dark]);

  return (
    <ThemeProvider themeMode={mode} appearance={mode} theme={antdTheme}>
      <ConfigProvider motion={m}>
        <ThemeBridge />
        {children}
      </ConfigProvider>
    </ThemeProvider>
  );
}
