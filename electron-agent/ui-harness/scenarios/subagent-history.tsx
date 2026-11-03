import { useMemo, useState, type ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { applyEvent, initialAgentState, materializeToolDrafts, messagesFromAgent, type ChatMessage } from '../../src/stores/agentReducer'
import { parsePartialArgs } from '../../src/lib/streamingJson'
import type { AgentEvent, AgentMessage, SubAgentItem } from '../../src/lib/pi'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { computeSubAgentUnits } from '../../src/features/chat/messagePrecompute'
import { renderMessageBody } from '../../src/features/chat/ChatMessageItems'
import { deferred, exposeActions, exposeData, installBridge, track } from '../stubs'

const rows: SubAgentItem[] = [
  { id: 'sa-unrelated', task: '重复任务', status: 'done', model: 'p/wrong-model', createdAt: 5, updatedAt: 5 },
  { id: 'sa-b', task: '检查并发查询', status: 'done', model: 'p/model-b', createdAt: 4, updatedAt: 4 },
  { id: 'sa-group-b', task: '重复任务', status: 'done', model: 'q/group-b', createdAt: 3, updatedAt: 3 },
  { id: 'sa-a', task: '检查恢复标题与模型', status: 'done', model: 'p/model-a', thinkingLevel: 'high', createdAt: 2, updatedAt: 2 },
  { id: 'sa-group-a', task: '重复任务', status: 'done', model: 'p/group-a', thinkingLevel: 'medium', createdAt: 1, updatedAt: 1 }
]
const registry = deferred<SubAgentItem[]>()
installBridge({
  invoke: async (command: string) => {
    // 供应商显示名：p 有名字，q 没配置（回落到 id）。
    if (command === 'get_provider_config') return { modelsJson: JSON.stringify({ providers: { p: { name: '中转站' } } }), authJson: null }
    if (command !== 'subagent_list') throw new Error(`unexpected command: ${command}`)
    track('registry-list')
    return registry.promise
  }
})
exposeActions({ releaseRegistry: () => registry.resolve(rows) })
exposeData({ titles: ['检查恢复标题与模型', '检查并发查询'], models: ['中转站 / model-a · 高', '中转站 / model-b'], groupModels: ['中转站 / group-a · 中', 'q / group-b'] })

// 旧的 wait/status 结果不带模型；原启动消息已不在上下文。并行结果也曾漏存模型。
const history: AgentMessage[] = [
  { role: 'assistant', content: [
    { type: 'toolCall', id: 'wait-a', name: 'spawn_agent', arguments: { action: 'wait', agentId: 'sa-a' } },
    { type: 'toolCall', id: 'wait-b', name: 'spawn_agent', arguments: { action: 'status', agentId: 'sa-b' } },
    { type: 'toolCall', id: 'group', name: 'spawn_agent', arguments: { tasks: ['重复任务', '重复任务'] } }
  ] },
  { role: 'toolResult', toolCallId: 'wait-a', toolName: 'spawn_agent', content: [{ type: 'text', text: '结果 A' }], details: { agentId: 'sa-a', status: 'done' } },
  { role: 'toolResult', toolCallId: 'wait-b', toolName: 'spawn_agent', content: [{ type: 'text', text: '结果 B' }], details: { agentId: 'sa-b', status: 'done' } },
  { role: 'toolResult', toolCallId: 'group', toolName: 'spawn_agent', content: [], details: { results: [
    { agentId: 'sa-group-a', task: '重复任务', ok: true },
    { agentId: 'sa-group-b', task: '重复任务', ok: true }
  ] } }
]
const rejectedText = '子代理已被禁用（设置 → 子代理 → 模型策略 = 禁用子代理）。'
function callHistory(id: string, args: object, details: object, text = '完成', isError = false): AgentMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'toolCall', id, name: 'spawn_agent', arguments: args }] },
    { role: 'toolResult', toolCallId: id, toolName: 'spawn_agent', content: [{ type: 'text', text }], details, isError },
  ] as AgentMessage[]
}
const emptyCases = [
  { id: 'empty-single', messages: callHistory('empty-single', { action: 'spawn', task: '审查成功任务', title: '空数组成功', tasks: [], chain: [] }, { agentId: 'sa-empty', status: 'done', model: 'p/actual', sessionPath: '/empty.jsonl' }, '空数组成功结果') },
  { id: 'empty-rejected', messages: callHistory('empty-rejected', { task: '拒绝任务', title: '空数组拒绝', tasks: [], chain: [] }, {}, rejectedText, true) },
  { id: 'empty-chain', messages: callHistory('empty-chain', { tasks: [], chain: [{ task: '链式第一步' }, { task: '链式第二步' }] }, { mode: 'chain', results: [{ task: '链式第一步', ok: true, model: 'p/first' }, { task: '链式第二步', ok: true, model: 'p/second' }] }) },
  { id: 'one-step-chain', messages: callHistory('one-step-chain', { tasks: [], chain: [{ task: '唯一链式步骤' }] }, { mode: 'chain', results: [{ task: '唯一链式步骤', ok: true, model: 'p/step', agentId: 'sa-step' }] }) },
  { id: 'mixed-tasks', messages: callHistory('mixed-tasks', { task: '顶层完整任务', title: '顶层标题', model: 'p/top', tasks: [{ task: '数组完整任务', title: '数组标题', model: 'p/array' }] }, { results: [{ ok: true, agentId: 'sa-top' }, { ok: true, agentId: 'sa-array' }] }) },
  { id: 'rejected-group', messages: callHistory('rejected-group', { tasks: ['被拒绝的甲', '被拒绝的乙'] }, {}, rejectedText, true) },
  { id: 'empty-no-work', messages: callHistory('empty-no-work', { tasks: [], chain: [] }, {}, 'provide task, tasks, or chain', true) },
  { id: 'empty-followup', messages: [
    ...callHistory('follow-origin', { action: 'spawn', title: '后续结果任务', task: '等待后续结果', tasks: [], chain: [] }, { agentId: 'sa-follow', status: 'running', model: 'p/follow', sessionPath: '/follow.jsonl' }),
    ...callHistory('follow-status', { action: 'status', agentId: 'sa-follow', tasks: [], chain: [] }, { agentId: 'sa-follow', status: 'done' }, '归并后的最终正文'),
  ] },
]

