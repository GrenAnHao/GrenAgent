import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { SubAgentCard } from '../../src/features/subagents/SubAgentCard'
import { SubAgentMenuButton } from '../../src/features/subagents/SubAgentMenuButton'
import { SubAgentLogBody } from '../../src/features/dock/SubAgentLogBody'
import { selectSubAgentById, selectSubAgentObservation, useSubAgentLiveStore } from '../../src/stores/subagentLiveStore'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { initialAgentState, messagesFromAgent } from '../../src/stores/agentReducer'
import type { AgentMessage, SubAgentItem } from '../../src/lib/pi'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { computeSubAgentUnits } from '../../src/features/chat/messagePrecompute'
import { renderMessageBody } from '../../src/features/chat/ChatMessageItems'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 前台 run 等待时用户发话，还没完成的子代理转到后台（extensions/multi-agent/detach.ts）后，对话里的卡片。
 * 一次单任务 run 和一次并行 run 的工具结果，形状照 spawn_agent 转后台的回执。并行那次八项：
 * - 快任务：转后台前已完成；
 * - 慢任务：转后台，注册表里在跑；
 * - 晚到的任务：转后台，卡片第一次读注册表时它还没建出来（run 一开始就转后台、下一次轮询还没到），之后才出现；
 * - 暂无记录的任务：多次缺行并穿插一次 SQLITE_BUSY，仍不能臆断中断；
 * - 排队的任务：没有 agentId 时按父工具子项位置留占位，probe 后经结果更新赋予稳定 id。
 * subagent_list 用桩，probe 经 act 把它们在注册表里改成已完成，卡片要跟着轮询变成终态。
 */

// 固定基准 + 单调经过时间：真实计时仍推进，截图不会把 Unix 起点当成启动时间。
const FIXTURE_NOW = Date.UTC(2026, 10, 17, 14, 0, 0)
const clockStart = performance.now()
Date.now = () => FIXTURE_NOW + Math.floor(performance.now() - clockStart)
const started = (order: number) => FIXTURE_NOW - 20_000 + order * 1000

const rows = new Map<string, SubAgentItem>([
  ['sa-single', { id: 'sa-single', task: '写出 1 到 400', status: 'running', model: 'p/model-a', createdAt: started(1), updatedAt: started(1) }],
  ['sa-fast', { id: 'sa-fast', task: '快任务', status: 'done', model: 'p/model-a', createdAt: started(2), updatedAt: started(2) }],
  ['sa-slow', { id: 'sa-slow', task: '慢任务', status: 'running', model: 'p/model-a', createdAt: started(3), updatedAt: started(3) }],
  ['sa-flaky', { id: 'sa-flaky', task: '先登记后失联', status: 'running', model: 'p/model-a', createdAt: started(6), updatedAt: started(6) }],
  ['sa-cancelled', { id: 'sa-cancelled', task: '用户停止的任务', status: 'cancelled', model: 'p/model-a', createdAt: started(7), updatedAt: started(7) }],
  ['sa-interrupted', { id: 'sa-interrupted', task: '会话中断的任务', status: 'done', error: 'sidecar restarted', model: 'p/model-a', createdAt: started(8), updatedAt: started(8) }],
])
// 第一次读之后才建出来的行。
const late: SubAgentItem = { id: 'sa-late', task: '晚到的任务', status: 'running', model: 'p/model-a', createdAt: started(4), updatedAt: started(4) }
let reads = 0
let missingReads = 0
let flakyReads = 0
let flakyRecovered = false
let overflowEnabled = false
let mountOverflow: () => void = () => {}
let assignQueued: () => void = () => {}

