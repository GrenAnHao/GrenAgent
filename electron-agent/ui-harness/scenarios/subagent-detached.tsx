import { useMemo, type ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { messagesFromAgent } from '../../src/stores/agentReducer'
import type { AgentMessage, SubAgentItem } from '../../src/lib/pi'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { computeSubAgentUnits } from '../../src/features/chat/messagePrecompute'
import { renderMessageBody } from '../../src/features/chat/ChatMessageItems'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 前台 run 等待时用户发话，还没完成的子代理转到后台（extensions/multi-agent/detach.ts）后，对话里的卡片。
 * 一次单任务 run 和一次并行 run 的工具结果，形状照 spawn_agent 转后台的回执。并行那次五项：
 * - 快任务：转后台前已完成；
 * - 慢任务：转后台，注册表里在跑；
 * - 晚到的任务：转后台，卡片第一次读注册表时它还没建出来（run 一开始就转后台、下一次轮询还没到），之后才出现；
 * - 丢失的任务：转后台，注册表里一直没有（被删，或被更新的行挤出列表）；
 * - 排队的任务：转后台时还没轮到、没有 agentId，probe 之后经 act 才在注册表里加上它。
 * subagent_list 用桩，probe 经 act 把它们在注册表里改成已完成，卡片要跟着轮询变成终态。
 */

const rows = new Map<string, SubAgentItem>([
  ['sa-single', { id: 'sa-single', task: '写出 1 到 400', status: 'running', model: 'p/model-a', createdAt: 1, updatedAt: 1 }],
  ['sa-fast', { id: 'sa-fast', task: '快任务', status: 'done', model: 'p/model-a', createdAt: 2, updatedAt: 2 }],
  ['sa-slow', { id: 'sa-slow', task: '慢任务', status: 'running', model: 'p/model-a', createdAt: 3, updatedAt: 3 }],
])
// 第一次读之后才建出来的行。
const late: SubAgentItem = { id: 'sa-late', task: '晚到的任务', status: 'running', model: 'p/model-a', createdAt: 4, updatedAt: 4 }
let reads = 0

installBridge({
  invoke: async (command: string) => {
    if (command === 'get_provider_config') return { modelsJson: JSON.stringify({ providers: { p: { name: '中转站' } } }), authJson: null }
    if (command === 'subagent_list') {
      track('registry-list')
      const snapshot = [...rows.values()]
      reads += 1
      if (reads === 1) rows.set(late.id, late)
      return snapshot
    }
    throw new Error(`unexpected command: ${command}`)
  },
})

exposeActions({
  finish: (id: string, status: 'done' | 'error' = 'done') => {
    const row = rows.get(id)
    if (row) rows.set(id, { ...row, status, updatedAt: row.updatedAt + 10 })
  },
  add: (id: string, task: string) => {
    rows.set(id, { id, task, status: 'running', model: 'p/model-a', createdAt: 10, updatedAt: 10 })
  },
})
// 「晚到的任务」那一行有没有画过「已中断」。错的写法只闪一下：别的行还在轮询，下一次读到它就改回运行中；
// 只有它是最后一个在跑的行时才会一直错下去。所以从挂载起盯着，不看某一刻。
const watch = { lateFlashedInterrupted: false }
new MutationObserver(() => {
  const late = document.querySelectorAll('[data-testid="subagent-group"] [data-testid^="subagent-group-row-"]')[2]
  if (late?.textContent?.includes('已中断')) watch.lateFlashedInterrupted = true
}).observe(document.documentElement, { subtree: true, childList: true, characterData: true })
exposeData({ single: 'sa-single', slow: 'sa-slow', watch })

const history: AgentMessage[] = [
  { role: 'assistant', content: [
    { type: 'toolCall', id: 'run-single', name: 'spawn_agent', arguments: { title: '写出 1 到 400', task: '写出 1 到 400' } },
  ] },
  { role: 'toolResult', toolCallId: 'run-single', toolName: 'spawn_agent', content: [{ type: 'text', text:
    'A new message arrived while this run was waiting, so sub-agent sa-single moved to the background and keeps running.' }],
    details: { agentId: 'sa-single', sessionPath: '/s/sa-single.jsonl', status: 'running', detached: true, model: 'p/model-a' } },
  { role: 'assistant', content: [
    { type: 'toolCall', id: 'run-group', name: 'spawn_agent', arguments: { tasks: [
      { title: '快任务', task: '快任务' },
      { title: '慢任务', task: '慢任务' },
      { title: '晚到的任务', task: '晚到的任务' },
      { title: '丢失的任务', task: '丢失的任务' },
      { title: '排队的任务', task: '排队的任务' },
    ] } },
  ] },
  { role: 'toolResult', toolCallId: 'run-group', toolName: 'spawn_agent', content: [{ type: 'text', text:
    'A new message arrived while this run was waiting, so 4 unfinished sub-agent(s) moved to the background and keep running.' }],
    details: { mode: 'parallel', detached: true, count: 5, failed: 0, results: [
      { task: '快任务', ok: true, output: '快任务结果', agentId: 'sa-fast', sessionPath: '/s/sa-fast.jsonl', model: 'p/model-a' },
      { task: '慢任务', status: 'running', detached: true, agentId: 'sa-slow', sessionPath: '/s/sa-slow.jsonl', model: 'p/model-a' },
      { task: '晚到的任务', status: 'running', detached: true, agentId: 'sa-late', model: 'p/model-a' },
      { task: '丢失的任务', status: 'running', detached: true, agentId: 'sa-gone', model: 'p/model-a' },
      { task: '排队的任务', status: 'running', detached: true, model: 'p/model-a' },
    ] } },
] as unknown as AgentMessage[]

const context = {
  workspace: 'ui-harness-subagent-detached',
  store: { getLoadedSessionPath: () => '/s/parent.jsonl' } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}

function Cards(): ReactElement {
  const display = useMemo(() => groupMessages(messagesFromAgent(history)), [])
  const index = useMemo(() => computeSubAgentUnits(display), [display])
  return <div id="detached-cards">
    {display.map((message) => <div key={message.id} style={{ marginBottom: 12 }}>
      {renderMessageBody(message, index.unitsByMessage, new Set())}
    </div>)}
  </div>
}

export default function SubagentDetached(): ReactElement {
  return <AgentStoreContext.Provider value={context}>
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)', overflow: 'auto' }}>
      <div style={{ maxWidth: 850, margin: '0 auto' }}>
        <Cards />
      </div>
    </div>
  </AgentStoreContext.Provider>
}
