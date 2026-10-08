import { useState, type ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { applyEvent, initialAgentState } from '../../src/stores/agentReducer'
import type { AgentEvent, AgentMessage, SubAgentItem } from '../../src/lib/pi'
import { SubAgentConversation } from '../../src/features/panels/SubAgentConversation'
import { ChatMessageItems } from '../../src/features/chat/ChatMessageItems'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { SubAgentBody } from '../../src/features/dock/SubAgentBody'
import { useLayoutStore } from '../../src/stores/layoutStore'
import type { DockTab } from '../../src/stores/dockStore'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

const liveWorkspace = 'ui-harness-child-live'
const livePath = '/ui/child-live.jsonl'
const liveTask = '后台子代理思考预览'
const livePrefix = '检查实时思考的折叠预览。'
const liveDelta = '继续验证子代理状态、内容追加和外部滑动。'.repeat(90)
let liveFinished = false
const liveMessage = { role: 'assistant', timestamp: 2, content: [{ type: 'thinking', thinking: livePrefix + liveDelta }] }
const liveUser: AgentMessage = { role: 'user', timestamp: 1, content: [{ type: 'text', text: liveTask }] }
// 真实后台 spawn 的结果在子会话建立前就返回，details 里没有 sessionPath，只有登记表行里有。
const nopathPath = '/ui/child-nopath.jsonl'
const nopathTask = '后台子代理结果不带会话路径'
const nopathFinal = '无路径子代理已完成，正文仍在。'
let nopathFinished = false
const nopathMessage = { role: 'assistant', timestamp: 2, content: [{ type: 'thinking', thinking: livePrefix }, { type: 'text', text: nopathFinal }] }
const nopathUser: AgentMessage = { role: 'user', timestamp: 1, content: [{ type: 'text', text: nopathTask }] }
// 已经结束的后台子代理重新挂载详情：状态一开始就是终态，不会起轮询。
const donePath = '/ui/child-done.jsonl'
const doneTask = '已完成子代理重新打开'
const doneFinal = '重新打开后仍显示完整子会话。'
const doneMessages: AgentMessage[] = [
  { role: 'user', timestamp: 1, content: [{ type: 'text', text: doneTask }] },
  { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: doneFinal }] } as AgentMessage,
]
const listeners = new Set<(event: { payload: unknown }) => void>()
function emitTo(sessionPath: string, event: AgentEvent): void {
  for (const listener of listeners) listener({ payload: { workspace: liveWorkspace, source: 'subagent', sessionPath, event } })
}
const emitLive = (event: AgentEvent): void => emitTo(livePath, event)
installBridge({
  invoke: async (command: string, args?: { sessionPath?: string }) => {
    if (command === 'subagent_list') {
      track('subagent_list')
      return [
        { id: 'sa-live', task: liveTask, status: liveFinished ? 'done' : 'running', sessionPath: livePath, createdAt: 1, updatedAt: liveFinished ? 3 : 2 },
        { id: 'sa-nopath', task: nopathTask, status: nopathFinished ? 'done' : 'running', sessionPath: nopathPath, createdAt: 1, updatedAt: nopathFinished ? 3 : 2 },
        { id: 'sa-done', task: doneTask, status: 'done', sessionPath: donePath, createdAt: 1, updatedAt: 3 },
      ] satisfies SubAgentItem[]
    }
    if (command === 'subagent_get_session_messages') {
      if (args?.sessionPath === nopathPath) return { messages: nopathFinished ? [nopathUser, nopathMessage] : [nopathUser] }
      if (args?.sessionPath === donePath) return { messages: doneMessages }
      return { messages: liveFinished ? [liveUser, liveMessage] : [liveUser] }
    }
    if (command === 'subagent_get_transcript') return null
    throw new Error(`unexpected command: ${command}`)
  },
  subscribe: async (event: string, listener: (event: { payload: unknown }) => void) => {
    if (event !== 'pi://event') throw new Error(`unexpected event: ${event}`)
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
})
exposeActions({
  startLive: () => {
    emitLive({ type: 'message_start', message: { role: 'assistant', timestamp: 2, content: [] } })
    emitLive({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: livePrefix } })
  },
  appendLive: () => emitLive({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: liveDelta } }),
  finishLive: () => {
    liveFinished = true
    emitLive({ type: 'message_end', message: liveMessage })
    emitLive({ type: 'agent_end', messages: [] })
  },
  startNopath: () => {
    emitTo(nopathPath, { type: 'message_start', message: { role: 'assistant', timestamp: 2, content: [] } })
    emitTo(nopathPath, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: livePrefix } })
  },
  finishNopath: () => {
    nopathFinished = true
    emitTo(nopathPath, { type: 'message_end', message: nopathMessage })
    emitTo(nopathPath, { type: 'agent_end', messages: [] })
  },
})

