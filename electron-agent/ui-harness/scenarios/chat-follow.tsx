import { useMemo, useState, type ReactElement } from 'react'
import { VirtualizedMessageList } from '../../src/features/chat/VirtualizedMessageList'
import { ChatMessageItems } from '../../src/features/chat/ChatMessageItems'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { applyEvent, initialAgentState, type AgentState } from '../../src/stores/agentReducer'
import type { AgentEvent } from '../../src/lib/pi'
import { exposeActions } from '../stubs'

// 对话列表自动贴底：真实 VirtualizedMessageList，条目只是定高文字块，
// 其中一条带内部滚动区（对应思考块 / 终端输出 / 代码块这类会自己滚的内容）。
interface Item {
  id: string
  lines: number
  inner?: boolean
  user?: boolean
}

const line = (i: number) => `第 ${i + 1} 行：流式正文持续增长，列表应该一直跟在最底部。`

function Row({ item }: { item: Item }): ReactElement {
  return (
    <div data-testid={`row-${item.id}`} style={{ padding: '8px 0', lineHeight: '22px' }}>
      {item.inner ? (
        <div data-testid="inner-scroll" style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #888' }}>
          {Array.from({ length: 40 }, (_, i) => (
            <div key={i}>内部滚动区 {i + 1}</div>
          ))}
        </div>
      ) : null}
      {Array.from({ length: item.lines }, (_, i) => (
        <div key={i}>{line(i)}</div>
      ))}
    </div>
  )
}

const SHORT: Item[] = [{ id: 'a', lines: 2, inner: true }]
const LONG: Item[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, lines: 8 })),
  { id: 'inner', lines: 2, inner: true },
  { id: 'tail', lines: 4 },
]

// 真实对话：pi 事件走真实 reducer → groupMessages → ChatMessageItems（Markdown、代码块、表格、工具卡）。
const REAL_CHUNKS = [
  '## 检查结果\n\n先看一下模块边界，下面逐条说明。\n\n',
  '- 第一项：入口文件负责装配，**不做**业务判断；\n- 第二项：状态都放在 store 里；\n- 第三项：渲染层只读快照。\n\n',
  "```ts\nexport function plan(input: string): string[] {\n  const steps = input.split(',')\n  return steps.filter(Boolean).map((s) => s.trim())\n}\n```\n\n",
  '| 模块 | 行数 | 结论 |\n| --- | --- | --- |\n| core | 420 | 保留 |\n| ui | 1280 | 拆分 |\n| io | 96 | 合并 |\n\n',
  '接下来继续核对每个调用点，确认没有遗漏的副作用，再把结论汇总成一张表。\n\n',
]
const realBase = [
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: REAL_CHUNKS.join('').repeat(3) }] } },
] as AgentEvent[]
const mockCtx = {
  workspace: '',
  store: { useStore: (selector: (value: AgentState) => unknown) => selector(initialAgentState()) } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}
let setReal: (update: (state: AgentState) => AgentState) => void = () => {}
let setMode: (mode: 'blocks' | 'real') => void = () => {}

let setItems: (update: (items: Item[]) => Item[]) => void = () => {}
let setSession: (key: string) => void = () => {}