installBridge({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    if (command === 'get_provider_config') return { modelsJson: JSON.stringify({ providers: { p: { name: '中转站' } } }), authJson: null }
    if (command === 'subagent_list') {
      track('registry-list')
      const snapshot = [...rows.values()]
      reads += 1
      if (reads === 1) rows.set(late.id, late)
      return overflowEnabled ? snapshot.filter((row) => row.id !== 'sa-overflow').slice(0, 50) : snapshot
    }
    if (command === 'subagent_lookup') {
      const id = String(args?.agentId)
      track(`registry-lookup:${id}`)
      if (args?.parentSessionPath !== '/s/parent.jsonl') return { kind: 'not-found' }
      if (id === 'sa-flaky' && !flakyRecovered && ++flakyReads > 1) {
        if (flakyReads === 3) throw new Error('SQLITE_BUSY')
        return { kind: 'not-found' }
      }
      if (id === 'sa-gone') {
        missingReads += 1
        if (missingReads === 2) throw new Error('SQLITE_BUSY')
      }
      const item = rows.get(id)
      return item ? { kind: 'found', item } : { kind: 'not-found' }
    }
    if (command === 'subagent_get_transcript') return null
    if (command === 'subagent_get_session_messages') return { messages: [] }
    throw new Error(`unexpected command: ${command}`)
  },
})

exposeActions({
  finish: (id: string, status: 'done' | 'error' = 'done') => {
    const row = rows.get(id)
    if (row) rows.set(id, { ...row, status, updatedAt: row.updatedAt + 10 })
  },
  assignQueued: () => assignQueued(),
  recoverFlaky: () => {
    flakyRecovered = true
    const row = rows.get('sa-flaky')!
    rows.set(row.id, { ...row, status: 'done', updatedAt: row.updatedAt + 10 })
  },
  enableOverflow: () => {
    overflowEnabled = true
    for (let i = 0; i < 60; i++) rows.set(`overflow-${i}`, {
      id: `overflow-${i}`, task: `批量任务 ${i}`, status: 'running', model: 'p/model-a', createdAt: FIXTURE_NOW - 120_000 + i * 1000, updatedAt: FIXTURE_NOW - 120_000 + i * 1000,
    })
    rows.set('sa-overflow', { id: 'sa-overflow', task: '第51行按ID确认', status: 'done', model: 'p/model-a', createdAt: started(5), updatedAt: FIXTURE_NOW + 1000 })
    mountOverflow()
  },
  add: (id: string, task: string) => {
    rows.set(id, { id, task, status: 'running', model: 'p/model-a', createdAt: started(5), updatedAt: started(5) })
  },
  bashWaiting: () => {
    const row = rows.get('sa-single')!
    rows.set(row.id, { ...row, output: '完整的最终回复。', bashState: { phase: 'waiting-for-bash' } })
  },
  // 运行期观察到首个正文/思考/工具活动：登记行写 responseStarted，最终 output 仍未落盘。
  firstActivity: (id: string) => {
    const row = rows.get(id)
    if (row) rows.set(id, { ...row, responseStarted: 1, updatedAt: row.updatedAt + 5 })
  },
  bashTimeout: () => {
    const row = rows.get('sa-single')!
    rows.set(row.id, { ...row, status: 'error', bashState: {
      reason: 'background-bash-timeout', replyCompleted: true,
      jobs: [{ id: 'bash-2', label: '扫描项目', stopConfirmed: false }],
    } })
  },
})
// 连续观察 DOM：早期旧空快照只闪一下也属于回归。
const watch = { flashedTerminal: false }
new MutationObserver(() => {
  const rows = document.querySelectorAll('[data-testid="subagent-group"] [data-testid^="subagent-group-row-"]')
  for (const index of [2, 3, 4, 5]) {
    if (rows[index]?.textContent?.match(/已中断|出错|已完成/)) watch.flashedTerminal = true
  }
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
      { title: '先登记后失联', task: '先登记后失联' },
      { title: '用户停止的任务', task: '用户停止的任务' },
      { title: '会话中断的任务', task: '会话中断的任务' },
    ] } },
  ] },
  { role: 'toolResult', toolCallId: 'run-group', toolName: 'spawn_agent', content: [{ type: 'text', text:
    'A new message arrived while this run was waiting, so 7 unfinished sub-agent(s) moved to the background and keep running.' }],
    details: { mode: 'parallel', detached: true, count: 8, failed: 0, results: [
      { task: '快任务', ok: true, output: '快任务结果', agentId: 'sa-fast', sessionPath: '/s/sa-fast.jsonl', model: 'p/model-a' },
      { task: '慢任务', status: 'running', detached: true, agentId: 'sa-slow', sessionPath: '/s/sa-slow.jsonl', model: 'p/model-a' },
      { task: '晚到的任务', status: 'running', detached: true, agentId: 'sa-late', model: 'p/model-a' },
      { task: '丢失的任务', status: 'running', detached: true, agentId: 'sa-gone', model: 'p/model-a' },
      { task: '排队的任务', status: 'running', detached: true, model: 'p/model-a' },
      { task: '先登记后失联', status: 'running', detached: true, agentId: 'sa-flaky', model: 'p/model-a' },
      { task: '用户停止的任务', status: 'running', detached: true, agentId: 'sa-cancelled', model: 'p/model-a' },
      { task: '会话中断的任务', status: 'running', detached: true, agentId: 'sa-interrupted', model: 'p/model-a' },
    ] } },
] as unknown as AgentMessage[]

