import { useEffect } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import { createAgentStore } from '../../src/stores/agent'
import { messagesFromAgent } from '../../src/stores/agentReducer'
import { TodoDockFromStore } from '../../src/features/chat/input/TodoDock'
import { latestTodosFromMessages } from '../../src/features/chat/input/latestTodos'
import type { AgentEvent, AgentMessage } from '../../src/lib/pi'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

const ROOT = 'ui-harness-todo-consistency'
const PATH = '/sessions/todo-consistency.jsonl'
const listeners = new Set<(event: { payload: unknown }) => void>()
let backend: AgentMessage[] = []
installBridge({
  subscribe: async (channel: string, listener: (event: { payload: unknown }) => void) => {
    if (channel === 'pi://event') listeners.add(listener)
    return () => listeners.delete(listener)
  },
  invoke: async (command: string) => {
    track(command)
    if (command === 'agent_get_messages') return { messages: backend }
    if (command === 'ui_history_read') return ''
    if (command === 'ask_user_draft_read') return null
    return undefined
  },
})
const store = createAgentStore(ROOT)
const list = (status: string) => ({ todos: [
  { id: 1, text: '排查完成', status: 'completed' },
  { id: 2, text: '实现完成', status: 'completed' },
  { id: 3, text: '验证并交付', status },
], nextId: 4 })
const result = (id: string, status: string): AgentMessage => ({ role: 'toolResult', toolName: 'todo', toolCallId: id, content: [{ type: 'text', text: '更新任务' }], details: list(status) } as AgentMessage)
const finish = (reason: string): AgentMessage => ({ role: 'assistant', content: [{ type: 'text', text: '相同的收尾正文' }], stopReason: reason, timestamp: 100 } as AgentMessage)
function load(messages: AgentMessage[], uiHistory?: ReturnType<typeof messagesFromAgent>) {
  backend = messages
  store.useStore.setState({ isStreaming: false, runActive: false, awaitingResponse: false })
  store.loadMessages(messages, { force: true, sessionPath: PATH, ...(uiHistory ? { uiHistory } : {}) })
}
function emit(event: object) {
  for (const listener of listeners) listener({ payload: { workspace: ROOT, sessionPath: PATH, source: 'interactive', event: event as AgentEvent } })
}
function end(id: string, status: string) {
  emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'todo', result: { details: list(status) }, isError: false })
}
load([result('initial', 'in_progress')])
store.useStore.setState({ runActive: true, isStreaming: true })
exposeActions({
  missingStart: () => end('final-write', 'completed'),
  lateProgress: () => emit({ type: 'tool_execution_update', toolCallId: 'final-write', toolName: 'todo', partialResult: { details: list('pending') } }),
  failedWrite: () => emit({ type: 'tool_execution_end', toolCallId: 'failed', toolName: 'todo', result: { details: { todos: [], error: 'invalid' } }, isError: false }),
  clear: () => emit({ type: 'tool_execution_end', toolCallId: 'clear', toolName: 'todo', result: { details: { todos: [], nextId: 1 } }, isError: false }),
  completeFromMessage: () => emit({ type: 'message_end', message: result('message-only', 'completed') }),
  roundRecovery: () => {
    load([result('old', 'in_progress')])
    emit({ type: 'agent_end', messages: [result('round-final', 'completed'), finish('stop')] })
    emit({ type: 'agent_settled' })
  },
  longHistory: () => {
    const ui = messagesFromAgent([result('old-ui', 'in_progress'), finish('stop')])
    ui.splice(1, 0, { kind: 'notice', id: 'retained', customType: 'trace', content: '保留较长历史' })
    load([result('new-disk', 'completed'), finish('stop')], ui)
  },
  sameLengthAbort: () => {
    load([result('same', 'in_progress'), finish('stop')])
    load([result('same', 'in_progress'), finish('aborted')])
  },
  cached: () => {
    load([result('cached', 'in_progress'), finish('stop')])
    store.loadMessages([], { force: true, sessionPath: '/sessions/other.jsonl' })
    store.showCachedSession(PATH)
  },
  wakeCached: () => {
    load([result('wake', 'in_progress'), finish('stop')])
    store.loadMessages([], { force: true, sessionPath: '/sessions/wake-other.jsonl' })
    emit({ type: 'agent_start' })
    store.showCachedSession(PATH)
  },
  rapid: () => {
    load([result('prior', 'pending')])
    for (const id of ['fast-a', 'fast-b']) emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'todo', args: {} })
    end('fast-a', 'in_progress')
    end('fast-b', 'completed')
    end('fast-a', 'in_progress')
  },
  outOfOrder: () => {
    load([result('newer', 'completed'), result('older', 'pending')])
    emit({ type: 'agent_end', messages: [result('older', 'pending'), result('newer', 'completed'), finish('stop')] })
    emit({ type: 'agent_settled' })
  },
  settledWithoutEnd: () => {
    load([result('tail', 'in_progress')])
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 100 } })
    emit({ type: 'message_end', message: finish('stop') })
    emit({ type: 'agent_settled' })
  },
  nextUser: () => store.pushUserMessage('下一轮'),
})
const context = { workspace: ROOT, store, workspaceReady: false, setWorkspaceReady: () => {}, appBooted: true }
export default function TodoConsistency() {
  const state = store.useStore()
  useEffect(() => exposeData({ finished: state.todoListFinished, assistantStop: state.assistantStop, runActive: state.runActive, statuses: latestTodosFromMessages(state.messages)?.map((todo) => todo.status) }), [state])
  return <AgentStoreContext.Provider value={context}>
    <div style={{ height: '100vh', padding: 40, boxSizing: 'border-box', background: 'var(--gren-content-bg)' }}>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <h3>待办状态一致性</h3>
        <TodoDockFromStore />
      </div>
    </div>
  </AgentStoreContext.Provider>
}
