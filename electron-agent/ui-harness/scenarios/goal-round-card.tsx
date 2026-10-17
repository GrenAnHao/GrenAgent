import { useMemo, useState, type ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { applyEvent, initialAgentState, messagesFromAgent } from '../../src/stores/agentReducer'
import type { AgentEvent, AgentMessage } from '../../src/lib/pi'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { computeSubAgentUnits } from '../../src/features/chat/messagePrecompute'
import { renderMessageBody } from '../../src/features/chat/ChatMessageItems'
import { buildGoalRoundPrompt } from '@extensions/goal/prompt'
import { exposeActions, exposeData, installBridge } from '../stubs'

/**
 * Goal 每一轮续跑在对话里的卡片。续跑正文是 customType: goal-round、display: false 的自定义消息
 * （extensions/goal/continue.ts reenterGoalRound），正文用真实的 buildGoalRoundPrompt 造。
 * 历史：第 4、5 轮各一条，再放一条别的 display: false 消息做对照（它不该显示）。
 * 实时：probe 经 act 推第 6 轮，走真实 reducer 的 message_start / message_end。
 */

installBridge({})

const CONDITION = '按用户给的 M1→M4 流程推进客服模块：每期切分支 feat/kefu-m<N>、写计划、实现、单测、笔记、验收证据，然后进入下一期。'
const round = (n: number, timestamp = n): AgentMessage =>
  ({
    role: 'custom',
    customType: 'goal-round',
    content: buildGoalRoundPrompt({ condition: CONDITION, round: n, maxRounds: 256 }),
    display: false,
    details: { goalId: 'g1', revision: n + 1, round: n },
    timestamp,
  }) as unknown as AgentMessage

const history: AgentMessage[] = [
  round(4),
  { role: 'custom', customType: 'hidden-context', content: '# 不该显示\n- 别的 display:false 消息', display: false } as unknown as AgentMessage,
  round(5),
]

const context = {
  workspace: 'ui-harness-goal-round',
  store: { getLoadedSessionPath: () => '/goal-round.jsonl' } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}

let pushLive: (n: number) => void = () => {}
exposeActions({ pushLive: (n = 6) => pushLive(n) })
exposeData({ condition: CONDITION })

function Timeline(): ReactElement {
  const [state, setState] = useState(() => ({ ...initialAgentState(), messages: messagesFromAgent(history) }))
  pushLive = (n) => {
    const message = round(n, 1000 + n)
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

export default function GoalRoundCardScenario(): ReactElement {
  return (
    <AgentStoreContext.Provider value={context}>
      <div style={{ height: '100vh', overflow: 'auto', background: 'var(--gren-content-bg)' }}>
        <Timeline />
      </div>
    </AgentStoreContext.Provider>
  )
}
