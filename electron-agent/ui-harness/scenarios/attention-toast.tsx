import type { ReactElement } from 'react'
import { App } from 'antd'
import { AttentionHost } from '../../src/features/attention/AttentionHost'
import { registerAttentionOpenHandler } from '../../src/features/attention/openSessionBridge'
import { useSessionStore } from '../../src/store/session'
import { useUiPromptStore } from '../../src/stores/uiPromptStore'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 应用内提示：真实 AttentionHost + sessionAttention + 通知器，外面包 antd App（App.useApp().notification）。
 * 主进程三条命令用桩：attention_notify 固定回 in-app、不放提示音，attention_badge 记下计数，
 * 窗口焦点固定在前台。pi 事件、审批请求由 probe 经 act 推，形状照 runningSessions / uiPromptStore 的真实来源。
 * 事件记成 notify:<种类>:<会话名>、badge:<数>、open:<会话名>。
 */

const WS = 'D:/repo/order-service'
const PATHS = {
  A: 'D:/Users/me/.pi/agent/sessions/order-service/a.jsonl',
  B: 'D:/Users/me/.pi/agent/sessions/order-service/b.jsonl',
} as const
type Name = keyof typeof PATHS
const nameOf = (path: unknown): string =>
  (Object.entries(PATHS).find(([, p]) => p === path)?.[0] as string | undefined) ?? String(path)

type Handler = (e: { payload: unknown }) => void
const handlers = new Map<string, Set<Handler>>()
const emit = (event: string, payload: unknown): void => {
  for (const handler of handlers.get(event) ?? []) handler({ payload })
}

installBridge({
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'attention_window_focused':
        return true
      case 'attention_notify':
        track(`notify:${String(args.kind)}:${nameOf(args.sessionPath)}`)
        return { route: 'in-app', sound: false }
      case 'attention_badge':
        track(`badge:${String(args.count)}`)
        return undefined
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
  subscribe: async (event: string, handler: Handler) => {
    const set = handlers.get(event) ?? new Set<Handler>()
    set.add(handler)
    handlers.set(event, set)
    return () => set.delete(handler)
  },
})

useSessionStore.setState({
  allSessions: [
    { id: 'a', path: PATHS.A, cwd: WS, timestamp: '2026-10-19T08:00:00Z', name: '整理发布脚本' },
    { id: 'b', path: PATHS.B, cwd: WS, timestamp: '2026-10-19T08:05:00Z', name: '重构订单查询栏' },
  ],
  optimisticSessions: [],
  deletedSessionPaths: [],
  activeWorkspace: WS,
  activeSessionPath: PATHS.A,
  workspaceSessionPaths: { [WS]: PATHS.A },
})

registerAttentionOpenHandler((_workspace, path) => {
  track(`open:${nameOf(path)}`)
  useSessionStore.getState().setActiveSession(path)
})

const piEvent = (name: Name, event: Record<string, unknown>): void =>
  emit('pi://event', { workspace: WS, sessionPath: PATHS[name], source: 'interactive', event })
const assistant = (stopReason: string, errorMessage?: string) => ({
  type: 'agent_end',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
    { role: 'assistant', content: [], stopReason, ...(errorMessage ? { errorMessage } : {}) },
  ],
})

exposeData({ titles: { A: '整理发布脚本', B: '重构订单查询栏' } })

exposeActions({
  finish: (name: Name) => {
    piEvent(name, { type: 'agent_start' })
    piEvent(name, assistant('stop'))
    piEvent(name, { type: 'agent_settled' })
  },
  fail: (name: Name, message: string) => {
    piEvent(name, { type: 'agent_start' })
    piEvent(name, assistant('error', message))
  },
  goalRound: (name: Name) => {
    piEvent(name, assistant('stop'))
    piEvent(name, { type: 'agent_settled' })
    setTimeout(() => piEvent(name, { type: 'agent_start' }), 300)
  },
  approve: (name: Name) =>
    useUiPromptStore.getState().setRequest({
      workspace: WS,
      request: { id: `r-${name}`, method: 'confirm', title: '执行 npm publish？' },
      sessionPath: PATHS[name],
    }),
  answer: (name: Name) => useUiPromptStore.getState().clear(WS, `r-${name}`),
  activate: (name: Name) => useSessionStore.getState().setActiveSession(PATHS[name]),
})

export default function AttentionToastScenario(): ReactElement {
  return (
    <App>
      <AttentionHost />
      <div
        data-testid="attention-stage"
        style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)', color: 'var(--gren-text, inherit)' }}
      >
        当前会话：整理发布脚本
      </div>
    </App>
  )
}
