import { useMemo, useState, type ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { applyEvent, initialAgentState, messagesFromAgent } from '../../src/stores/agentReducer'
import type { AgentEvent, AgentMessage } from '../../src/lib/pi'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { computeSubAgentUnits } from '../../src/features/chat/messagePrecompute'
import { renderMessageBody } from '../../src/features/chat/ChatMessageItems'
import { exposeActions, exposeData, installBridge } from '../stubs'

/**
 * send_message wake: false 的消息（自定义消息 agent-message）在对话里的样子。
 * 历史：子代理的会话里，父会话不唤醒地发来一条（agent-message），另有一条普通的注入通知做对照。实时：probe 经 act 推一条子代理→父会话的 agent-message，
 * 走真实 reducer 的 message_start / message_end（形状照 pi AgentSession._appendCustomMessage）。
 */

installBridge({})

const quiet = (from: string, body: string): string => `Agent ${from} sent a message without waking you:\n${body}`

const HISTORY_BODY = 'API 密钥已经挪到 `.env.local`，现在不用处理，等我下次叫你时再用。'
const LIVE_BODY = '最终结果：三个失败用例都是时区问题，已在 `date.ts` 修好，测试全绿。'

// 只放通知：用户 / 助手气泡要订阅真实的会话 store，这里只验证提示条。
const history: AgentMessage[] = [
  { role: 'custom', customType: 'agent-message', content: quiet('parent-1', HISTORY_BODY), display: true } as unknown as AgentMessage,
  { role: 'custom', customType: 'skill-hint', content: '# 注入\n- 一条普通的上下文注入', display: true } as unknown as AgentMessage,
]

const context = {
  workspace: 'ui-harness-agent-message',
  store: { getLoadedSessionPath: () => '/agent-message.jsonl' } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}

let pushLive: (timestamp: number) => void = () => {}
exposeActions({ pushLive: (timestamp = 1) => pushLive(timestamp) })
exposeData({ historyBody: HISTORY_BODY, liveBody: LIVE_BODY })

function Timeline(): ReactElement {
  const [state, setState] = useState(() => {
    let s = initialAgentState()
    s = { ...s, messages: messagesFromAgent(history) }
    return s
  })
  // 同一条消息的 message_start / message_end 只显示一次；正文相同、timestamp 不同的是两次发送，两条都显示。
  pushLive = (timestamp) => {
    const message = { role: 'custom', customType: 'agent-message', content: quiet('sa-7', LIVE_BODY), display: true, timestamp }
    setState((prev) =>
      applyEvent(applyEvent(prev, { type: 'message_start', message } as unknown as AgentEvent), {
        type: 'message_end',
        message,
      } as unknown as AgentEvent),
    )
  }
  const display = useMemo(() => groupMessages(state.messages), [state.messages])
  const index = useMemo(() => computeSubAgentUnits(display), [display])
  return (
    <div id="timeline" style={{ width: 720, margin: '0 auto', paddingTop: 24 }}>
      {display.map((message) => (
        <div key={message.id} style={{ marginBottom: 12 }}>
          {renderMessageBody(message, index.unitsByMessage, new Set())}
        </div>
      ))}
    </div>
  )
}

export default function AgentMessageScenario(): ReactElement {
  return (
    <AgentStoreContext.Provider value={context}>
      <div style={{ height: '100vh', overflow: 'auto', background: 'var(--gren-content-bg)' }}>
        <Timeline />
      </div>
    </AgentStoreContext.Provider>
  )
}
