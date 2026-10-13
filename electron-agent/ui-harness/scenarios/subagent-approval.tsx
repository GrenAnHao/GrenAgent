import type { ReactElement } from 'react'
import { App } from 'antd'
import { ExtensionUiHost } from '../../src/features/extensionUi/ExtensionUiHost'
import { PromptRequestCard } from '../../src/features/chat/input/PromptRequestCard'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 子代理审批卡：真实 ExtensionUiHost 收 pi://ui-request 信封、真实 uiPromptStore 排队、真实 PromptRequestCard 渲染。
 * 主进程那头只有两件事用桩：pi://ui-request 推信封（probe 经 act 推，形状照 electron-agent/electron/agent/sessionUiAdapter.ts），
 * extension_ui_respond 记成事件。子代理的请求带 timeout 和 subagents（extensions/_shared/approval-route.ts）。
 */

const WS = '/ws'
const PARENT = '/ws/.pi/sessions/parent.jsonl'

type Handler = (event: { payload: unknown }) => void
const handlers = new Set<Handler>()

function push(request: Record<string, unknown>): void {
  const envelope = { workspace: WS, sessionPath: PARENT, sessionId: 'parent', source: 'interactive', request }
  for (const handler of handlers) handler({ payload: envelope })
}

installBridge({
  invoke: async (command: string, args: { workspace: string; response: { id: string; value?: string; cancelled?: boolean } }) => {
    if (command === 'extension_ui_respond') {
      const { id, value, cancelled } = args.response
      track(`respond:${id}:${cancelled ? 'cancelled' : value}`)
      return undefined
    }
    throw new Error(`unstubbed invoke: ${command}`)
  },
  subscribe: async (event: string, handler: Handler) => {
    if (event === 'pi://ui-request') handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  },
})

const SUBAGENTS: Record<string, Array<{ agentId: string; label: string }>> = {
  'sa-1': [{ agentId: 'sa-1', label: 'run the tests' }],
  'sa-2': [{ agentId: 'sa-2', label: 'clean build output' }],
  // 孙代理：顶层在前
  'sa-3': [
    { agentId: 'sa-2', label: 'clean build output' },
    { agentId: 'sa-3', label: 'remove dist' },
  ],
}

function chainText(chain: Array<{ agentId: string; label: string }>): string {
  return `子代理 ${chain.map((a) => `${a.label}（${a.agentId}）`).join(' › ')} `
}

exposeActions({
  /** 子代理的审批：标题前缀和 subagents 和宿主拼的一样，timeout 默认 60 秒。 */
  childAsk: (id: string, agent: string, command: string, timeout = 60_000) => {
    const chain = SUBAGENTS[agent] ?? []
    push({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title: `${chainText(chain)}请求批准：\n\n  ${command}`,
      options: ['允许本次', '总是允许', '拒绝'],
      timeout,
      subagents: chain,
    })
  },
  /** 主会话自己的审批：没有 timeout，没有 subagents。 */
  mainAsk: (id: string, command: string) => {
    push({ type: 'extension_ui_request', id, method: 'select', title: `请求批准：\n\n  ${command}`, options: ['允许本次', '总是允许', '拒绝'] })
  },
  /** 宿主不再等这条请求（超时、撤回）。 */
  dismiss: (id: string) => {
    push({ type: 'extension_ui_request', id, method: 'dismiss' })
  },
})

exposeData({ workspace: WS })

const STORE_CONTEXT = {
  workspace: WS,
  store: undefined as never,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}

export default function SubagentApprovalScenario(): ReactElement {
  return (
    <App>
      <AgentStoreContext.Provider value={STORE_CONTEXT}>
        <ExtensionUiHost />
        <div
          style={{
            height: '100vh',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            alignItems: 'center',
            padding: 24,
            background: 'var(--gren-content-bg)',
          }}
        >
          {/* 和输入框同宽：卡片在输入框上方 */}
          <div style={{ width: 720 }}>
            <PromptRequestCard />
            <div
              data-testid="fake-composer"
              style={{ height: 96, borderRadius: 12, border: '1px solid var(--gren-border, #8884)', opacity: 0.6 }}
            />
          </div>
        </div>
      </AgentStoreContext.Provider>
    </App>
  )
}
