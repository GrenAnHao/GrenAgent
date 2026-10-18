import { useMemo, type ReactElement } from 'react'
import { App } from 'antd'
import { ProjectHeaderRow } from '../../src/features/sessions/ProjectHeaderRow'
import { buildProjectGroups } from '../../src/features/sessions/useProjectGroups'
import { IsolatedWorkspaceDialogs } from '../../src/features/isolatedWorkspace/IsolatedWorkspaceDialogs'
import { useIsolatedWorkspaceStore } from '../../src/stores/isolatedWorkspaceStore'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import { WorkspaceBar } from '../../src/features/chat/input/workspace/WorkspaceBar'
import type { SessionInfo } from '../../src/lib/pi'
import { initialAgentState } from '../../src/stores/agentReducer'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 独立工作区（A 轨）的界面：真实 buildProjectGroups → ProjectHeaderRow（侧栏项目行），真实 IsolatedWorkspaceDialogs
 * （新建 / 管理 / 只读查看）。主进程只有 isolated_workspace_* 、get_settings、subagent_get_session_messages 用桩，
 * 返回形状照 electron/app/isolatedWorkspaceService.ts。
 *
 * 数据：主仓 D:/repo 下两个独立工作区，aaa11111 在、bbb22222 已删除（只剩会话）；另一个普通项目 D:/other。
 * 管理弹窗里 aaa11111 有一个没回传的提交，ccc33333 已回传。
 */

const REPO = 'D:/repo'
const W_LIVE = 'D:/repo/.gren/worktrees/aaa11111'
const W_GONE = 'D:/repo/.gren/worktrees/bbb22222'
const W_SYNCED = 'D:/repo/.gren/worktrees/ccc33333'

const session = (cwd: string, ts: string, name: string): SessionInfo => ({ id: `${cwd}-${ts}`, path: `${cwd}/${ts}.jsonl`, cwd, timestamp: ts, name })
const SESSIONS = [
  session('D:/other', '2026-10-17T09:00:00Z', '别的项目'),
  session(REPO, '2026-10-16T09:00:00Z', '主仓会话'),
  session(W_LIVE, '2026-10-18T09:00:00Z', '修登录'),
  session(W_GONE, '2026-10-15T09:00:00Z', '旧的试验'),
]

const marker = (id: string, path: string, kind: 'fresh' | 'head') => ({
  version: 1, id, path, parentRoot: REPO, branch: `gren/${id}`,
  base: { kind, ref: kind === 'fresh' ? 'origin/main' : 'main', commit: `${id}deadbeefcafe` },
  createdAt: '2026-10-18T08:00:00.000Z', createdBy: 'grenagent',
})
let entries = [
  { ...marker('aaa11111', W_LIVE, 'fresh'), exists: true },
  { ...marker('ccc33333', W_SYNCED, 'head'), exists: true },
]
const STATES: Record<string, unknown> = {
  aaa11111: { id: 'aaa11111', exists: true, dirty: false, ahead: 1, synced: false, lastActivity: '2026-10-18T09:00:00.000Z' },
  ccc33333: { id: 'ccc33333', exists: true, dirty: false, ahead: 2, synced: true, lastActivity: '2026-10-18T09:00:00.000Z' },
}
/** 第一次 fresh 创建按「仓库没有 remote」失败，之后成功。 */
let failNextFresh = true

const READONLY_MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '把旧的试验跑一遍' }], timestamp: 1 },
  { role: 'assistant', content: [{ type: 'text', text: '试验跑完了，结果都在这份副本里。' }], timestamp: 2 },
]

