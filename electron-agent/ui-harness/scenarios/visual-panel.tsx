import type { ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { VisualPanel } from '../../src/features/visual/VisualPanel'
import { useVisualStore } from '../../src/stores/visualStore'
import { exposeActions, installBridge, track } from '../stubs'
import { shortHtml, tallHtml } from '../visualFixtures'

/**
 * 右侧「视觉设计」面板：真实 VisualPanel + 真实 HtmlPreview + 真实 buildSrcDoc(fill)。
 * iframe 里的几何由 probe 通过主进程的 webFrameMain.executeJavaScript 读（沙箱 iframe 是独立进程，页面里读不到）。
 * 主进程那头的 extension_ui_respond 用桩，收到的回答记成 respond:<JSON>。
 */

installBridge({
  invoke: async (command: string, args: { response?: { value?: string } }) => {
    if (command === 'extension_ui_respond') track(`respond:${args.response?.value ?? ''}`)
  }
})

const show = (html: string): void => {
  const store = useVisualStore.getState()
  store.setVisual(html, 'panel')
  store.setPending(true, 'req-ui-harness')
}

show(tallHtml())
// 换页面：sessionId 变了，面板会重新挂一个 iframe
exposeActions({ showTall: () => show(tallHtml()), showShort: () => show(shortHtml()) })

const mockCtx = {
  workspace: 'ui-harness',
  store: {} as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true
}

export default function VisualPanelScenario(): ReactElement {
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--gren-content-bg)' }}>
        <VisualPanel />
      </div>
    </AgentStoreContext.Provider>
  )
}
