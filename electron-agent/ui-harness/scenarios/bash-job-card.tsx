import { useState, type ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { applyEvent, initialAgentState, messagesFromAgent, type AgentState, type ChatMessage } from '../../src/stores/agentReducer'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { TurnTimeline } from '../../src/features/chat/TurnTimeline'
import {
  DONE_JOB,
  DONE_OUTPUT,
  DESCRIPTION,
  FOREGROUND_GONE,
  FOREGROUND_JOB,
  GONE_JOB,
  LIVE_JOB,
  LIVE_OUTPUT,
  SANDBOX_JOB,
  SANDBOX_JOB_DETAIL,
  SANDBOX_JOB_OUTPUT,
  deniedEvents,
  escalatedEvents,
  foregroundEndEvent,
  foregroundRunningEvents,
  historyMessages,
  liveEvents,
  type JobKey
} from '../bashJobFixtures'
import { exposeActions, exposeData, installBridge, track } from '../stubs'
import type { AgentEvent } from '../../src/lib/pi'

/**
 * 后台 bash 卡片：走真实 reducer → groupMessages → TurnTimeline，
 * 主进程那头（job_snapshot / job_kill / pi://jobs 帧）用桩替代，由 probe 驱动。
 * 实时（注册表里在跑）、历史回放（注册表里已结束）、任务已不在、前台匿名 job，
 * 以及沙箱事实：前台被拒、已升权、后台任务被拒。
 */

type Handler = (event: { payload: unknown }) => void
type Status = 'running' | 'stopping' | 'completed' | 'killed'

interface FakeJob {
  view: {
    id: string
    kind: string
    label: string
    owner: string
    workspace: string
    status: Status
    detail?: string
    startedAt: number
    finishedAt?: number
  }
  text: string
}

const encoder = new TextEncoder()
const registry = new Map<string, FakeJob>()
const handlers = new Set<Handler>()

function register(job: JobKey, status: Status, text: string, detail?: string, durationMs?: number): void {
  registry.set(job.jobId, {
    view: {
      id: job.jobId,
      kind: 'bash',
      label: DESCRIPTION,
      owner: 'ui-harness',
      workspace: 'ui-harness',
      status,
      ...(detail ? { detail } : {}),
      startedAt: job.jobStartedAt,
      ...(durationMs != null ? { finishedAt: job.jobStartedAt + durationMs } : {})
    },
    text
  })
}

register(LIVE_JOB, 'running', LIVE_OUTPUT)
// 运行中的前台命令：匿名 job，模型没拿到它的 id。
register(FOREGROUND_JOB, 'running', 'PASS a.test.ts\n')
// FOREGROUND_GONE 故意不登记：界面拿不到快照，回退到 partial 文本。
register(DONE_JOB, 'completed', DONE_OUTPUT, 'exit code: 0', 520_000)
// 后台任务被沙箱拒绝：非零退出，detail 里是写给模型的标记。
register(SANDBOX_JOB, 'completed', SANDBOX_JOB_OUTPUT, SANDBOX_JOB_DETAIL, 4_000)
// GONE_JOB 故意不登记：job_snapshot 返回 null。

function emit(frames: unknown[]): void {
  for (const handler of handlers) handler({ payload: { frames } })
}

installBridge({
  invoke: async (command: string, args: { jobId: string; startedAt: number }) => {
    if (command === 'job_snapshot') {
      const entry = registry.get(args.jobId)
      if (!entry || entry.view.startedAt !== args.startedAt) return null
      return { job: entry.view, text: entry.text, next: encoder.encode(entry.text).length, lossy: false }
    }
    if (command === 'job_kill') {
      const entry = registry.get(args.jobId)
      if (!entry) return 'not-found'
      track(`kill:${args.jobId}`)
      entry.view = { ...entry.view, status: 'stopping' }
      emit([{ job: entry.view }])
      return 'requested'
    }
    throw new Error(`unstubbed invoke: ${command}`)
  },
  subscribe: async (event: string, handler: Handler) => {
    if (event === 'pi://jobs') handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  }
})

exposeData({
  cases: ['live', 'history', 'gone', 'foreground', 'foreground-gone', 'denied', 'escalated', 'job-denied'],
  live: LIVE_JOB.jobId,
  done: DONE_JOB.jobId,
  gone: GONE_JOB.jobId,
  foreground: FOREGROUND_JOB.jobId,
  foregroundGone: FOREGROUND_GONE.jobId,
  sandboxJob: SANDBOX_JOB.jobId
})

// 前台命令结束：在原状态上应用 tool_execution_end，同一条消息 id 保持不变（真实应用里也是按 toolCallId 更新），
// 卡片不重新挂载，组件观察运行 → 结束后自动收起。由 probe 经 act 驱动。
const foregroundListeners = new Set<() => void>()
const foregroundStates = new Map<string, AgentState>()
const CALL_IDS: Record<string, string> = { foreground: 'call-fg', 'foreground-gone': 'call-fg-gone' }
function endForeground(caseId: string, finalText: string): void {
  const state = foregroundStates.get(caseId)
  if (!state) return
  foregroundStates.set(caseId, applyEvent(state, foregroundEndEvent(CALL_IDS[caseId], finalText)))
  for (const listener of foregroundListeners) listener()
}

exposeActions({
  pushOutput: (jobId: string, text: string) => {
    const entry = registry.get(jobId)
    if (!entry) return
    const from = encoder.encode(entry.text).length
    entry.text += text
    emit([{ job: entry.view, delta: { from, text, next: encoder.encode(entry.text).length, lossy: false } }])
  },
  /** 前台命令结束：工具结果落地（匿名，不带 job 引用），注册表里的记录随调用离开。 */
  endForeground: (jobId: string, finalText: string) => {
    registry.delete(jobId)
    endForeground(jobId === FOREGROUND_JOB.jobId ? 'foreground' : 'foreground-gone', finalText)
  },
  finish: (jobId: string, detail: string) => {
    const entry = registry.get(jobId)
    if (!entry) return
    // 跑了 900 秒：行上的时长定格在 15m。
    entry.view = { ...entry.view, status: 'completed', detail, finishedAt: entry.view.startedAt + 900_000 }
    emit([{ job: entry.view }])
  }
} as never)

const mockCtx = {
  workspace: 'ui-harness',
  store: {} as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true
}

function replayState(events: AgentEvent[]): AgentState {
  return events.reduce((state, event) => applyEvent(state, event), initialAgentState())
}

function replay(events: AgentEvent[]): ChatMessage[] {
  return replayState(events).messages
}

foregroundStates.set('foreground', replayState(foregroundRunningEvents('call-fg', FOREGROUND_JOB, 'PASS a.test.ts\n')))
foregroundStates.set('foreground-gone', replayState(foregroundRunningEvents('call-fg-gone', FOREGROUND_GONE, 'still running\n')))

const CASES: { id: string; title: string; messages: ChatMessage[] }[] = [
  { id: 'live', title: '实时 · 注册表里在跑', messages: replay(liveEvents('call-live', LIVE_JOB)) },
  { id: 'history', title: '历史回放 · 注册表里已结束', messages: messagesFromAgent(historyMessages('call-done', DONE_JOB)) },
  { id: 'gone', title: '实时 · 任务已不在', messages: replay(liveEvents('call-gone', GONE_JOB)) },
  { id: 'foreground', title: '前台 · 运行中（匿名 job）', messages: [] },
  { id: 'foreground-gone', title: '前台 · 运行中（找不到 job，回退 partial）', messages: [] },
  { id: 'denied', title: '前台 · 沙箱拒绝', messages: replay(deniedEvents('call-denied')) },
  { id: 'escalated', title: '前台 · 已升权', messages: replay(escalatedEvents('call-escalated')) },
  { id: 'job-denied', title: '后台 · 沙箱拒绝', messages: replay(liveEvents('call-job-denied', SANDBOX_JOB)) }
]

/** 前台两个 case 的消息取自它们当前的状态（结束后是同一条消息被更新）。 */
function messagesFor(c: { id: string; messages: ChatMessage[] }): ChatMessage[] {
  return foregroundStates.get(c.id)?.messages ?? c.messages
}

function Turns({ messages }: { messages: ChatMessage[] }): ReactElement {
  return (
    <>
      {groupMessages(messages).map((item) =>
        item.kind === 'turn' ? <TurnTimeline key={item.id} segments={item.segments} /> : null
      )}
    </>
  )
}

export default function BashJobCard(): ReactElement {
  const [, bump] = useState(0)
  useState(() => {
    foregroundListeners.add(() => bump((n) => n + 1))
    return null
  })
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
              <Turns messages={messagesFor(c)} />
            </section>
          ))}
        </div>
      </div>
    </AgentStoreContext.Provider>
  )
}