installBridge({
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'get_settings':
        return { isolatedWorkspaceFetch: '1' }
      case 'isolated_workspace_probe': {
        const paths = args.paths as string[]
        return Object.fromEntries(paths.map((p) => [p, p === W_GONE ? 'missing' : p.includes('/.gren/') ? 'active' : 'none']))
      }
      case 'isolated_workspace_create': {
        track(`create:${JSON.stringify({ base: args.base, fetch: args.fetch ?? false, carry: args.carryChanges ?? false })}`)
        if (args.base === 'fresh' && failNextFresh) {
          failNextFresh = false
          throw new Error("Error invoking remote method 'gren:invoke': Error: 仓库没有 remote，取不到远端默认分支；可以改选「基于当前 HEAD」")
        }
        return marker('ddd44444', 'D:/repo/.gren/worktrees/ddd44444', (args.base as 'fresh' | 'head') ?? 'fresh')
      }
      case 'isolated_workspace_list':
        return entries
      case 'isolated_workspace_state':
        return STATES[args.id as string]
      case 'isolated_workspace_remove': {
        track(`remove:${args.id}:${args.force ? 'force' : 'plain'}`)
        entries = entries.filter((e) => e.id !== args.id)
        return { removed: true }
      }
      case 'isolated_workspace_sync_back':
        track(`sync:${args.id}`)
        return { branch: `gren/${args.id}`, commit: '1234567890abcdef' }
      case 'subagent_get_session_messages':
        return { messages: READONLY_MESSAGES }
      // WorkspaceBar 的分支 / 改动 / 后台任务：给空数据就够
      case 'get_git_status':
        return []
      case 'get_git_branches':
        return { current: 'gren/aaa11111', branches: [{ name: 'gren/aaa11111', isCurrent: true, upstream: null, ahead: 0, behind: 0 }] }
      case 'job_list':
      case 'jobs_list':
        return []
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
  subscribe: async () => () => {},
})

const store = useIsolatedWorkspaceStore.getState()
exposeActions({
  openManage: (focusId?: string) => store.openManage(REPO, focusId),
  openViewer: () => store.openViewer(`${W_GONE}/2026-10-15T09:00:00Z.jsonl`, '旧的试验'),
  probe: () => store.refreshKinds([W_LIVE, W_GONE]),
})
exposeData({ W_LIVE, W_GONE, REPO })

// 只读查看里的消息组件会读当前会话 store：给一份空状态（同 subagent-conversation 场景）。
const agentState = initialAgentState()
const mockCtx = {
  workspace: REPO,
  store: { useStore: (selector: (value: typeof agentState) => unknown) => selector(agentState) },
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
} as never
const noop = (): void => {}

function Rows(): ReactElement {
  const groups = useMemo(
    () => buildProjectGroups(SESSIONS, {
      current: '', pinnedProjects: [], hiddenProjects: [], aliases: {}, keyword: '', worksDir: '', registeredProjects: [],
    }),
    [],
  )
  return (
    <div style={{ width: 260 }} data-testid="rows">
      {groups.map((group) => (
        <div key={group.cwd} data-cwd={group.cwd}>
          <ProjectHeaderRow
            group={group}
            expanded={false}
            onToggleExpand={noop}
            onNewInProject={(cwd) => track(`new:${cwd}`)}
            onPinProject={noop}
            onRevealProject={noop}
            onRenameProject={noop}
            onHideProject={noop}
            onClearProjectSessions={noop}
            onRemoveProject={noop}
          />
        </div>
      ))}
    </div>
  )
}

export default function IsolatedWorkspaceScenario(): ReactElement {
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <App>
        <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)' }}>
          <Rows />
          {/* 输入框下面的工作区栏：停在独立工作区 aaa11111 里 */}
          <AgentStoreContext.Provider value={{ ...(mockCtx as object), workspace: W_LIVE } as never}>
            <div style={{ width: 640, marginTop: 24 }} data-testid="bar">
              <WorkspaceBar />
            </div>
          </AgentStoreContext.Provider>
          <IsolatedWorkspaceDialogs
            openProject={async (dir) => track(`open:${dir}`)}
            onDeleted={(path, parent) => track(`deleted:${path}:${parent}`)}
          />
        </div>
      </App>
    </AgentStoreContext.Provider>
  )
}
