import type { ReactElement } from 'react'
import { CodeRetrievalPanel } from '../../src/features/agentData/CodeRetrievalPanel'
import { AgentDataTaskProvider } from '../../src/features/agentData/AgentDataTaskProvider'
import { styles } from '../../src/features/agentData/agentDataStyles'
import { useSessionStore } from '../../src/store'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * Agent 数据 · 代码索引的自动同步呈现：真实 CodeRetrievalPanel，`agentData_code_status` 的返回由 probe 经 act 切换，
 * 形状照 codegraph-host 的 CodeGraphThreads.status（state + phase / progress / lastError / watcher 等调度字段）。
 * 自动同步不建任务，页面在调度器推进期间静默轮询状态；每次读状态记一条事件，probe 据此判断轮询开始、停止。
 */

const WORKSPACE = 'D:/demo/sync-app'
const FILES = 120
const base = { workspace: WORKSPACE, connected: true, indexed: true, sdkAvailable: true, sdkVersion: '1.6.2', nodes: 900, edges: 2100, lastIndexedAt: Date.parse('2026-10-18T00:00:00.000Z'), autoSync: true, consecutiveFailures: 0, pendingChanges: 0 }
const watching = { active: true, degraded: false }

type Phase = 'syncing' | 'idle' | 'locked' | 'rebuilding' | 'failed' | 'degraded'
let phase: Phase = 'syncing'

function status(): Record<string, unknown> {
  switch (phase) {
    case 'syncing': return { ...base, state: 'indexed', files: FILES, phase: 'syncing', mode: 'incremental', trigger: 'watch', servingStale: true, pendingChanges: 2, progress: { stage: '解析代码', processed: 3, total: 8 }, watcher: watching, generation: 4 }
    case 'idle': return { ...base, state: 'indexed', files: FILES + 2, phase: 'idle', servingStale: false, watcher: watching, generation: 5 }
    // 重试时刻跟着读状态的时刻走：页面按自己的时钟算「还有几秒」
    case 'locked': return { ...base, state: 'indexed', files: FILES + 2, phase: 'backoff', servingStale: true, lastError: { message: 'Sync could not acquire the file lock', at: Date.now(), code: 'CODEGRAPH_LOCKED' }, nextRetryAt: Date.now() + 20_000, watcher: watching, generation: 5 }
    case 'rebuilding': return { ...base, state: 'indexing', files: FILES + 2, phase: 'rebuilding', mode: 'full', trigger: 'manual', servingStale: false, watcher: watching, generation: 5 }
    case 'failed': return { ...base, state: 'failed', files: FILES + 2, message: 'parse exploded', phase: 'failed', consecutiveFailures: 6, lastError: { message: 'parse exploded', at: 0 }, servingStale: false, watcher: watching, generation: 5 }
    case 'degraded': return { ...base, state: 'indexed', files: FILES + 2, phase: 'idle', servingStale: false, watcher: { active: false, degraded: true, reason: 'EMFILE: too many open files' }, generation: 6 }
  }
}

const fileRows = Array.from({ length: 30 }, (_, index) => ({ file: `src/file-${index}.ts`, kind: 'file', snippet: 'typescript' }))

exposeData({ files: FILES })
exposeActions({ set: (next: Phase) => { phase = next } })

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'agentData_code_projects': return [{ workspace: WORKSPACE, indexed: true }]
      case 'agentData_code_status': track(`status:${phase}`); return status()
      case 'agentData_code_call':
        track(`call:${String(args.tool)}`)
        return { content: [{ type: 'text', text: `${fileRows.length} rows` }], isError: false, structuredContent: { schemaVersion: 1, rows: fileRows, nodes: [], edges: [], extra: { page: { offset: 0, total: fileRows.length } } } }
      case 'agentData_tasks_list': return { items: [], activeCount: 0 }
      case 'read_file': return 'export const x = 1'
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

useSessionStore.setState({ registeredProjects: [WORKSPACE] })

export default function CodeIndexSyncScenario(): ReactElement {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--gren-content-bg)' }}>
      <div className={styles.panel} data-testid="agent-data-panel">
        <AgentDataTaskProvider visible activeView="code">
          <CodeRetrievalPanel initialProject={WORKSPACE} visible />
        </AgentDataTaskProvider>
      </div>
    </div>
  )
}