const STEPS = 180
const task = '逐步检查 180 个模块，记录执行过程和最终结论。'
const reasoning = Array.from({ length: 80 }, (_, i) => `推理第 ${i + 1} 行：核对模块边界和验证结果。`).join('\n\n')
const events: AgentEvent[] = []
for (let i = 0; i < STEPS; i++) {
  const message = { role: 'assistant', content: [{ type: 'thinking', thinking: `检查模块 ${i + 1}` }] }
  events.push(
    { type: 'message_start', message },
    { type: 'message_end', message },
    { type: 'tool_execution_start', toolCallId: `bash-${i}`, toolName: 'bash', args: { command: `echo module-${i + 1}` } },
    { type: 'tool_execution_end', toolCallId: `bash-${i}`, toolName: 'bash', result: { content: [{ type: 'text', text: `module-${i + 1} checked` }] }, isError: false },
  )
}
const message = { role: 'assistant', content: [{ type: 'thinking', thinking: reasoning }, { type: 'text', text: '所有模块已检查完成。' }] }
events.push({ type: 'message_start', message }, { type: 'message_end', message })
const result = { details: { transcript: events.map((event) => JSON.stringify(event)).join('\n') } }
const spacingEvents = events.slice(0, 12)
const spacingMessage = { role: 'assistant', content: [{ type: 'text', text: '间距对照结束。' }] }
spacingEvents.push({ type: 'message_start', message: spacingMessage }, { type: 'message_end', message: spacingMessage })
const spacingResult = { details: { transcript: spacingEvents.map((event) => JSON.stringify(event)).join('\n') } }
const spacingMessages = groupMessages(spacingEvents.reduce(applyEvent, initialAgentState()).messages)

exposeData({ steps: STEPS, task, finalText: '所有模块已检查完成。', reasoningLastLine: '推理第 80 行', liveTask, livePrefix, nopathTask, nopathFinal, doneTask, doneFinal })

const state = initialAgentState()
const mockCtx = {
  workspace: '',
  store: { useStore: (selector: (value: typeof state) => unknown) => selector(state) } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}
const liveResult = { content: [{ type: 'text', text: 'Background sub-agent started.\nAgent: sa-live' }], details: { agentId: 'sa-live', status: 'running', sessionPath: livePath } }
const liveState = [
  { type: 'tool_execution_start', toolCallId: 'live-spawn', toolName: 'spawn_agent', args: { task: liveTask } },
  { type: 'tool_execution_end', toolCallId: 'live-spawn', toolName: 'spawn_agent', result: liveResult, isError: false },
].reduce((current, event) => applyEvent(current, event as AgentEvent), initialAgentState())
const liveCtx = { ...mockCtx, workspace: liveWorkspace, store: { useStore: (selector: (value: typeof liveState) => unknown) => selector(liveState) } as unknown as AgentStoreApi }
const liveTab: DockTab = { id: 'live-tab', kind: 'subagent', region: 'right', title: liveTask, closable: true, order: 0, payload: { messageId: liveState.messages[0]!.id, toolCallId: 'live-spawn' } }
const nopathResult = { content: [{ type: 'text', text: 'Background sub-agent started.\nAgent: sa-nopath' }], details: { agentId: 'sa-nopath', status: 'running' } }
const nopathState = [
  { type: 'tool_execution_start', toolCallId: 'nopath-spawn', toolName: 'spawn_agent', args: { task: nopathTask } },
  { type: 'tool_execution_end', toolCallId: 'nopath-spawn', toolName: 'spawn_agent', result: nopathResult, isError: false },
].reduce((current, event) => applyEvent(current, event as AgentEvent), initialAgentState())
const nopathCtx = { ...mockCtx, workspace: liveWorkspace, store: { useStore: (selector: (value: typeof nopathState) => unknown) => selector(nopathState) } as unknown as AgentStoreApi }
const nopathTab: DockTab = { id: 'nopath-tab', kind: 'subagent', region: 'right', title: nopathTask, closable: true, order: 0, payload: { messageId: nopathState.messages[0]!.id, toolCallId: 'nopath-spawn' } }
const doneResult = { content: [{ type: 'text', text: 'Background sub-agent started.\nAgent: sa-done' }], details: { agentId: 'sa-done', status: 'running' } }
useLayoutStore.setState({ rightPanelOpen: true, sidebarOpen: false, availableWidth: 1420 })

export default function SubagentConversation(): ReactElement {
  const [mode, setMode] = useState<'long' | 'spacing' | 'live' | 'nopath' | 'done-nopath'>('long')
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', width: mode === 'spacing' ? 1100 : 780, margin: '0 auto', background: 'var(--gren-content-bg)' }}>
        <div style={{ flex: 'none' }}>
          <button data-testid="show-spacing" onClick={() => setMode('spacing')}>主对话 / 子代理间距对照</button>
          <button data-testid="show-long" onClick={() => setMode('long')}>长工具循环</button>
          <button data-testid="show-live" onClick={() => setMode('live')}>后台子代理实时思考</button>
          <button data-testid="show-nopath" onClick={() => setMode('nopath')}>结果不带会话路径</button>
          <button data-testid="show-done-nopath" onClick={() => setMode('done-nopath')}>终态挂载缺路径</button>
        </div>
        {mode === 'spacing' ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <ChatMessageItems messages={spacingMessages} unitsByMessage={new Map()} answeredQuestions={new Set()} paddingInline={16} data-testid="main-spacing" />
            <SubAgentConversation task="间距对照任务" result={spacingResult} status="done" data-testid="child-spacing" />
          </div>
        ) : mode === 'live' ? (
          <AgentStoreContext.Provider value={liveCtx}><SubAgentBody tab={liveTab} active /></AgentStoreContext.Provider>
        ) : mode === 'nopath' ? (
          <AgentStoreContext.Provider value={nopathCtx}><SubAgentBody tab={nopathTab} active /></AgentStoreContext.Provider>
        ) : mode === 'done-nopath' ? (
          <SubAgentConversation task={doneTask} result={doneResult} status="done" workspace={liveWorkspace} agentId="sa-done" data-testid="child-done-nopath" />
        ) : <SubAgentConversation task={task} result={result} status="done" data-testid="child-conversation" />}
      </div>
    </AgentStoreContext.Provider>
  )
}
