import { type ReactElement } from 'react'
import { Sidebar } from '../../src/features/sessions/Sidebar'
import {
  archiveSessionPaths,
  conversationSessionPaths,
  unarchiveSessionPath,
} from '../../src/features/sessions/archiveActions'
import { useSessionStore } from '../../src/store/session'
import { useSidebarPrefsStore } from '../../src/stores/sidebarPrefsStore'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import { initialAgentState } from '../../src/stores/agentReducer'
import type { SessionInfo } from '../../src/lib/pi'
import { exposeData, installBridge, track } from '../stubs'

/**
 * 会话归档：真实 Sidebar（菜单、过滤、底部「已归档」入口和弹窗、只读查看）+ 真实 archiveActions
 * （乐观标记、调主进程、失败回滚）。主进程只有 set_sessions_archived / subagent_get_session_messages 用桩：
 * 桩维护一份「磁盘」上的会话和归档登记，形状照 electron/app/workspaceService.ts（归档的带 archived: true）。
 * App 里归档后的 refreshAllSessions 在这里换成 syncFromDisk。
 *
 * 数据：项目 D:/repo 三份会话（「修复登录页」回合在跑、「重构订单查询」、「旧的发布脚本」已归档），
 * 对话目录 works/c1 两份会话（侧栏只显示最新的「写周报」）。
 */

const WORKS = 'C:/agent/works'
const REPO = 'D:/repo'
const CONV = `${WORKS}/c1`

const session = (cwd: string, ts: string, name: string): SessionInfo => ({
  id: ts,
  path: `${cwd === REPO ? 'D:/s/repo' : 'D:/s/c1'}/${ts}.jsonl`,
  cwd,
  timestamp: ts,
  name,
})

const RUNNING = session(REPO, '2026-10-19T08:00:00.000Z', '修复登录页')
const REFACTOR = session(REPO, '2026-10-18T08:00:00.000Z', '重构订单查询')
const OLD = session(REPO, '2026-10-01T08:00:00.000Z', '旧的发布脚本')
const WEEKLY = session(CONV, '2026-10-17T08:00:00.000Z', '写周报')
const WEEKLY_OLD = session(CONV, '2026-10-10T08:00:00.000Z', '上周的周报草稿')

const disk = [RUNNING, REFACTOR, OLD, WEEKLY, WEEKLY_OLD]
const archived = new Set<string>([OLD.path])
const deleted = new Set<string>()

const fromDisk = (): SessionInfo[] =>
  disk.filter((s) => !deleted.has(s.path)).map((s) => (archived.has(s.path) ? { ...s, archived: true } : s))

const READONLY_MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '把发布脚本改成从 CI 读版本号' }], timestamp: 1 },
  { role: 'assistant', content: [{ type: 'text', text: '发布脚本已经改好，版本号从 CI 变量读取。' }], timestamp: 2 },
]

installBridge({
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'set_sessions_archived': {
        const paths = args.sessionPaths as string[]
        track(`${args.archived ? 'archive' : 'unarchive'}:${paths.join(',')}`)
        for (const p of paths) {
          if (args.archived) archived.add(p)
          else archived.delete(p)
        }
        return undefined
      }
      case 'subagent_get_session_messages':
        track(`view:${args.sessionPath}`)
        return { messages: READONLY_MESSAGES }
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
  subscribe: async () => () => {},
})

useSessionStore.setState({
  worksDir: WORKS,
  activeWorkspace: REPO,
  activeSessionPath: RUNNING.path,
  allSessions: fromDisk(),
  registeredProjects: [REPO],
})
useSidebarPrefsStore.setState({ collapsed: {}, pinnedSessions: [], pinnedConversations: [], pinnedProjects: [], hiddenProjects: [] })

const syncFromDisk = () => useSessionStore.getState().syncAllSessions(fromDisk())
const runningPaths = new Set([RUNNING.path])

exposeData({
  paths: { RUNNING: RUNNING.path, REFACTOR: REFACTOR.path, OLD: OLD.path, WEEKLY: WEEKLY.path, WEEKLY_OLD: WEEKLY_OLD.path },
})

// 只读查看里的消息组件会读当前会话 store：给一份空状态（同 isolated-workspace 场景）。
const agentState = initialAgentState()
const mockCtx = {
  workspace: REPO,
  store: { useStore: (selector: (value: typeof agentState) => unknown) => selector(agentState) },
  workspaceReady: false,
  setWorkspaceReady: () => {},
  // 不预热其它项目（预热会去调 warm_workspace）
  appBooted: false,
} as never

const noop = (): void => {}

export default function SessionArchiveScenario(): ReactElement {
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <div style={{ display: 'flex', height: '100vh', background: 'var(--gren-content-bg)' }}>
        <div style={{ width: 260, height: '100%' }} data-testid="sidebar">
          <Sidebar
            runningSessionPaths={runningPaths}
            onNewConversation={noop}
            onOpenProject={noop}
            onNewSession={noop}
            onOpenSession={(cwd, path) => track(`open:${path}`)}
            onDeleteSession={(_cwd, path) => {
              track(`delete:${path}`)
              useSessionStore.getState().hideDeletedSession(path)
              deleted.add(path)
              archived.delete(path)
              syncFromDisk()
            }}
            onDeleteConversation={noop}
            onClearProjectSessions={noop}
            onRemoveProject={noop}
            onSubmitRename={noop}
            onArchiveSession={async (_cwd, path) => {
              if (await archiveSessionPaths([path], runningPaths)) syncFromDisk()
            }}
            onArchiveConversation={async (cwd) => {
              if (await archiveSessionPaths(conversationSessionPaths(cwd), runningPaths)) syncFromDisk()
            }}
            onUnarchiveSession={async (s) => {
              if (await unarchiveSessionPath(s.path)) syncFromDisk()
            }}
          />
        </div>
      </div>
    </AgentStoreContext.Provider>
  )
}
