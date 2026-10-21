import { type ReactElement } from 'react'
import { fallbackSessionTitle } from '@extensions/_shared/session-title'
import { Sidebar } from '../../src/features/sessions/Sidebar'
import { useSessionStore } from '../../src/store/session'
import { useSidebarPrefsStore } from '../../src/stores/sidebarPrefsStore'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import { initialAgentState } from '../../src/stores/agentReducer'
import { pi, type SessionInfo } from '../../src/lib/pi'
import { deferred, exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 会话标题：真实 Sidebar（行、右键菜单、「重新生成标题」的提示）+ 真实 fallbackSessionTitle。
 * 没有生成标题的会话，名字按主进程 workspaceService 的做法由首条用户消息兜底；首条消息的形状照真实会话：
 * 输入框的粘贴块、pi 展开的技能块、pi 给图片补的说明文字。
 * 主进程的 generate_session_title 用桩：每次返回一个由 probe 经 act 放行的 deferred，形状照 electron/app/sessionTitle.ts
 * （只回标题，给不出时是空串）。重新生成后的写回照 App.handleRegenerateTitle：拿到标题才改名。
 */

const REPO = 'D:/repo'

const PASTED_RAW = '<pi:attachment type="text" lines="45" chars="4194">\n我们要为客服模块（省心掌柜）的「正式模型通道」规划服务端设计。\n## 背景\n</pi:attachment>'
const SKILL_RAW = '<skill name="brainstorming" location="C:\\Users\\me\\.agents\\skills\\brainstorming\\SKILL.md">\nReferences are relative to C:\\Users\\me\\.agents\\skills\\brainstorming.\n\n# 头脑风暴\n</skill>\n\n规划套餐订购页 以模态框展示'
const IMAGE_RAW = '调整一下订单查询栏\n\n[Image: original 2559x1527, displayed at 2000x1193. Multiply coordinates by 1.28 to map to original image.]'

const session = (ts: string, name: string | null): SessionInfo => ({
  id: ts,
  path: `D:/s/repo/${ts}.jsonl`,
  cwd: REPO,
  timestamp: ts,
  name,
})

const PASTED = session('2026-10-19T08:00:00.000Z', fallbackSessionTitle(PASTED_RAW))
const SKILL = session('2026-10-19T07:00:00.000Z', fallbackSessionTitle(SKILL_RAW))
const IMAGE = session('2026-10-19T06:00:00.000Z', fallbackSessionTitle(IMAGE_RAW, 1))
// 以前的标题模型真实写进会话的坏标题
const LEGACY = session('2026-10-19T05:00:00.000Z', '# 生成标题')

const disk = [PASTED, SKILL, IMAGE, LEGACY]
const syncFromDisk = () => useSessionStore.getState().syncAllSessions(disk.map((s) => ({ ...s })))

let pending = deferred<string>()

installBridge({
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'generate_session_title':
        track(`generate:${args.sessionPath}`)
        return pending.promise
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
  subscribe: async () => () => {},
})

useSessionStore.setState({
  activeWorkspace: REPO,
  activeSessionPath: PASTED.path,
  allSessions: disk.map((s) => ({ ...s })),
  registeredProjects: [REPO],
})
useSidebarPrefsStore.setState({ collapsed: {}, pinnedSessions: [], pinnedConversations: [], pinnedProjects: [], hiddenProjects: [] })

exposeData({
  names: { PASTED: PASTED.name, SKILL: SKILL.name, IMAGE: IMAGE.name, LEGACY: LEGACY.name },
  paths: { LEGACY: LEGACY.path, SKILL: SKILL.path },
})

exposeActions({
  resolveTitle: (title: string) => {
    const current = pending
    pending = deferred<string>()
    current.resolve(title)
  },
  rejectTitle: (reason: string) => {
    const current = pending
    pending = deferred<string>()
    current.reject(new Error(reason))
  },
})

const agentState = initialAgentState()
const mockCtx = {
  workspace: REPO,
  store: { useStore: (selector: (value: typeof agentState) => unknown) => selector(agentState) },
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: false,
} as never

const noop = (): void => {}

export default function SessionTitleScenario(): ReactElement {
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <div style={{ display: 'flex', height: '100vh', background: 'var(--gren-content-bg)' }}>
        <div style={{ width: 260, height: '100%' }} data-testid="sidebar">
          <Sidebar
            runningSessionPaths={new Set()}
            onNewConversation={noop}
            onOpenProject={noop}
            onNewSession={noop}
            onOpenSession={(_cwd, path) => track(`open:${path}`)}
            onDeleteSession={noop}
            onDeleteConversation={noop}
            onClearProjectSessions={noop}
            onRemoveProject={noop}
            onSubmitRename={noop}
            onRegenerateTitle={async (_cwd, path) => {
              const title = await pi.generateSessionTitle(path)
              if (title) {
                track(`rename:${path}:${title}`)
                const target = disk.find((s) => s.path === path)
                if (target) target.name = title
                syncFromDisk()
              }
              return title
            }}
          />
        </div>
      </div>
    </AgentStoreContext.Provider>
  )
}
