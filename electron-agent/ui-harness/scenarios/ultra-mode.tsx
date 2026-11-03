import { useState, type ReactElement } from 'react'
import { App } from 'antd'
import ModeAction from '../../src/features/chat/input/actions/ModeAction'
import { SettingsPanel } from '../../src/features/settings/SettingsPanel'
import { useSessionStore } from '../../src/store/session'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { initialAgentState, type AgentState } from '../../src/stores/agentReducer'
import { sessionControlKey, useModeStore, type AgentMode } from '../../src/stores/modeStore'
import { useSessionPreferencesStore } from '../../src/stores/sessionPreferencesStore'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * Ultra 独立模式：左边是真实 ModeAction，右边是真实 SettingsPanel（SettingField / ModelSelectField / ModelListField）。
 * 主进程全用桩：settings 字典就是落盘状态（get_settings 读、set_settings 整份写回），模型目录两个供应商；
 * agent_set_mode 照 piRuntimeService.writeAgentMode：会话有未确认 Plan 时切 agent / debug / ultra
 * 一律回 { ok:false, blocked:'PLAN_UNCONFIRMED' }，桩里的模式不动。
 *
 * 验证点：Ultra 是互斥的模式选项（带图标文字）；未确认 Plan 不能手切 Ultra；
 * Ultra 设置分组与普通子代理各存各的（互不覆盖、留空不回落普通键），切分类不丢值、重挂载按落盘恢复；浅色主题。
 */

const WS = '/repo'
const SESSION = '/repo/.pi/sessions/ultra.jsonl'
const BLOCK_MESSAGE =
  '当前会话有尚未确认的计划，不能直接切到执行模式。请在右侧计划面板点「确认执行」（会自动切到 Agent 并开跑），或先在面板里取消计划。'
const EXECUTING_MODES = ['agent', 'debug', 'ultra']

const MODELS_JSON = JSON.stringify({
  providers: {
    alpha: { name: 'Alpha', api: 'openai-completions', apiKey: 'k1', models: [{ id: 'fast' }, { id: 'deep' }] },
    beta: { name: 'Beta', api: 'anthropic-messages', apiKey: 'k2', models: [{ id: 'wide' }] },
  },
})

const CATALOG = [
  { provider: 'alpha', id: 'fast', api: 'openai-completions' },
  { provider: 'alpha', id: 'deep', api: 'openai-completions' },
  { provider: 'beta', id: 'wide', api: 'anthropic-messages' },
]

/** 落盘字典：probe 用 act('settings') 读，保存 / 恢复全部走它。 */
let settings: Record<string, string> = {
  SUBAGENT_MODE: 'custom',
  SUBAGENT_MODEL: 'alpha/fast',
}
/** 会话有未确认的计划；手切执行模式被拒。 */
let planUnconfirmed = true
let hostMode = 'plan'
let preferenceRevision = 1
const preferences = () => ({ revision: preferenceRevision, model: { provider: 'alpha', id: 'fast' }, thinkingLevel: 'off', mode: hostMode as AgentMode, approval: 'auto' as const })

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'get_settings':
        return { ...settings }
      case 'agent_get_state':
        return { sessionFile: SESSION, sessionPath: SESSION, model: CATALOG[0], thinkingLevel: 'off', preferences: preferences() }
      case 'agent_get_session_defaults':
        return { revision: 0, mode: 'agent', approval: 'auto', model: { provider: 'alpha', id: 'fast' }, thinkingLevel: 'off' }
      case 'set_settings':
        settings = { ...(args.settings as Record<string, string>) }
        track('settings-save')
        return undefined
      case 'get_provider_config':
        return { modelsJson: MODELS_JSON, authJson: '{}', agentDir: '/agent' }
      case 'agent_get_available_models':
      case 'list_models_global':
        return { models: CATALOG }
      case 'agent_set_mode': {
        const next = String(args.mode)
        track(`set-mode:${next}`)
        if (planUnconfirmed && EXECUTING_MODES.includes(next)) {
          return { ok: false, blocked: 'PLAN_UNCONFIRMED', mode: hostMode, message: BLOCK_MESSAGE }
        }
        hostMode = next
        preferenceRevision++
        useModeStore.getState().setSessionMode(SESSION, next as AgentMode)
        return { ok: true, mode: next, sessionPath: SESSION, preferences: preferences() }
      }
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

exposeData({ blockMessage: BLOCK_MESSAGE, session: SESSION })

useSessionStore.setState({
  worksDir: '/repo',
  activeWorkspace: WS,
  activeSessionPath: SESSION,
  draftConversationCwd: null,
})
useModeStore.setState({ byWorkspace: { [WS]: 'agent' }, bySession: {} })
useModeStore.getState().setSessionMode(SESSION, 'plan')

/** 让 probe 能重挂设置面板（模拟重新打开设置页 / 重启后按落盘恢复）。 */
let remountPanel: () => void = () => {}

exposeActions({
  settings: () => ({ ...settings }),
  mode: () => hostMode,
  sessionMode: () => useModeStore.getState().bySession[sessionControlKey(SESSION)] ?? null,
  /** 模拟侧栏「确认执行」：计划不再未确认，宿主自动切到 Agent。 */
  confirmPlan: () => {
    planUnconfirmed = false
    hostMode = 'agent'
    preferenceRevision++
    useModeStore.getState().setSessionMode(SESSION, 'agent')
    useSessionPreferencesStore.getState().applyServer(SESSION, preferences())
  },
  remount: () => remountPanel(),
})

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

export default function UltraModeScenario(): ReactElement {
  const [epoch, setEpoch] = useState(0)
  // 每次渲染都更新：probe 调用 remount 时用到的就是最新那份。
  remountPanel = () => setEpoch((n) => n + 1)
  return (
    <App>
      <AgentStoreContext.Provider value={STORE_CONTEXT}>
        <div style={{ display: 'flex', height: '100vh', boxSizing: 'border-box', background: 'var(--gren-content-bg)' }}>
          <div style={{ width: 420, flex: '0 0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 13, opacity: 0.7 }}>会话 / 项目模式</div>
            <div
              data-testid="mode-action"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: 8, borderRadius: 12, border: '1px solid rgba(127,127,127,0.3)', width: 'fit-content' }}
            >
              <ModeAction />
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, borderInlineStart: '1px solid rgba(127,127,127,0.2)' }}>
            <SettingsPanel key={epoch} />
          </div>
        </div>
      </AgentStoreContext.Provider>
    </App>
  )
}
