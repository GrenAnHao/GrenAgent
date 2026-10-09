import { useState, type ReactElement } from 'react'
import { VirtualizedMessageList } from '../../src/features/chat/VirtualizedMessageList'
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
  /** 用户发出一条新消息（列表末尾是用户消息）。 */
  send: () => setItems((items) => [...items, { id: `u${items.length}`, lines: 1, user: true }]),
})

export default function ChatFollow(): ReactElement {
  const [items, set] = useState<Item[]>(LONG)
  const [session, setKey] = useState('long')
  setItems = (update) => set(update)
  setSession = setKey
  const last = items[items.length - 1]
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
