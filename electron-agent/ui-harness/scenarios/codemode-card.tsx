import type { ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { applyEvent, initialAgentState, messagesFromAgent, type ChatMessage } from '../../src/stores/agentReducer'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { TurnTimeline } from '../../src/features/chat/TurnTimeline'
import {
  MANY_CALLS,
  historyMessages,
  liveDoneEvents,
  liveFailedEvents,
  liveRunningEvents,
  manyCallsMessages
} from '../codemodeFixtures'
import { exposeData, installBridge } from '../stubs'
import type { AgentEvent } from '../../src/lib/pi'

/**
 * codemode 工具卡：走真实 reducer（applyEvent / messagesFromAgent）→ groupMessages → TurnTimeline，
 * 四种情况各占一块：实时完成、实时运行中、实时失败、历史回放（只有 details.calls）。
 */

installBridge({})
exposeData({ cases: ['live-done', 'live-running', 'live-failed', 'history', 'many'], manyCalls: MANY_CALLS })

const mockCtx = {
  workspace: 'ui-harness',
  store: {} as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true
}

function replay(events: AgentEvent[]): ChatMessage[] {
  return events.reduce((state, event) => applyEvent(state, event), initialAgentState()).messages
}

const CASES: { id: string; title: string; messages: ChatMessage[] }[] = [
  { id: 'live-done', title: '实时 · 完成', messages: replay(liveDoneEvents()) },
  { id: 'live-running', title: '实时 · 运行中', messages: replay(liveRunningEvents()) },
  { id: 'live-failed', title: '实时 · 失败', messages: replay(liveFailedEvents()) },
  { id: 'history', title: '历史回放', messages: messagesFromAgent(historyMessages()) },
  { id: 'many', title: '历史 · 调用很多', messages: messagesFromAgent(manyCallsMessages()) }
]

function Turns({ messages }: { messages: ChatMessage[] }): ReactElement {
  return (
    <>
      {groupMessages(messages).map((item) =>
        item.kind === 'turn' ? <TurnTimeline key={item.id} segments={item.segments} /> : null
      )}
    </>
  )
}

export default function CodemodeCard(): ReactElement {
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <div
        style={{
          boxSizing: 'border-box',
          height: '100vh',
          overflow: 'auto',
          padding: '20px 24px 80px',
          background: 'var(--gren-content-bg)'
        }}
        className="harness-scroll"
      >
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
          {CASES.map((c) => (
            <section key={c.id} data-case={c.id}>
              <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6, color: 'var(--gren-fg-muted)' }}>{c.title}</div>
              <Turns messages={c.messages} />
            </section>
          ))}
        </div>
      </div>
    </AgentStoreContext.Provider>
  )
}
