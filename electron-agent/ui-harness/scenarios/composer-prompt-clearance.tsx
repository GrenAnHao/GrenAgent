import { useRef, useState } from 'react'
import { ComposerOverlayRegistration, useComposerClearance } from '../../src/features/chat/composerClearance'
import { ComposerPromptOverlay } from '../../src/features/chat/input/ComposerPromptOverlay'
import { VirtualizedMessageList } from '../../src/features/chat/VirtualizedMessageList'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { initialAgentState, type AgentState } from '../../src/stores/agentReducer'
import { useInlineQuestionStore } from '../../src/stores/inlineQuestionStore'
import { useUiPromptStore } from '../../src/stores/uiPromptStore'
import { exposeActions, installBridge } from '../stubs'

const workspace = '/clearance-fixture'
const context = {
  workspace,
  store: { useStore: (selector: (state: AgentState) => unknown) => selector(initialAgentState()) } as unknown as AgentStoreApi,
  workspaceReady: true, setWorkspaceReady: () => {}, appBooted: true,
}
installBridge({ invoke: async () => null, subscribe: async () => () => {} })
const items = Array.from({ length: 30 }, (_, i) => ({ id: String(i) }))
function close() {
  useInlineQuestionStore.setState({ byWorkspace: {} })
  useUiPromptStore.setState({ byWorkspace: {}, waiting: {} })
}

// Same registration, portal and virtualized footer as ChatView; no real session/IPC/data.
export default function ComposerPromptClearance() {
  const viewport = useRef<HTMLDivElement>(null)
  const seat = useRef<HTMLDivElement>(null)
  const [session, setSession] = useState(0)
  const [seatHeight, setSeatHeight] = useState(100)
  const { paddingBottom, registerOverlay } = useComposerClearance(viewport, seat, String(session))
  exposeActions({
    close,
    select: () => {
      close()
      useUiPromptStore.getState().setRequest({ workspace, request: { id: 'select', method: 'select', title: '选择下一步', options: ['查看方案', '继续讨论'] } })
    },
    question: (long = false) => {
      close()
      useInlineQuestionStore.getState().setRequest({ workspace, id: 'question', mode: 'live', data: {
        kind: 'questions', id: 'question', questions: [{ id: 'q', title: long ? '说明详细约束后选择下一步。'.repeat(16) : '接下来做什么？', options: [{ id: 'a', label: '查看方案' }, { id: 'b', label: '继续讨论' }] }],
      } })
    },
    seat: (height: number) => setSeatHeight(height),
    session: () => { close(); setSession(value => value + 1) },
  })
  return <AgentStoreContext.Provider value={context}>
    <ComposerOverlayRegistration.Provider value={registerOverlay}>
      <div data-chat-column="" style={{ position: 'relative', height: '100vh', maxWidth: 780, margin: 'auto', overflow: 'hidden' }}>
        <div ref={viewport} style={{ position: 'relative', height: '100%' }}>
          <VirtualizedMessageList display={items} renderItem={item => <div data-testid={`clearance-row-${item.id}`} style={{ height: 80 }}>正文 {item.id} — 结尾必须完整可见</div>} fill="absolute" resetKey={String(session)} paddingBottom={paddingBottom} data-testid="chat-scroll" />
          <div ref={seat} data-testid="clearance-seat" style={{ position: 'absolute', bottom: 0, width: '100%', height: seatHeight, background: 'var(--gren-content-bg)' }}>输入区域</div>
          <ComposerPromptOverlay anchorRef={seat} />
        </div>
      </div>
    </ComposerOverlayRegistration.Provider>
  </AgentStoreContext.Provider>
}
