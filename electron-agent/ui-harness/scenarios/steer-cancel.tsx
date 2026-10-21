import { useEffect, useMemo, useSyncExternalStore, type ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import { createAgentStore } from '../../src/stores/agent'
import { applyEvent } from '../../src/stores/agentReducer'
import type { AgentEvent } from '../../src/lib/pi'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { computeSubAgentUnits } from '../../src/features/chat/messagePrecompute'
import { renderMessageBody } from '../../src/features/chat/ChatMessageItems'
import { registerComposerLoad } from '../../src/features/chat/input/composerBridge'
import { exposeData, installBridge, track } from '../stubs'

/**
 * 回合执行中发出的引导还在等待注入时，气泡的焦点操作栏有「取消引导」（X）和「编辑」。
 *
 * 用真实的 createAgentStore：引导经 pushUserMessage(steering) 落成 written，取消走 store.cancelSteer →
 * pi.cancelSteer → invoke('agent_cancel_steer')。主进程那头用桩：正文是「已经在注入的那条」时回 cancelled: false
 * （模拟 Pi 已经把它取走），其余回 cancelled: true。输入框只装 composerBridge 的回填接缝，把收到的正文和图片数画出来。
 */

const WORKSPACE = 'ui-harness-steer-cancel'
const IN_FLIGHT = '已经在注入的那条'
const IMAGE = {
  mimeType: 'image/png',
  // 1×1 透明 png
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
}

installBridge({
  invoke: async (command: string, args: { message?: string; allowSole?: boolean }) => {
    if (command === 'agent_cancel_steer') {
      track(`cancel:${args.message}:${args.allowSole ? 'sole' : 'exact'}`)
      return { cancelled: args.message !== IN_FLIGHT }
    }
    track(`invoke:${command}`)
    return null
  },
  subscribe: async () => () => {},
})

const store = createAgentStore(WORKSPACE)
// 回合在跑：agent_start 置 isStreaming，操作栏在忙碌时也要出现。
store.useStore.setState(applyEvent(store.useStore.getState(), { type: 'agent_start' } as unknown as AgentEvent), true)
store.pushUserMessage('先把登录流程的自动化跑一遍')
{
  const message = { role: 'assistant', content: [{ type: 'text', text: '好的，我先用 playwright 打开登录页…' }], timestamp: 2 }
  store.useStore.setState(applyEvent(store.useStore.getState(), { type: 'message_start', message } as unknown as AgentEvent), true)
}
// 已经注入的一条做对照（没有取消），再排三条等待中的。
store.pushUserMessage('先别截图', undefined, true)
store.useStore.setState((s) => ({
  messages: s.messages.map((m) => (m.kind === 'user' && m.text === '先别截图' ? { ...m, steerState: 'consumed' as const } : m)),
}))
store.pushUserMessage('改用 chrome', [IMAGE], true)
store.pushUserMessage('再补登录态', undefined, true)
store.pushUserMessage(IN_FLIGHT, undefined, true)

const idOf = (text: string) => store.useStore.getState().messages.find((m) => m.kind === 'user' && m.text === text)?.id
exposeData({
  ids: {
    consumed: idOf('先别截图'),
    chrome: idOf('改用 chrome'),
    login: idOf('再补登录态'),
    inFlight: idOf(IN_FLIGHT),
  },
})

const context = {
  workspace: WORKSPACE,
  store,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
}

type Composer = { text: string; images: number }
let composer: Composer = { text: '', images: 0 }
const composerListeners = new Set<() => void>()
registerComposerLoad((text, images) => {
  composer = { text: composer.text ? `${composer.text}\n\n${text}` : text, images: composer.images + (images?.length ?? 0) }
  for (const listener of composerListeners) listener()
})

function FakeComposer(): ReactElement {
  const value = useSyncExternalStore(
    (listener) => {
      composerListeners.add(listener)
      return () => composerListeners.delete(listener)
    },
    () => composer,
  )
  return (
    <div id="composer" style={{ marginTop: 24, padding: 12, border: '1px solid #888', borderRadius: 8 }}>
      <div id="composer-text" style={{ whiteSpace: 'pre-wrap', minHeight: 20 }}>{value.text}</div>
      <div id="composer-images">{value.images}</div>
    </div>
  )
}

function Timeline(): ReactElement {
  const messages = store.useStore((s) => s.messages)
  const display = useMemo(() => groupMessages(messages), [messages])
  const index = useMemo(() => computeSubAgentUnits(display), [display])
  return (
    <div id="timeline">
      {display.map((message) => (
        <div key={message.id} data-msg-id={message.id} style={{ marginBottom: 12 }}>
          {renderMessageBody(message, index.unitsByMessage, new Set())}
        </div>
      ))}
    </div>
  )
}

export default function SteerCancelScenario(): ReactElement {
  useEffect(() => () => registerComposerLoad(null), [])
  return (
    <AgentStoreContext.Provider value={context}>
      <div style={{ height: '100vh', overflow: 'auto', background: 'var(--gren-content-bg)' }}>
        <div style={{ width: 720, margin: '0 auto', paddingTop: 24 }}>
          <Timeline />
          <FakeComposer />
        </div>
      </div>
    </AgentStoreContext.Provider>
  )
}
