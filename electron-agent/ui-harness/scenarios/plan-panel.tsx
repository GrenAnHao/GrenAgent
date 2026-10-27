import { useLayoutEffect, useRef, type ReactElement } from 'react'
import { App } from 'antd'
import { create } from 'zustand'
import { ExtensionUiHost } from '../../src/features/extensionUi/ExtensionUiHost'
import { DockDndProvider } from '../../src/features/dock/DockDndProvider'
import { DockPanel } from '../../src/features/dock/DockPanel'
import { RightPanelShell } from '../../src/features/layout/PanelShells'
import { PlanSummaryCard } from '../../src/features/plan/PlanSummaryCard'
import ModeAction from '../../src/features/chat/input/actions/ModeAction'
import { useSessionStore } from '../../src/store/session'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { initialAgentState, type AgentState } from '../../src/stores/agentReducer'
import { useDockStore } from '../../src/stores/dockStore'
import { useLayoutStore } from '../../src/stores/layoutStore'
import { useModeStore } from '../../src/stores/modeStore'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * Plan 侧栏：真实 ExtensionUiHost 收 setStatus('agent-plan') → 真实 planStore → 真实 openPlanDockTab 开右栏标签 →
 * 真实 DockPanel / PlanPanel 渲染；对话流里是真实 PlanSummaryCard，输入栏是真实 ModeAction。
 * 主进程 / agent-mode 扩展那头用桩：agent_prompt 收面板发的 /plan-update /plan-confirm /plan-cancel /plan-finish，
 * 按 extensions/agent-mode/index.ts 的规则改桩里的计划，再按扩展的形状推 setStatus / notify；
 * agent_set_mode 照 piRuntimeService.writeAgentMode：有未确认计划时切 agent 回 { ok: false, blocked: 'PLAN_UNCONFIRMED' }。
 */

const WS = '/repo'
const SESSION = '/repo/.pi/sessions/plan.jsonl'
const LONG_STEP =
  '在 src/middleware/auth.ts 新建 requireAuth 中间件，统一 401 / 403 的错误体；所有 /api 路由改经它校验 session，并删掉各路由里的内联校验，避免双重校验和不一致的报错文案'
const BLOCK_MESSAGE =
  '当前会话有尚未确认的计划，不能直接切到执行模式。请在右侧计划面板点「确认执行」（会自动切到 Agent 并开跑），或先在面板里取消计划。'

type Status = 'drafting' | 'ready' | 'confirmed' | 'executing' | 'done' | 'cancelled'
interface Step { text: string; done: boolean }
interface Plan {
  id: string; title: string; goal: string; steps: Step[]; risks: string[]
  status: Status; rev: number; createdAt: number; updatedAt: number; updatedBy: 'model' | 'user'; file: string
}

type Handler = (event: { payload: unknown }) => void
const handlers = new Set<Handler>()
let seq = 0
let plan: Plan | null = null
let mode = 'plan'

function emit(request: Record<string, unknown>): void {
  const envelope = { workspace: WS, sessionPath: SESSION, sessionId: 'plan-session', source: 'interactive', request: { type: 'extension_ui_request', id: `r${++seq}`, ...request } }
  for (const handler of handlers) handler({ payload: envelope })
}
const pushPlan = (reason: 'created' | 'updated' | 'sync') => emit({ method: 'setStatus', statusKey: 'agent-plan', statusText: JSON.stringify({ plan, reason }) })
const pushMode = () => emit({ method: 'setStatus', statusKey: 'agent-mode', statusText: mode })
const notify = (message: string, level = 'info') => emit({ method: 'notify', message, level })
const unconfirmed = () => plan?.status === 'drafting' || plan?.status === 'ready'

/** 对话流：只放摘要卡（扩展每份计划发一张 `[plan:<id>] …`）。 */
const useChat = create<{ cards: string[] }>(() => ({ cards: [] }))

function makePlan(id: string, title: string, steps: string[]): Plan {
  return {
    id, title, goal: '统一鉴权错误处理，所有 /api 路由经同一个中间件校验', risks: ['路由遗漏导致未鉴权'],
    steps: steps.map((text) => ({ text, done: false })),
    status: steps.length > 0 ? 'ready' : 'drafting', rev: 1, createdAt: 1, updatedAt: 1, updatedBy: 'model', file: `.pi/plans/${id}.md`,
  }
}

function runCommand(line: string): void {
  const space = line.indexOf(' ')
  const name = line.slice(1, space === -1 ? undefined : space)
  const args = space === -1 ? '' : line.slice(space + 1)
  track(`cmd:${name}`)
  if (name === 'plan-update') {
    const raw = JSON.parse(args) as { planId: string; rev: number; title: string; goal: string; steps: Step[]; risks: string[] }
    track(`update:${JSON.stringify(raw)}`)
    if (!plan || raw.planId !== plan.id || !unconfirmed()) return notify('找不到这份计划（可能已被新的计划取代）。', 'warning')
    if (raw.rev !== plan.rev) return notify(`计划已更新到第 ${plan.rev} 版，请载入最新版本后再改。`, 'warning')
    plan = { ...plan, title: raw.title, goal: raw.goal, steps: raw.steps, risks: raw.risks, rev: plan.rev + 1, updatedBy: 'user', status: raw.steps.length ? 'ready' : 'drafting' }
    pushPlan('updated')
    return notify(`计划已保存（第 ${plan.rev} 版）。`)
  }
  const [id, rev] = args.split(/\s+/)
  if (!plan || plan.id !== id) return notify('找不到这份计划（可能已被新的计划取代）。', 'warning')
  if (name === 'plan-confirm') {
    track(`confirm:${id}:${rev}`)
    if (plan.status !== 'ready' || Number(rev) !== plan.rev) return notify('计划不能确认执行。', 'warning')
    plan = { ...plan, status: 'executing' }
    mode = 'agent'
    pushPlan('updated')
    pushMode()
    return notify('计划已确认，切到 Agent 模式开始执行。')
  }
  if (name === 'plan-cancel') {
    plan = { ...plan, status: 'cancelled' }
    pushPlan('updated')
    return notify('计划已取消。')
  }
  if (name === 'plan-finish') {
    plan = { ...plan, status: 'done' }
    pushPlan('updated')
    return notify('计划已标记完成。')
  }
}