const agentState = initialAgentState()
const useStore = Object.assign((selector: (state: typeof agentState) => unknown) => selector(agentState), {
  getState: () => agentState,
  subscribe: () => () => {},
})
const context = {
  workspace: 'ui-harness-subagent-detached',
  store: { getLoadedSessionPath: () => '/s/parent.jsonl', useStore } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}

function Cards(): ReactElement {
  const [revision, setRevision] = useState(0)
  assignQueued = () => {
    const results = (history[3] as unknown as { details: { results: Array<{ agentId?: string }> } }).details.results
    results[4]!.agentId = 'sa-queued'
    setRevision((v) => v + 1)
  }
  const display = useMemo(() => groupMessages(messagesFromAgent(history)), [revision])
  const index = useMemo(() => computeSubAgentUnits(display), [display])
  return <div id="detached-cards">
    {display.map((message) => <div key={message.id} style={{ marginBottom: 12 }}>
      {renderMessageBody(message, index.unitsByMessage, new Set())}
    </div>)}
  </div>
}

function OverflowObserver() {
  const observation = useSubAgentLiveStore(selectSubAgentObservation(context.workspace, '/s/parent.jsonl', 'sa-overflow'))
  const watch = useSubAgentLiveStore((s) => s.watch)
  useEffect(() => {
    if (!overflowEnabled || observation.item?.status === 'done') return
    return watch(context.workspace, '/s/parent.jsonl', 'sa-overflow')
  }, [observation.item?.status, watch])
  return null
}

function ListCard() {
  const item = useSubAgentLiveStore(selectSubAgentById(context.workspace, 'sa-single'))
  return item ? <SubAgentCard item={item} onOpen={() => {}} onStop={() => {}} /> : null
}

export default function SubagentDetached(): ReactElement {
  const [, setOverflowRevision] = useState(0)
  mountOverflow = () => setOverflowRevision((v) => v + 1)
  return <AgentStoreContext.Provider value={context}>
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)', overflow: 'auto' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gridTemplateColumns: 'minmax(0, 850px) 320px', gap: 20 }}>
        <div><Cards /><ListCard />{overflowEnabled ? <><OverflowObserver /><SubAgentMenuButton /></> : null}</div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: 360 }} data-testid="detached-dock-detail">
          <SubAgentLogBody active tab={{ id: 'missing-detail', kind: 'subagentLog', region: 'right', order: 0,
            title: '暂无记录的任务', closable: true, ownerSessionPath: '/s/parent.jsonl',
            payload: { agentId: 'sa-gone', task: '丢失的任务', status: 'running' } } as never} />
          <div data-testid="terminal-dock-detail" style={{ display: 'flex', flexDirection: 'column', height: 140 }}>
            <SubAgentLogBody active tab={{ id: 'terminal-detail', kind: 'subagentLog', region: 'right', order: 1,
              title: '已完成任务', closable: true, ownerSessionPath: '/s/parent.jsonl',
              payload: { agentId: 'sa-slow', task: '完成回执', status: 'done', output: '已完成回执' } } as never} />
          </div>
        </div>
      </div>
    </div>
  </AgentStoreContext.Provider>
}
