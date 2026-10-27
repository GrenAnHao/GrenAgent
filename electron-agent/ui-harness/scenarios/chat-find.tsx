import { useMemo, useRef, useState, type ReactElement } from 'react'
import { ChatMessageItems } from '../../src/features/chat/ChatMessageItems'
import { groupMessages } from '../../src/features/chat/groupMessages'
import type { TranscriptScrollHandle } from '../../src/features/chat/VirtualizedMessageList'
import { FindBar } from '../../src/features/find/FindBar'
import { FIND_BAR_HEIGHT } from '../../src/features/find/findActions'
import { FindShortcutHost } from '../../src/features/find/FindShortcutHost'
import { useFindScope } from '../../src/features/find/findStore'
import { CHAT_FIND_SCOPE, useSessionFind } from '../../src/features/find/useSessionFind'
import { computeAnsweredQuestions, computeSubAgentUnits } from '../../src/features/chat/messagePrecompute'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { initialAgentState, type AgentState, type ChatMessage } from '../../src/stores/agentReducer'
import { exposeActions, exposeData } from '../stubs'

/**
 * 会话内查找：真实 ChatMessageItems（virtua 虚拟化、Markdown、代码块）+ 真实 useSessionFind / FindBar / FindShortcutHost。
 * 外层按 ChatView 的结构摆：根带 data-find-scope，查找栏绝对定位在顶部，列表顶边下移一个查找栏的高度，底部是悬浮输入区。
 * 数据确定：80 条消息（每条够高，屏幕外的会被卸载），关键词 needle 的位置和个数都写死，见 EXPECTED。
 */

const SEAT_HEIGHT = 72

const filler = (i: number) =>
  Array.from({ length: 6 }, (_, k) => `段落 ${i}-${k}：这是一段用来撑高度的正文，里面没有关键词，只是让每条消息足够长，保证列表会卸载屏幕外的消息。`).join('\n\n')

const messages: ChatMessage[] = []
for (let i = 0; i < 40; i += 1) {
  let user = `用户第 ${i} 条提问`
  let assistant = filler(i)
  if (i === 3) user = '请帮我找一下 needle 在哪里' // 1
  if (i === 40 - 1) user = 'NEEDLE 全大写也要能找到' // 1（不区分大小写）
  if (i === 0) {
    // 4：加粗、行内代码、链接文字、复数里的部分匹配（链接地址里的 needle 不算，它不是可见文字）
    assistant = `这里有 **needle** 加粗，行内 \`needle\`，链接 [needle docs](https://example.com/needle-docs)，还有 Needles 复数。\n\n${filler(i)}`
  }
  if (i === 20) assistant = `${filler(i)}\n\n\`\`\`ts\nconst needle = 1\nneedle()\n\`\`\`\n` // 2：代码块
  if (i === 39) assistant = `${filler(i)}\n\n最后一条：final needle`  // 1
  messages.push({ kind: 'user', id: `u${i}`, text: user })
  messages.push({ kind: 'assistant', id: `a${i}`, text: assistant, thinking: '', streaming: false })
}
/** 1 + 1 + 4 + 2 + 1 */
const EXPECTED = 9

const mockCtx = {
  workspace: '',
  store: { useStore: (selector: (value: AgentState) => unknown) => selector(initialAgentState()) } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}

let appendAssistant: (text: string) => void = () => {}
let switchSession: (key: string) => void = () => {}
exposeActions({
  /** 流式 / 新消息：往会话末尾加一条助手消息。 */
  appendAssistant: (text: string) => appendAssistant(text),
  /** 换会话（resetKey 变）。 */
  switchSession: (key: string) => switchSession(key),
})
exposeData({ expected: EXPECTED, messageCount: messages.length })

function Chat(): ReactElement {
  const [list, setList] = useState<ChatMessage[]>(messages)
  const [sessionKey, setSessionKey] = useState('session-a')
  appendAssistant = (text) =>
    setList((cur) => [...cur, { kind: 'assistant', id: `late-${cur.length}`, text, thinking: '', streaming: false }])
  switchSession = (key) => setSessionKey(key)

  const display = useMemo(() => groupMessages(list), [list])
  const subAgents = useMemo(() => computeSubAgentUnits(display), [display])
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display])
  const scrollRef = useRef<TranscriptScrollHandle>(null)
  useSessionFind(display, subAgents.hidden, scrollRef, sessionKey)
  const findOpen = useFindScope(CHAT_FIND_SCOPE).open

  return (
    <>
    <div
      data-find-scope={CHAT_FIND_SCOPE}
      style={{ position: 'relative', height: '100vh', overflow: 'hidden', background: 'var(--gren-content-bg)' }}
    >
      <div style={{ position: 'absolute', inset: 0, top: findOpen ? FIND_BAR_HEIGHT : 0 }} data-testid="list-wrap">
        <ChatMessageItems
          messages={display}
          unitsByMessage={subAgents.unitsByMessage}
          hiddenSpawnIds={subAgents.hidden}
          spawnOverlay={subAgents.overlay}
          answeredQuestions={answeredQuestions}
          fill="absolute"
          paddingInline={24}
          resetKey={sessionKey}
          paddingBottom={SEAT_HEIGHT}
          scrollRef={scrollRef}
          data-testid="chat-scroll"
        />
      </div>
      {findOpen ? (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3 }} data-testid="find-wrap">
          <FindBar scope={CHAT_FIND_SCOPE} placeholder="在会话中查找" data-testid="chat-find-bar" />
        </div>
      ) : null}
      <div
        data-testid="composer-seat"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 3, height: SEAT_HEIGHT, padding: 8, boxSizing: 'border-box', background: 'var(--gren-content-bg)' }}
      >
        <div
          data-testid="composer"
          contentEditable
          suppressContentEditableWarning
          tabIndex={0}
          style={{ height: '100%', border: '1px solid #888', borderRadius: 8, padding: 8, outline: 'none' }}
        >
          输入消息
        </div>
      </div>
    </div>
      {/* 范围之外的输入框，模拟侧栏搜索框：它自己的 Ctrl+F 监听（挂在 document 上）必须不被查找抢走。 */}
      <input
        data-testid="outside-input"
        placeholder="搜索会话"
        style={{ position: 'fixed', left: 8, bottom: 90, width: 120, zIndex: 10 }}
      />
    </>
  )
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    ;(window as unknown as { __sidebarFind?: number }).__sidebarFind = ((window as unknown as { __sidebarFind?: number }).__sidebarFind ?? 0) + 1
  }
})

export default function ChatFindScenario(): ReactElement {
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <FindShortcutHost />
      <Chat />
    </AgentStoreContext.Provider>
  )
}