exposeActions({
  /** 换一段会话：short 只有一条带内部滚动的短消息，long 撑满好几屏。 */
  load: (kind: 'short' | 'long') => {
    setSession(kind)
    setItems(() => (kind === 'short' ? SHORT : LONG))
  },
  /** 流式增长：最后一条加 n 行。 */
  grow: (n: number) =>
    setItems((items) => items.map((item, i) => (i === items.length - 1 ? { ...item, lines: item.lines + n } : item))),
  /** 一次性追加一条很高的新消息（大段工具结果）。 */
  append: (lines: number) => setItems((items) => [...items, { id: `n${items.length}`, lines }]),
  /**
   * 快速输出：在页面里按 every 毫秒连续增长 duration 毫秒，每 appendEvery 次插一条新的工具结果。
   * 走 probe 往返太慢，模拟不出一帧内连着几次长高。返回结束时的 Promise。
   */
  burst: (duration: number, every: number, lines: number, appendEvery = 0) =>
    new Promise<void>((resolve) => {
      let n = 0
      const timer = setInterval(() => {
        n += 1
        setItems((items) => {
          const grown = items.map((item, i) => (i === items.length - 1 ? { ...item, lines: item.lines + lines } : item))
          return appendEvery && n % appendEvery === 0 ? [...grown, { id: `b${n}`, lines: 30 }] : grown
        })
      }, every)
      setTimeout(() => {
        clearInterval(timer)
        resolve()
      }, duration)
    }),
  /** 切到真实对话组件并重置。 */
  loadReal: () => {
    setSession('real')
    setMode('real')
    setReal(() => realBase.reduce(applyEvent, initialAgentState()))
  },
  /**
   * 真实对话快速输出：每 every 毫秒发一段 text_delta，每 toolEvery 段收尾这条消息、插一张 bash 工具卡，
   * 再开新的助手消息。和 burst 一样在页面里跑。
   */
  streamReal: (duration: number, every: number, toolEvery: number) =>
    new Promise<void>((resolve) => {
      let n = 0
      let text = ''
      const feed = (events: AgentEvent[]) => setReal((state) => events.reduce(applyEvent, state))
      feed([{ type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent])
      const timer = setInterval(() => {
        const chunk = REAL_CHUNKS[n % REAL_CHUNKS.length]
        n += 1
        text += chunk
        const events = [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: chunk } }] as AgentEvent[]
        if (n % toolEvery === 0) {
          const id = `bash-${n}`
          const output = Array.from({ length: 12 }, (_, i) => `module-${n}-${i} checked`).join('\n')
          events.push(
            { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } } as AgentEvent,
            { type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: `ls module-${n}` } } as AgentEvent,
            { type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result: { content: [{ type: 'text', text: output }] }, isError: false } as AgentEvent,
            { type: 'message_start', message: { role: 'assistant', content: [] } } as AgentEvent,
          )
          text = ''
        }
        feed(events)
      }, every)
      setTimeout(() => {
        clearInterval(timer)
        feed([{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } } as AgentEvent])
        resolve()
      }, duration)
    }),
  /** 用户发出一条新消息（列表末尾是用户消息）。 */
  send: () => setItems((items) => [...items, { id: `u${items.length}`, lines: 1, user: true }]),
})

function RealChat({ state }: { state: AgentState }): ReactElement {
  const display = useMemo(() => groupMessages(state.messages), [state.messages])
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <ChatMessageItems
        messages={display}
        unitsByMessage={new Map()}
        answeredQuestions={new Set()}
        footer={<div data-testid="real-footer">正在处理…</div>}
        fill="absolute"
        paddingInline={24}
        resetKey="real"
        paddingBottom={96}
        data-testid="chat-scroll"
        sessionLive
      />
    </AgentStoreContext.Provider>
  )
}

export default function ChatFollow(): ReactElement {
  const [items, set] = useState<Item[]>(LONG)
  const [session, setKey] = useState('long')
  const [mode, setModeState] = useState<'blocks' | 'real'>('blocks')
  const [real, setRealState] = useState<AgentState>(() => realBase.reduce(applyEvent, initialAgentState()))
  setItems = (update) => set(update)
  setSession = setKey
  setMode = setModeState
  setReal = (update) => setRealState(update)
  const last = items[items.length - 1]
  if (mode === 'real') {
    return (
      <div style={{ height: '100vh', width: 780, margin: '0 auto', position: 'relative', background: 'var(--gren-content-bg)' }}>
        <RealChat state={real} />
      </div>
    )
  }
  return (
    <div style={{ height: '100vh', width: 780, margin: '0 auto', position: 'relative', background: 'var(--gren-content-bg)' }}>
      <VirtualizedMessageList
        display={items}
        renderItem={(item) => <Row item={item} />}
        fill="absolute"
        resetKey={session}
        followKey={last?.user ? last.id : null}
        paddingBottom={96}
        data-testid="chat-scroll"
      />
    </div>
  )
}
