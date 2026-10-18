import { useLayoutEffect, useRef, type ReactElement } from 'react'
import { App } from 'antd'
import { DockDndProvider } from '../../src/features/dock/DockDndProvider'
import { DockPanel } from '../../src/features/dock/DockPanel'
import { RightPanelShell } from '../../src/features/layout/PanelShells'
import { useSessionStore } from '../../src/store/session'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { initialAgentState, type AgentState } from '../../src/stores/agentReducer'
import { useDockStore } from '../../src/stores/dockStore'
import { useLayoutStore } from '../../src/stores/layoutStore'
import { exposeData, installBridge } from '../stubs'

/**
 * 右侧边栏跟着会话走：同一项目里两个会话 A / B，左边两个会话行（点击时写会话 store，
 * 与侧栏 handleOpenSession 写的字段相同），顶部「右栏」按钮走真实的 toggleRightPanel，
 * 右边是真实的 DockDndProvider（useDockSessionSwitch）+ RightPanelShell + DockPanel。
 * 启动页里点「文件」开出真实的 FileTreeBody，目录用内存桩。
 */

const ROOT = '/repo'
const SESSION_A = '/repo/.pi/sessions/a.jsonl'
const SESSION_B = '/repo/.pi/sessions/b.jsonl'

type Node = { dir: true } | { dir: false; content: string }
const fs = new Map<string, Node>()
fs.set(ROOT, { dir: true })
fs.set(`${ROOT}/src`, { dir: true })
fs.set(`${ROOT}/README.md`, { dir: false, content: '# 示例项目\n' })
for (let i = 0; i < 6; i++) fs.set(`${ROOT}/file-${i}.ts`, { dir: false, content: `export const n = ${i}\n` })

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'list_dir': {
        const target = String(args.dir ?? '') || ROOT
        const entries = [...fs.entries()]
          .filter(([path]) => parentOf(path) === target && path !== target)
          .map(([path, node]) => ({
            name: nameOf(path),
            path,
            isDir: node.dir,
            size: node.dir ? null : new TextEncoder().encode(node.content).length,
          }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
        return { dir: target, entries, truncated: false }
      }
      case 'read_file_view': {
        const node = fs.get(String(args.path))
        if (!node || node.dir) throw new Error('File does not exist')
        return { kind: 'text', content: node.content, size: new TextEncoder().encode(node.content).length, truncated: false }
      }
      case 'watch_workspace_dirs':
      case 'unwatch_workspace_dirs':
        return undefined
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

// 起点：停在会话 A，右栏收起，坞里什么都没有（不读上次运行留在 localStorage 的标签）。
useSessionStore.setState({ worksDir: '/works', activeWorkspace: ROOT, activeSessionPath: SESSION_A, draftConversationCwd: null })
useDockStore.setState({
  tabs: [],
  closedTabs: [],
  activeByRegion: { right: null, bottom: null },
  activeBySession: {},
  rightOpenBySession: {},
  rightFillBySession: {},
})
useLayoutStore.setState({ rightPanelOpen: false, rightPanelFill: false, rightPanelWidth: 480, sidebarOpen: false })

exposeData({ sessionA: SESSION_A, sessionB: SESSION_B })

const mockCtx = {
  workspace: ROOT,
  store: { useStore: (selector: (value: AgentState) => unknown) => selector(initialAgentState()) } as unknown as AgentStoreApi,
  workspaceReady: true,
  setWorkspaceReady: () => {},
  appBooted: true,
}

function SessionRow({ path, label, testId }: { path: string; label: string; testId: string }): ReactElement {
  const active = useSessionStore((s) => s.activeSessionPath === path)
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      onClick={() => {
        const st = useSessionStore.getState()
        st.clearDraftConversation()
        st.setActiveSession(path)
        st.setWorkspaceSessionPath(ROOT, path)
      }}
      style={{
        display: 'block',
        width: '100%',
        padding: '8px 12px',
        border: 0,
        borderRadius: 6,
        textAlign: 'left',
        background: active ? 'var(--gren-sidebar-active, rgba(127,127,127,0.2))' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

export default function DockSessionBinding(): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null)
  const setAvailableWidth = useLayoutStore((s) => s.setAvailableWidth)
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel)

  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    const update = () => setAvailableWidth(el.getBoundingClientRect().width)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [setAvailableWidth])

  return (
    <App>
      <AgentStoreContext.Provider value={mockCtx}>
        <div style={{ display: 'flex', height: '100vh', background: 'var(--gren-content-bg)' }}>
          <nav data-testid="sessions" style={{ width: 200, flex: 'none', padding: 8, borderRight: '1px solid rgba(127,127,127,0.2)' }}>
            <SessionRow path={SESSION_A} label="会话 A" testId="session-a" />
            <SessionRow path={SESSION_B} label="会话 B" testId="session-b" />
          </nav>
          <div ref={rowRef} style={{ display: 'flex', flex: 1, minWidth: 0 }}>
            <DockDndProvider>
              <div style={{ flex: 1, minWidth: 0, padding: 12 }}>
                <button type="button" data-testid="toggle-right" onClick={toggleRightPanel}>
                  右栏
                </button>
              </div>
              <RightPanelShell>
                <div data-testid="right-host" style={{ height: '100%' }}>
                  <DockPanel region="right" onCollapse={toggleRightPanel} />
                </div>
              </RightPanelShell>
            </DockDndProvider>
          </div>
        </div>
      </AgentStoreContext.Provider>
    </App>
  )
}
