import { useMemo, useState, type ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { messagesFromAgent } from '../../src/stores/agentReducer'
import type { AgentMessage, SubAgentItem } from '../../src/lib/pi'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { computeSubAgentUnits } from '../../src/features/chat/messagePrecompute'
import { renderMessageBody } from '../../src/features/chat/ChatMessageItems'
import { deferred, exposeActions, exposeData, installBridge, track } from '../stubs'

const rows: SubAgentItem[] = [
  { id: 'sa-unrelated', task: '重复任务', status: 'done', model: 'p/wrong-model', createdAt: 5, updatedAt: 5 },
  { id: 'sa-b', task: '检查并发查询', status: 'done', model: 'p/model-b', createdAt: 4, updatedAt: 4 },
  { id: 'sa-group-b', task: '重复任务', status: 'done', model: 'q/group-b', createdAt: 3, updatedAt: 3 },
  { id: 'sa-a', task: '检查恢复标题与模型', status: 'done', model: 'p/model-a', thinkingLevel: 'high', createdAt: 2, updatedAt: 2 },
  { id: 'sa-group-a', task: '重复任务', status: 'done', model: 'p/group-a', thinkingLevel: 'medium', createdAt: 1, updatedAt: 1 }
]
const registry = deferred<SubAgentItem[]>()
installBridge({
  invoke: async (command: string) => {
    // 供应商显示名：p 有名字，q 没配置（回落到 id）。
    if (command === 'get_provider_config') return { modelsJson: JSON.stringify({ providers: { p: { name: '中转站' } } }), authJson: null }
    if (command !== 'subagent_list') throw new Error(`unexpected command: ${command}`)
    track('registry-list')
    return registry.promise
  }
})
exposeActions({ releaseRegistry: () => registry.resolve(rows) })
exposeData({ titles: ['检查恢复标题与模型', '检查并发查询'], models: ['中转站 / model-a · 高', '中转站 / model-b'], groupModels: ['中转站 / group-a · 中', 'q / group-b'] })

// 旧的 wait/status 结果不带模型；原启动消息已不在上下文。并行结果也曾漏存模型。
const history: AgentMessage[] = [
  { role: 'assistant', content: [
    { type: 'toolCall', id: 'wait-a', name: 'spawn_agent', arguments: { action: 'wait', agentId: 'sa-a' } },
    { type: 'toolCall', id: 'wait-b', name: 'spawn_agent', arguments: { action: 'status', agentId: 'sa-b' } },
    { type: 'toolCall', id: 'group', name: 'spawn_agent', arguments: { tasks: ['重复任务', '重复任务'] } }
  ] },
  { role: 'toolResult', toolCallId: 'wait-a', toolName: 'spawn_agent', content: [{ type: 'text', text: '结果 A' }], details: { agentId: 'sa-a', status: 'done' } },
  { role: 'toolResult', toolCallId: 'wait-b', toolName: 'spawn_agent', content: [{ type: 'text', text: '结果 B' }], details: { agentId: 'sa-b', status: 'done' } },
  { role: 'toolResult', toolCallId: 'group', toolName: 'spawn_agent', content: [], details: { results: [
    { agentId: 'sa-group-a', task: '重复任务', ok: true },
    { agentId: 'sa-group-b', task: '重复任务', ok: true }
  ] } }
]
const context = {
  workspace: 'ui-harness-subagent-history',
  store: { getLoadedSessionPath: () => '/history.jsonl' } as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true
}

function HistoryCards(): ReactElement {
  const display = useMemo(() => groupMessages(messagesFromAgent(history)), [])
  const index = useMemo(() => computeSubAgentUnits(display), [display])
  return <div id="history-cards">
    {display.map((message) => <div key={message.id} style={{ marginBottom: 12 }}>
      {renderMessageBody(message, index.unitsByMessage, new Set())}
    </div>)}
  </div>
}

export default function SubagentHistory(): ReactElement {
  const [generation, setGeneration] = useState(0)
  return <AgentStoreContext.Provider value={context}>
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)', overflow: 'auto' }}>
      <div style={{ maxWidth: 850, margin: '0 auto' }}>
        <button id="reopen-history" onClick={() => setGeneration((value) => value + 1)}>重新打开会话</button>
        <HistoryCards key={generation} />
      </div>
    </div>
  </AgentStoreContext.Provider>
}