installBridge({
  subscribe: async (event: string, handler: Handler) => {
    if (event === 'pi://ui-request') handlers.add(handler)
    return () => handlers.delete(handler)
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === 'agent_prompt') {
      track(`prompt-target:${String(args.targetSessionPath ?? '')}`)
      runCommand(String(args.message ?? ''))
      return undefined
    }
    if (command === 'agent_set_mode') {
      const next = String(args.mode)
      track(`set-mode:${next}`)
      if (unconfirmed() && (next === 'agent' || next === 'debug' || next === 'brainstorm')) {
        return { ok: false, blocked: 'PLAN_UNCONFIRMED', mode, message: BLOCK_MESSAGE }
      }
      mode = next
      return { ok: true, mode }
    }
    track(`unstubbed:${command}`)
    return undefined
  },
})

exposeActions({
  /** 模型第一次 upsert_plan：扩展推 created 快照并在对话流发一张摘要卡。 */
  created: (id: string, title: string) => {
    plan = makePlan(id, title, ['梳理现有 /api 路由的鉴权写法', LONG_STEP, '补集成测试：未登录 401、无权限 403'])
    useChat.setState((s) => ({ cards: [...s.cards, `[plan:${id}] 已生成计划「${title}」，在右侧计划面板审阅、修改并确认执行。`] }))
    pushPlan('created')
  },
  /** 模型同 id 修订（用户正在改的时候）。 */
  modelRevise: () => {
    if (!plan) return
    plan = { ...plan, title: `${plan.title}（模型修订）`, rev: plan.rev + 1, updatedBy: 'model' }
    pushPlan('updated')
  },
  /** 执行中助手正文写了 [DONE:n]。 */
  doneStep: (n: number) => {
    if (!plan) return
    plan = { ...plan, steps: plan.steps.map((s, i) => (i === n - 1 ? { ...s, done: true } : s)) }
    pushPlan('updated')
  },
  plan: () => plan,
  mode: () => mode,
})

exposeData({ longStep: LONG_STEP, blockMessage: BLOCK_MESSAGE, session: SESSION })

useSessionStore.setState({ worksDir: '/works', activeWorkspace: WS, activeSessionPath: SESSION, draftConversationCwd: null })
useModeStore.setState({ byWorkspace: { [WS]: 'plan' }, bySession: {} })
useModeStore.getState().setSessionMode(SESSION, 'plan')
useDockStore.setState({
  tabs: [],
  closedTabs: [],
  activeByRegion: { right: null, bottom: null },
  activeBySession: {},
  rightOpenBySession: {},
  rightFillBySession: {},
})
useLayoutStore.setState({ rightPanelOpen: false, rightPanelFill: false, rightPanelWidth: 520, sidebarOpen: false })

const STORE_CONTEXT = {
  workspace: WS,
  store: {
    useStore: (selector: (value: AgentState) => unknown) => selector(initialAgentState()),
    getLoadedSessionPath: () => SESSION,
  } as unknown as AgentStoreApi,
  workspaceReady: true,
  setWorkspaceReady: () => {},
  appBooted: true,
}

function Chat(): ReactElement {
  const cards = useChat((s) => s.cards)
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
      <div data-testid="chat" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {cards.map((c) => (
          <PlanSummaryCard content={c} key={c} />
        ))}
      </div>
      <div data-testid="composer" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, borderRadius: 12, border: '1px solid rgba(127,127,127,0.3)' }}>
        <span data-testid="mode-action">
          <ModeAction />
        </span>
      </div>
    </div>
  )
}

export default function PlanPanelScenario(): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null)
  const setAvailableWidth = useLayoutStore((s) => s.setAvailableWidth)
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel)

  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    const update = () => setAvailableWidth(el.getBoundingClientRect().width)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [setAvailableWidth])

  return (
    <App>
      <AgentStoreContext.Provider value={STORE_CONTEXT}>
        <ExtensionUiHost />
        <div ref={rowRef} style={{ display: 'flex', height: '100vh', background: 'var(--gren-content-bg)' }}>
          <DockDndProvider>
            <Chat />
            <RightPanelShell>
              <div data-testid="right-host" style={{ height: '100%' }}>
                <DockPanel region="right" onCollapse={toggleRightPanel} />
              </div>
            </RightPanelShell>
          </DockDndProvider>
        </div>
      </AgentStoreContext.Provider>
    </App>
  )
}
