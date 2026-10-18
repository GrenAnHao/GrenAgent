import type { ReactElement } from 'react'
import { CodeRetrievalPanel } from '../../src/features/agentData/CodeRetrievalPanel'
import { AgentDataTaskProvider } from '../../src/features/agentData/AgentDataTaskProvider'
import { styles } from '../../src/features/agentData/agentDataStyles'
import { useSessionStore } from '../../src/store'
import { exposeData, installBridge, track } from '../stubs'

/**
 * Agent 数据 · 代码索引：真实 CodeRetrievalPanel，主进程用桩。
 * 外面套和 AgentDataCenter 一样的 `styles.panel`（height: 100% + overflow: auto），才看得出页面会不会被结果撑长。
 * 项目有 3000 个文件：搜索框留空时 codegraph_files 按 limit / offset 分页返回（每次请求记成事件，probe 断言没有一次返回超过一页），
 * 搜索返回 40 条符号（附带一大块 extra，让原始结果超长），源码有两份：400 行的小文件，和 12000 行的大文件
 * （每 200 行一条会折成好几行的长注释，行高不一）。
 */

const WORKSPACE = 'D:/demo/app'
const FILE_COUNT = 3000
const SYMBOL_COUNT = 40
const SMALL_SOURCE_LINES = 400
const BIG_SOURCE_LINES = 12000
/** parseRecord1 所在的文件，读它返回大文件 */
const BIG_SOURCE_FILE = 'src/module-0001/index.ts'
const LONG_COMMENT_EVERY = 200

const fileRows = Array.from({ length: FILE_COUNT }, (_, index) => ({
  file: `src/module-${String(index).padStart(4, '0')}/index.ts`,
  kind: 'file',
  snippet: `typescript · ${index % 40 + 3} 个节点 · ${1000 + index} B`,
}))
const symbolRows = Array.from({ length: SYMBOL_COUNT }, (_, index) => ({
  id: `function:parse-${index}`,
  symbol: `parseRecord${index}`,
  file: `src/module-${String(index).padStart(4, '0')}/index.ts`,
  line: index + 5,
  kind: 'function',
  snippet: `export function parseRecord${index}(input: string): Record<string, unknown>`,
}))

function sourceOf(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1
    return number % LONG_COMMENT_EVERY === 0
      ? `// line ${number}: ${'这是一条很长的注释，会在预览里折成好几行。 '.repeat(8)}`
      : `const line${number} = ${number}`
  }).join('\n')
}
const smallSource = sourceOf(SMALL_SOURCE_LINES)
const bigSource = sourceOf(BIG_SOURCE_LINES)

exposeData({
  fileCount: FILE_COUNT, symbolCount: SYMBOL_COUNT, smallSourceLines: SMALL_SOURCE_LINES, bigSourceLines: BIG_SOURCE_LINES,
  pageSize: 100, longCommentEvery: LONG_COMMENT_EVERY,
})

function toolResult(rows: unknown[], extra?: Record<string, unknown>): unknown {
  return {
    content: [{ type: 'text', text: `${rows.length} rows` }],
    isError: false,
    structuredContent: { schemaVersion: 1, rows, nodes: [], edges: [], ...(extra ? { extra } : {}) },
  }
}

interface FilesArgs { offset?: number; limit?: number }

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'agentData_code_projects': return [{ workspace: WORKSPACE, indexed: true }]
      case 'agentData_code_status':
        return { workspace: WORKSPACE, connected: true, indexed: true, state: 'ready', files: FILE_COUNT, nodes: 21000, edges: 52000, lastIndexedAt: Date.parse('2026-10-14T00:00:00.000Z') }
      case 'agentData_code_call': {
        if (args.tool === 'codegraph_files') {
          const { offset = 0, limit = FILE_COUNT } = args.args as FilesArgs
          // 和主进程一样：先切页，再带上过滤后的总数；一页最多 500。
          const page = fileRows.slice(offset, offset + Math.min(limit, 500))
          track(`files:${offset}+${page.length}`)
          return toolResult(page, { page: { offset, total: FILE_COUNT } })
        }
        // 搜索结果带一大块 extra：原始结果（整个响应的 JSON）超过显示上限。
        if (args.tool === 'codegraph_search') return toolResult(symbolRows, { padding: 'x'.repeat(250_000) })
        return toolResult([])
      }
      case 'agentData_tasks_list': return { items: [], activeCount: 0 }
      case 'read_file': return args.path === BIG_SOURCE_FILE ? bigSource : smallSource
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

useSessionStore.setState({ registeredProjects: [WORKSPACE] })

export default function CodeRetrievalPanelScenario(): ReactElement {
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
