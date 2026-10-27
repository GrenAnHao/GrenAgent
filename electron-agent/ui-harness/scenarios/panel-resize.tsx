import { useMemo, useState, type ReactElement } from 'react'
import { App } from 'antd'
import { ResizeHandle } from '../../src/components/ResizeHandle'
import { ChatMessageItems } from '../../src/features/chat/ChatMessageItems'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { FileTreeBody } from '../../src/features/dock/FileTreeBody'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { applyEvent, initialAgentState, type AgentState } from '../../src/stores/agentReducer'
import type { AgentEvent } from '../../src/lib/pi'
import { exposeActions, exposeData, installBridge } from '../stubs'

/**
 * 拖动对话区和右侧面板之间的分隔条：左边真实对话（ChatMessageItems，长 markdown），
 * 右边真实 ResizeHandle + FileTreeBody，打开一篇长 markdown 预览。
 */

localStorage.removeItem('hermes-file-explorer-tree-width')
localStorage.removeItem('hermes-file-explorer-tree-collapsed')

const ROOT = '/repo'
const TAB_ID = `file:right:${ROOT}`
const DOC_SECTIONS = 40

function section(i: number): string {
  return [
    `## ${i + 1}. 模块 ${i + 1}`,
    '',
    `第 ${i + 1} 节说明：服务端负责鉴权、会话保持和限流，客户端只做展示和本地缓存。下面的表格列出各通道的协议、权威文档和落盘位置，代码块是一段典型调用。`,
    '',
    '- `apps/center`：Vite + React 运营管理端；旧 `apps/admin-web` 已被替换。',
    '- `napi`：Rust N-API 工作台凭据采集模块；桌面端接入尚未完成。',
    '- PostgreSQL 持久化业务事实；Redis 承担在线会话、限流、Nonce、租约。',
    '',
    '| 链路 | 通道 | 权威文档 |',
    '| --- | --- | --- |',
    '| desktop ↔ server | `wss://<host>:8443`，Engine.IO path `/socket/client` | 客户端接口面 |',
    '| center ↔ server | `/api/admin/*` HTTPS REST + `/api/admin/realtime` 原生 WS | 管理端接口面 |',
    '| desktop ↔ 拼多多 | 客户端直连，不经服务端 | 总体架构 |',
    '',
    '```ts',
    `export function handshake${i}(token: string): Promise<Session> {`,
    '  return client.post("/api/session", { token, nonce: crypto.randomUUID() })',
    '}',
    '```',
    '',
  ].join('\n')
}
const DOC = ['# 设计说明', '', ...Array.from({ length: DOC_SECTIONS }, (_, i) => section(i))].join('\n')

type Node = { dir: true } | { dir: false; content: string }
const fs = new Map<string, Node>()
fs.set(ROOT, { dir: true })
fs.set(`${ROOT}/docs`, { dir: true })
for (let i = 0; i < 8; i++) fs.set(`${ROOT}/src-${String(i).padStart(2, '0')}`, { dir: true })
fs.set(`${ROOT}/design.md`, { dir: false, content: DOC })
for (let i = 0; i < 20; i++) fs.set(`${ROOT}/file-${String(i).padStart(2, '0')}.ts`, { dir: false, content: `export const n = ${i}\n` })

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'list_dir': {
        const target = String(args.dir ?? '') || ROOT
        const entries = [...fs.entries()]
          .filter(([path]) => parentOf(path) === target && path !== target)
          .map(([path, node]) => ({
            name: nameOf(path),
            path,
            isDir: node.dir,
            size: node.dir ? null : new TextEncoder().encode(node.content).length,
          }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
        return { dir: target, entries, truncated: false }
      }
      case 'read_file_view': {
        const node = fs.get(String(args.path))
        if (!node || node.dir) throw new Error('File does not exist')
        return { kind: 'text', content: node.content, size: new TextEncoder().encode(node.content).length, truncated: false }
      }
      case 'watch_workspace_dirs':
      case 'unwatch_workspace_dirs':
        return undefined
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

// 对话：几轮助手长回复（标题、列表、代码块、表格），和截图里那种长会话差不多。
const CHUNKS = [
  '## 检查结果\n\n先看一下模块边界，下面逐条说明。\n\n',
  '- 第一项：入口文件负责装配，**不做**业务判断；\n- 第二项：状态都放在 store 里；\n- 第三项：渲染层只读快照。\n\n',
  "```ts\nexport function plan(input: string): string[] {\n  const steps = input.split(',')\n  return steps.filter(Boolean).map((s) => s.trim())\n}\n```\n\n",
  '| 模块 | 行数 | 结论 |\n| --- | --- | --- |\n| core | 420 | 保留 |\n| ui | 1280 | 拆分 |\n| io | 96 | 合并 |\n\n',
  '接下来继续核对每个调用点，确认没有遗漏的副作用，再把结论汇总成一张表。服务端新加的测试覆盖了接口次数的累加（重复上报的那次不算），趋势能当天的值，峰值保留最大值。\n\n',
]
const chatEvents: AgentEvent[] = Array.from({ length: 12 }, (_, i) => [
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: `### 第 ${i + 1} 轮\n\n${CHUNKS.join('').repeat(2)}` }] },
  },
]).flat() as AgentEvent[]
const chatState: AgentState = chatEvents.reduce(applyEvent, initialAgentState())
const mockCtx = {
  workspace: '',
  store: { useStore: (selector: (value: AgentState) => unknown) => selector(initialAgentState()) } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}

let setShow: (show: { chat: boolean; explorer: boolean }) => void = () => {}
let setExpand: (expand: boolean) => void = () => {}

exposeActions({
  /** 分别关掉左边对话 / 右边文件浏览器，量开销落在哪一侧。 */
  show: (chat: boolean, explorer: boolean) => setShow({ chat, explorer }),
  /** 折叠 / 展开右面板（走 DraggablePanel 的 0.2s 过渡）。 */
  expand: (expand: boolean) => setExpand(expand),
})

const TAB = {
  id: TAB_ID,
  kind: 'file' as const,
  region: 'right' as const,
  title: '文件管理器',
  closable: true,
  order: 0,
  payload: { workspace: ROOT },
}

function Chat(): ReactElement {
  const display = useMemo(() => groupMessages(chatState.messages), [])
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <ChatMessageItems
        messages={display}
        unitsByMessage={new Map()}
        answeredQuestions={new Set()}
        fill="absolute"
        paddingInline={24}
        resetKey="resize"
        paddingBottom={96}
        data-testid="chat-scroll"
      />
    </AgentStoreContext.Provider>
  )
}

export default function PanelResize(): ReactElement {
  const [width, setWidth] = useState(1000)
  const [show, setShowState] = useState({ chat: true, explorer: true })
  const [expand, setExpandState] = useState(true)
  setShow = setShowState
  setExpand = setExpandState
  exposeData({ committedWidth: width })
  return (
    <App>
      <div style={{ display: 'flex', height: '100vh', background: 'var(--gren-content-bg)' }}>
        <div data-testid="chat-column" style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {show.chat ? <Chat /> : null}
        </div>
        <ResizeHandle
          placement="right"
          defaultSize={width}
          minSize={360}
          maxSize={1200}
          onResize={setWidth}
          expand={expand}
          backgroundColor="var(--gren-content-bg)"
        >
          <div data-testid="right-panel" style={{ height: '100%' }}>
            {show.explorer ? <FileTreeBody tab={TAB} active /> : null}
          </div>
        </ResizeHandle>
      </div>
    </App>
  )
}
