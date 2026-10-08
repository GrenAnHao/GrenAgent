import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { ConfigProvider, ThemeProvider } from '@lobehub/ui'
import { m } from 'motion/react'
import { ANTD_CSS_VAR_KEY, ThemeBridge } from '../src/components/ThemeBridge'
import { schemePrimary, schemeTokens } from '../src/theme/colorSchemes'

const isDark = (): boolean => document.documentElement.dataset.theme !== 'light'

/** 跟着 <html data-theme> 走：probe 里 t.setTheme('light') 只改属性，这里把 Provider 一起切过去。 */
function useHtmlDark(): boolean {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/**
 * 所有场景的根：和 src/App.tsx 同一套主题 Provider（github 方案、cssVar 固定 key、ThemeBridge 写 --gren-*），
 * 首次 commit 后设 __uiReady。明暗看 <html data-theme>（index.html 默认 dark，和应用默认外观一致）。
 * AgentStoreContext 这类壳层上下文按场景需要在场景里包。
 */
export default function HarnessRoot({ children }: { children: ReactNode }): ReactElement {
  const dark = useHtmlDark()
  const mode = dark ? 'dark' : 'light'
  // 父组件的 effect 在子组件之后执行：走到这里时场景已经首次 commit，run.mjs 等的就是这个标记
  useEffect(() => {
    ;(window as unknown as { __uiReady: boolean }).__uiReady = true
  }, [])
  return (
    <ThemeProvider
      themeMode={mode}
      appearance={mode}
      customTheme={{ primaryColor: schemePrimary('github', dark) }}
      theme={{ cssVar: { key: ANTD_CSS_VAR_KEY }, hashed: false, token: schemeTokens('github', dark) }}
    >
      <ConfigProvider motion={m}>
        <ThemeBridge />
        {children}
      </ConfigProvider>
    </ThemeProvider>
  )
}
