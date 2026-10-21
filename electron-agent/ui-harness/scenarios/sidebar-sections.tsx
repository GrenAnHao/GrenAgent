import { type ReactElement } from 'react'
import { Sidebar } from '../../src/features/sessions/Sidebar'
import { useSessionStore } from '../../src/store/session'
import { useSidebarPrefsStore } from '../../src/stores/sidebarPrefsStore'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import { initialAgentState } from '../../src/stores/agentReducer'
import type { SessionInfo } from '../../src/lib/pi'
import { exposeData, installBridge, track } from '../stubs'

/**
 * 侧栏最顶层分区折叠：真实 Sidebar（useSidebarItems → SidebarSectionHeader、会话菜单、置顶）+ 真实 sidebarPrefsStore
 * （persist 写 localStorage 的 pi-sidebar）。新建对话 / 新建项目只记事件。
 *
 * 数据：项目 D:/repo 三份会话（「整理依赖」已置顶）、项目 D:/shop 一份会话（不是当前项目，默认收起），
 * 对话 works/c1「写周报」、works/c2「翻译文档」。
 */

const WORKS = 'C:/agent/works'
const REPO = 'D:/repo'
const SHOP = 'D:/shop'

const session = (cwd: string, ts: string, name: string): SessionInfo => ({
  id: ts,
  path: `D:/s/${cwd.split('/').pop()}/${ts}.jsonl`,
  cwd,
  timestamp: ts,
  name,
})

const LOGIN = session(REPO, '2026-10-19T08:00:00.000Z', '修复登录页')
const REFACTOR = session(REPO, '2026-10-18T08:00:00.000Z', '重构订单查询')
const DEPS = session(REPO, '2026-10-17T08:00:00.000Z', '整理依赖')
const PAY = session(SHOP, '2026-10-16T08:00:00.000Z', '支付回调')
const WEEKLY = session(`${WORKS}/c1`, '2026-10-15T08:00:00.000Z', '写周报')
const TRANSLATE = session(`${WORKS}/c2`, '2026-10-14T08:00:00.000Z', '翻译文档')

installBridge({
  invoke: async (command: string) => {
    switch (command) {
      // 悬停在会话行上停住会预热那个工作区
      case 'warm_workspace':
        return undefined
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
  subscribe: async () => () => {},
})

localStorage.removeItem('pi-sidebar')
useSessionStore.setState({
  worksDir: WORKS,
  activeWorkspace: REPO,
  activeSessionPath: LOGIN.path,
  allSessions: [LOGIN, REFACTOR, DEPS, PAY, WEEKLY, TRANSLATE],
  registeredProjects: [REPO, SHOP],
})
useSidebarPrefsStore.setState({
  collapsed: {},
  collapsedSections: {},
  pinnedSessions: [DEPS.path],
  pinnedConversations: [],
  pinnedProjects: [],
  hiddenProjects: [],
})

exposeData({ paths: { LOGIN: LOGIN.path, REFACTOR: REFACTOR.path, DEPS: DEPS.path } })

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
const running = new Set<string>()

export default function SidebarSectionsScenario(): ReactElement {
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <div style={{ display: 'flex', height: '100vh', background: 'var(--gren-content-bg)' }}>
        <div style={{ width: 260, height: '100%' }} data-testid="sidebar">
          <Sidebar
            runningSessionPaths={running}
            onNewConversation={() => track('new-conversation')}
            onOpenProject={() => track('open-project')}
            onNewSession={noop}
            onOpenSession={(_cwd, path) => track(`open:${path}`)}
            onDeleteSession={noop}
            onDeleteConversation={noop}
            onClearProjectSessions={noop}
            onRemoveProject={noop}
            onSubmitRename={noop}
          />
        </div>
      </div>
    </AgentStoreContext.Provider>
  )
}