function streamMessages(stage: number): ChatMessage[] {
  const fragments = ['{"tasks":[', '"流式任务甲",', '"流式任务乙"]}']
  let state = applyEvent(initialAgentState(), { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'stream-empty', toolName: 'spawn_agent' } } as AgentEvent)
  for (const delta of fragments.slice(0, stage + 1)) {
    state = applyEvent(state, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta } } as AgentEvent)
  }
  return materializeToolDrafts(state, 10_000, parsePartialArgs).state.messages
}

function RegressionCards(): ReactElement {
  const [stage, setStage] = useState(0)
  const renderCards = (messages: ChatMessage[]) => {
    const display = groupMessages(messages)
    const index = computeSubAgentUnits(display)
    return display.filter((message) => !index.hidden.has(message.id)).map((message) =>
      <div key={message.id}>{renderMessageBody(message, index.unitsByMessage, new Set(), false, false, index.overlay)}</div>)
  }
  return <div id="empty-array-cards">
    {emptyCases.map(({ id, messages }) => <section id={id} key={id} style={{ marginBlock: 16 }}>{renderCards(messagesFromAgent(messages))}</section>)}
    <section id="stream-cards">
      <button id="advance-stream" onClick={() => setStage((value) => Math.min(2, value + 1))}>继续参数流</button>
      {renderCards(streamMessages(stage))}
    </section>
  </div>
}

const context = {
  workspace: 'ui-harness-subagent-history',
  store: { getLoadedSessionPath: () => '/history.jsonl' } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true
}

function HistoryCards(): ReactElement {
  const display = useMemo(() => groupMessages(messagesFromAgent(history)), [])
  const index = useMemo(() => computeSubAgentUnits(display), [display])
  return <div id="history-cards">
    {display.map((message) => <div key={message.id} style={{ marginBottom: 12 }}>
      {renderMessageBody(message, index.unitsByMessage, new Set())}
    </div>)}
  </div>
}

export default function SubagentHistory(): ReactElement {
  const [generation, setGeneration] = useState(0)
  const [regression, setRegression] = useState(false)
  return <AgentStoreContext.Provider value={context}>
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)', overflow: 'auto' }}>
      <div style={{ maxWidth: 850, margin: '0 auto' }}>
        <button id="reopen-history" onClick={() => setGeneration((value) => value + 1)}>重新打开会话</button>
        <button id="show-empty-arrays" onClick={() => setRegression(true)}>空数组回归</button>
        {regression ? <RegressionCards key={generation} /> : <HistoryCards key={generation} />}
      </div>
    </div>
  </AgentStoreContext.Provider>
}
