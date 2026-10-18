import type { ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { VisualPanel } from '../../src/features/visual/VisualPanel'
import { useVisualStore, visualKeyOf } from '../../src/stores/visualStore'
import { exposeActions, installBridge, track } from '../stubs'
import { shortHtml, tallHtml } from '../visualFixtures'

/**
 * 右侧「视觉设计」面板：真实 VisualPanel + 真实 HtmlPreview + 真实 buildSrcDoc(fill)。
 * iframe 里的几何由 probe 通过主进程的 webFrameMain.executeJavaScript 读（沙箱 iframe 是独立进程，页面里读不到）。
 * 主进程那头的 extension_ui_respond 用桩，收到的回答记成 respond:<JSON>，目标工作区记成 respond-ws:<路径>。
 * 视觉设计登记在「发起会话」名下（OWNER），和 AgentStoreContext 里当前画面的工作区故意不同：
 * 回写必须落在发起会话的工作区上，而不是当前画面的。
 */

installBridge({
  invoke: async (command: string, args: { workspace?: string; response?: { value?: string } }) => {
    if (command === 'extension_ui_respond') {
      track(`respond-ws:${args.workspace ?? ''}`)
      track(`respond:${args.response?.value ?? ''}`)
    }
  }
})

const OWNER = { sessionPath: 'D:/proj-a/.sessions/a.jsonl', workspace: 'D:/proj-a' }
const VISUAL_KEY = visualKeyOf(OWNER)

const show = (html: string): void => {
  const store = useVisualStore.getState()
  store.setVisual(OWNER, html, 'panel')
  store.setPending(OWNER, true, 'req-ui-harness')
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
        <VisualPanel visualKey={VISUAL_KEY} />
      </div>
    </AgentStoreContext.Provider>
  )
}
