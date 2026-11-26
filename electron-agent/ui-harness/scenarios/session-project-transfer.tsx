import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { App } from 'antd'
import { useEditor } from '@lobehub/editor/react'
import { Editor as LobeEditor } from '@lobehub/editor/react'
import { Sidebar } from '../../src/features/sessions/Sidebar'
import { SessionProjectTransferDialog } from '../../src/features/sessions/SessionProjectTransferDialog'
import { useSessionProjectTransferStore } from '../../src/features/sessions/sessionProjectTransferStore'
import { applyTransferOpened } from '../../src/features/sessions/sessionProjectTransferActions'
import { consumeTransferOpen } from '../../src/features/sessions/sessionProjectTransferScope'
import { AppLinkGuard } from '../../src/features/links/AppLinkGuard'
import { LazyMarkdown } from '../../src/features/chat/LazyMarkdown'
import { ChatInput } from '../../src/features/chat/ChatInput'
import { DockDndProvider } from '../../src/features/dock/DockDndProvider'
import { DockPanel } from '../../src/features/dock/DockPanel'
import { openLauncherTab } from '../../src/features/dock/openLauncherTab'
import { readComposerSnapshot } from '../../src/features/chat/input/composerBridge'
import { useChatDraftStore } from '../../src/stores/chatDraftStore'
import { useComposerFilesStore } from '../../src/features/chat/input/composerFiles'
import { binaryToImageAttachment } from '../../src/features/chat/input/editor/imageAttachment'
import { readComposerDraft } from '../../src/features/chat/input/editor/composerDraft'
import { INSERT_COMMAND_PILL_COMMAND } from '../../src/features/chat/input/editor/CommandPill/commands'
import { INSERT_CHAT_TAG_COMMAND } from '../../src/features/chat/input/editor/ChatTag/command'
import { CommandPillHostContext } from '../../src/features/chat/input/editor/CommandPill/hostContext'
import ReactChatTagPlugin from '../../src/features/chat/input/editor/ChatTag/ReactChatTagPlugin'
import ReactCommandPillPlugin from '../../src/features/chat/input/editor/CommandPill/ReactCommandPillPlugin'
import { useSessionStore } from '../../src/store/session'
import { useSidebarPrefsStore } from '../../src/stores/sidebarPrefsStore'
import { useDockStore } from '../../src/stores/dockStore'
import { useLayoutStore } from '../../src/stores/layoutStore'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import { initialAgentState, type AgentState } from '../../src/stores/agentReducer'
import { createAgentStore } from '../../src/stores/agent'
import { getSessionMutationEpoch, invalidateAllSessionsCache, isFreshResponse } from '../../src/lib/sessionCache'
import type { SessionInfo } from '../../src/lib/pi'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 会话跨项目移动（UI）：真实 Sidebar（两种会话行 + 共用菜单「移动到项目…」）、真实
 * SessionProjectTransferDialog（typed 合同：preview / commit / retry-open）、真实 ChatInput 与草稿 / 附件 store、
 * 真实 DockPanel + 文件管理器 / 终端。只有主进程 I/O 是桩。
 *
 * 数据：
 * - 源项目 D:/repo：要移动的「修复登录页」（当前会话、已置顶、有完整草稿）与留下的「重构订单查询」；
 * - 目标项目 D:/app：已有会话「目标项目已有会话」；
 * - 对话目录 C:/agent/works/c1 通过「对话」行只移动被点的那一份；另一个草稿 other 用来验证不串写。
 *
 * 迁移本身由 act 切换成 busy / stale / committed-needs-open / 带目录选择器的新目标；
 * 文件树、读文件、shell_start 用内存桩并记录使用的项目根；列表刷新由 probe 放行旧响应验证代次。
 */

const SOURCE = 'D:/repo'
const TARGET = 'D:/app'
const OTHER = 'C:/agent/works/c1'

const session = (cwd: string, name: string, ts: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id: `${cwd}-${ts}`,
  path: `${cwd === SOURCE ? 'D:/s/repo' : cwd === TARGET ? 'D:/s/app' : 'D:/s/c1'}/${ts}.jsonl`,
  cwd,
  timestamp: ts,
  name,
  ...extra,
})

const MOVED = session(SOURCE, '修复登录页', '2026-11-16T08:00:00.000Z')
const KEPT = session(SOURCE, '重构订单查询', '2026-11-15T08:00:00.000Z')
const TARGET_SESSION = session(TARGET, '目标项目已有会话', '2026-11-14T08:00:00.000Z')
const OTHER_DRAFT = 'draft:transfer-other'
const OTHER_DRAFT_TEXT = '另一个草稿不能被移动改写 @src/other.ts'
const IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const NEW_TARGET = 'D:/brand-new'
const THIRD_TARGET = 'D:/third'
/** 历史消息正文：相对链接只存在于源项目，目标项目里有同名文件。 */
const HISTORY_MARKDOWN = '历史记录：[源项目的笔记](src/notes.md)'

let disk: SessionInfo[] = [MOVED, KEPT, TARGET_SESSION]
let previewMode: 'preview' | 'busy' | 'noop' = 'preview'
let commitMode: 'opened' | 'stale' | 'needs-open' = 'opened'
let retryMode: 'opened' | 'needs-open' = 'opened'
let pickedDirectory: string | null = NEW_TARGET
let lastPreviewTarget = ''
const openedSessions: Array<{ workspace: string; sessionPath: string }> = []
const visitedRoots: string[] = []
let shellSeq = 0

const fileSystem = new Map<string, { dir?: boolean; content?: string }>()
for (const root of [SOURCE, TARGET, NEW_TARGET, THIRD_TARGET]) {
  fileSystem.set(root, { dir: true })
  fileSystem.set(`${root}/src`, { dir: true })
  fileSystem.set(`${root}/src/app.ts`, { content: `export const project = '${root}'\n` })
  fileSystem.set(`${root}/README.md`, { content: `# ${root}\n` })
}
// 历史链接指向源项目的 src/notes.md：迁移后源里已不存在，目标项目里却有同名文件。
// 点这条历史链接必须按源路径报缺失，不能去读目标同名项。
fileSystem.set(`${TARGET}/src/notes.md`, { content: '# 目标项目的同名笔记（不能被历史链接打开）\n' })
// 本场景不在源里建这份文件：历史链接要打开的那个源文件确实缺失。

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const model = {
  provider: 'fixture',
  id: 'transfer-model',
  name: 'Transfer Model',
  reasoning: true,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 8192,
}
const preferences = {
  revision: 0,
  model: { provider: model.provider, id: model.id },
  thinkingLevel: 'high',
  mode: 'agent',
  approval: 'ask',
}

installBridge({
  subscribe: async () => () => {},
  webview: { onDragDropEvent: async () => () => {} },
  pickDirectory: async () => pickedDirectory,
  window: {
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
  },
  openUrl: async () => {},
  openPath: async () => {},
  revealItemInDir: async () => {},
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'agent_session_project_transfer': {
        const action = String(args.action)
        if (action === 'preview') lastPreviewTarget = String(args.targetWorkspace ?? '')
        track(action === 'preview' ? `preview:${lastPreviewTarget}` : action === 'commit' ? `commit:${lastPreviewTarget}` : action === 'retry-open' ? `retry-open:${lastPreviewTarget}` : `${action}:`)
        const requestedPath = String(args.sessionPath ?? MOVED.path)
        const base = {
          sessionPath: requestedPath,
          sourceWorkspace: String(args.sourceWorkspace ?? SOURCE),
          sessionId: requestedPath,
          phase: 'previewed' as const,
        }
        if (action === 'preview') {
          if (previewMode === 'busy') {
            return { ...base, status: 'busy', busyReason: 'background-jobs', detail: '此会话仍有后台任务运行，请等待任务结束' }
          }
          if (previewMode === 'noop') return { ...base, status: 'no-op', reason: 'same-workspace', targetWorkspace: SOURCE }
          return {
            ...base,
            status: 'preview',
            operationId: 'op-transfer-1',
            ticket: 'ticket-transfer-1',
            targetWorkspace: String(args.targetWorkspace),
            targetName: '应用项目',
            leafId: null,
            revision: 'rev-1',
            expiresAt: 9_999_999_999_999,
            family: { sessionCount: 2, childSessionCount: 1, subagentCount: 1, registryRecordCount: 2 },
            policy: { fileTransfer: 'none', modelRequests: 0, permissionSource: 'target' },
            warnings: ['目标项目没有显式授权，将回退 Ask / 只读'],
          }
        }
        if (action === 'commit') {
          if (commitMode === 'stale') {
            return { ...base, status: 'stale', staleReason: 'session-changed', requiresPreview: true, operationId: 'op-transfer-1' }
          }
          if (commitMode === 'needs-open') {
            return {
              ...base,
              status: 'committed-needs-open',
              operationId: 'op-transfer-1',
              targetWorkspace: lastPreviewTarget,
              reason: '目标运行时启动失败',
              retryable: true,
            }
          }
          return { ...base, status: 'opened', operationId: 'op-transfer-1', targetWorkspace: lastPreviewTarget, leafId: null, phase: 'opened' }
        }
        if (action === 'retry-open') {
          if (retryMode === 'needs-open') {
            return { ...base, status: 'committed-needs-open', operationId: 'op-transfer-1', targetWorkspace: lastPreviewTarget || TARGET, reason: '仍然打不开', retryable: true }
          }
          return { ...base, status: 'opened', operationId: 'op-transfer-1', targetWorkspace: lastPreviewTarget || TARGET, leafId: null, phase: 'opened' }
        }
        throw new Error(`unknown transfer action ${action}`)
      }
      case 'list_all_sessions':
      case 'list_pi_sessions':
        track(`list:${String(command)}`)
        return disk.map((s) => ({ ...s }))
      case 'list_projects':
        return [SOURCE, TARGET, NEW_TARGET, THIRD_TARGET]
      case 'get_works_dir':
        return 'C:/agent/works'
      case 'warm_workspace':
      case 'enhance_prompt_abort':
      case 'watch_workspace_dirs':
      case 'unwatch_workspace_dirs':
        return undefined
      case 'get_settings':
        return { defaultSessionModel: 'fixture/transfer-model' }
      case 'get_provider_config':
        return {
          modelsJson: JSON.stringify({ providers: { fixture: { name: 'Fixture', api: 'openai-responses', apiKey: 'fixture', models: [model] } } }),
          authJson: '{}',
          agentDir: 'C:/agent',
        }
      case 'agent_get_available_models':
      case 'list_models_global':
        return { models: [model] }
      case 'get_model_fast_preferences':
        return {}
      case 'agent_get_session_defaults':
        return structuredClone(preferences)
      case 'agent_get_state':
        return { sessionFile: args.targetSessionPath, sessionPath: args.targetSessionPath, model, thinkingLevel: 'high', preferences: structuredClone(preferences), unavailable: [] }
      case 'agent_get_commands':
        return { commands: [] }
      case 'list_prompt_commands':
        return []
      case 'get_file_tree': {
        const root = String(args.workspace)
        visitedRoots.push(root)
        return {
          name: nameOf(root),
          path: root,
          kind: 'directory',
          children: [
            { name: 'src', path: `${root}/src`, kind: 'directory', children: [] },
            { name: 'README.md', path: `${root}/README.md`, kind: 'file' },
          ],
        }
      }
      case 'list_dir': {
        const root = String(args.workspace)
        const target = String(args.dir ?? '') || root
        visitedRoots.push(root)
        const entries = [...fileSystem.entries()]
          .filter(([path]) => parentOf(path) === target && path !== target)
          .map(([path, node]) => ({
            name: nameOf(path),
            path,
            isDir: Boolean(node.dir),
            size: node.dir ? null : new TextEncoder().encode(node.content ?? '').length,
          }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
        return { dir: target, entries, truncated: false }
      }
      case 'read_file_view': {
        const path = String(args.path)
        // 记下每一次真实读取（含 workspace 根），probe 用来断言没有读目标同名文件。
        track(`read:${String(args.workspace)}:${path}`)
        const node = fileSystem.get(path)
        if (!node || node.dir) throw new Error('File does not exist')
        return { kind: 'text', content: node.content ?? '', size: new TextEncoder().encode(node.content ?? '').length, truncated: false }
      }
      case 'write_file': {
        const path = String(args.path)
        fileSystem.set(path, { content: String(args.content ?? '') })
        track(`write:${path}`)
        return undefined
      }
      case 'get_git_status':
        return []
      case 'get_git_branches':
        return { current: 'main', branches: [{ name: 'main', current: true }] }
      case 'subagent_list':
        return []
      case 'shell_start': {
        shellSeq += 1
        track(`shell:${String(args.workspace ?? '')}`)
        return { session_id: `sh-${shellSeq}` }
      }
      case 'shell_write':
      case 'shell_resize':
      case 'shell_stop':
        return undefined
      case 'ui_history_read':
        return ''
      case 'ui_history_write':
        track(`history:${String(args.sessionKey)}`)
        return undefined
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

useSessionStore.setState({
  worksDir: 'C:/agent/works',
  activeWorkspace: SOURCE,
  activeSessionPath: MOVED.path,
  allSessions: disk,
  sessions: [MOVED, KEPT],
  registeredProjects: [SOURCE, TARGET],
  optimisticSessions: [],
  workspaceSessionPaths: { [SOURCE]: MOVED.path },
  deletedSessionPaths: [],
  deletedConversationCwds: [],
})
useSidebarPrefsStore.setState({
  collapsed: { [SOURCE]: false, [TARGET]: false },
  collapsedSections: {},
  pinnedSessions: [MOVED.path],
  pinnedConversations: [],
  pinnedProjects: [],
  hiddenProjects: [],
  keptProjects: [SOURCE, TARGET],
  aliases: { [TARGET]: '应用项目' },
})
useDockStore.setState({
  tabs: [],
  closedTabs: [],
  activeByRegion: { right: null, bottom: null },
  activeBySession: {},
  rightOpenBySession: {},
  rightFillBySession: {},
})
useLayoutStore.setState({ rightPanelOpen: true, rightPanelFill: false, terminalOpen: true, rightPanelWidth: 520, terminalHeight: 200, sidebarOpen: true })

useChatDraftStore.setState({ drafts: { [OTHER_DRAFT]: { text: OTHER_DRAFT_TEXT } }, adoptions: {}, removed: {} })
useComposerFilesStore.setState({ byKey: {}, adoptions: {}, removed: {} })
useComposerFilesStore
  .getState()
  .addAttachments(MOVED.path, [binaryToImageAttachment('snap.png', 'image/png', IMAGE_B64)])
useComposerFilesStore.getState().addPastedText(MOVED.path, {
  id: 'paste-1',
  text: '粘贴的构建日志\n第二行',
  lines: 2,
  chars: 12,
  label: '构建日志',
})

exposeData({
  SOURCE,
  TARGET,
  OTHER,
  NEW_TARGET,
  THIRD_TARGET,
  MOVED: MOVED.path,
  KEPT: KEPT.path,
  TARGET_SESSION: TARGET_SESSION.path,
  OTHER_DRAFT,
  OTHER_DRAFT_TEXT,
  IMAGE_B64,
})

/** 一次迁移打开：列表投影、workspace store 失效、打开目标会话（与 App 的 handleTransferOpened 同义）。 */
function openAfterTransfer(result: { sourceWorkspace: string; targetWorkspace: string; sessionPath: string }) {
  applyTransferOpened(result)
  const st = useSessionStore.getState()
  st.setActiveSession(result.sessionPath)
  st.setWorkspaceSessionPath(result.targetWorkspace, result.sessionPath)
  if (st.activeWorkspace !== result.targetWorkspace) st.setActiveWorkspace(result.targetWorkspace)
  openedSessions.push({ workspace: result.targetWorkspace, sessionPath: result.sessionPath })
  track(`opened:${result.targetWorkspace}:${result.sessionPath}`)
  disk = disk.map((s) => (s.path === result.sessionPath ? { ...s, cwd: result.targetWorkspace } : s))
  // 拖拽后的钉住：把内存里的全量列表也换成同一份（不依赖下一次 list 回包）。
  useSessionStore.setState((state) => ({
    allSessions: state.allSessions.map((s) => (s.path === result.sessionPath ? { ...s, cwd: result.targetWorkspace } : s)),
  }))
  invalidateAllSessionsCache()
}

let remountChat: () => void = () => {}
let mountComposer: () => void = () => {}
let seedEditor: ReturnType<typeof useEditor> | null = null

exposeActions({
  /** 用真实编辑器生成胶囊 + 文件标签 + 正文的完整 composer JSON，写进本会话草稿。 */
  seedDraft: async () => {
    const editor = seedEditor
    if (!editor) return null
    editor.focus()
    editor.cleanDocument()
    editor.dispatchCommand(INSERT_COMMAND_PILL_COMMAND, {
      name: 'refactor',
      params: [{ name: 'file' }, { name: 'style', defaultValue: 'functional' }],
      values: ['src/app.ts'],
    })
    editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, { category: 'file', label: 'app.ts', value: 'src/app.ts' })
    // dispatchCommand 进的是 lexical 的更新队列：等两帧再读，拿到的才是已落进 editorState 的整份草稿。
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const draft = readComposerDraft(editor)
    useChatDraftStore.getState().setDraft(MOVED.path, draft)
    return { text: draft.text, json: draft.json, hasJson: Boolean(draft.json) }
  },
  readComposer: () => ({
    snapshot: readComposerSnapshot(),
    draft: useChatDraftStore.getState().getDraft(MOVED.path),
    images: (useComposerFilesStore.getState().byKey[MOVED.path]?.attachments ?? []).length,
    pastes: (useComposerFilesStore.getState().byKey[MOVED.path]?.pastedTexts ?? []).map((p) => p.text),
    otherDraft: useChatDraftStore.getState().getDraft(OTHER_DRAFT).text,
  }),
  remountComposer: () => remountChat(),
  mountComposer: () => mountComposer(),
  openTransferDialog: (sessionPath?: string) => {
    const path = sessionPath ?? MOVED.path
    const meta = useSessionStore.getState().allSessions.find((s) => s.path === path)
    useSessionProjectTransferStore.getState().open({
      sourceWorkspace: meta?.cwd ?? SOURCE,
      sessionPath: path,
      title: meta?.name ?? '会话',
    })
  },
  closeTransferDialog: () => useSessionProjectTransferStore.getState().close(),
  nextPreview: (mode: 'preview' | 'busy' | 'noop') => {
    previewMode = mode
  },
  nextCommit: (mode: 'opened' | 'stale' | 'needs-open') => {
    commitMode = mode
  },
  nextRetry: (mode: 'opened' | 'needs-open') => {
    retryMode = mode
  },
  nextPick: (dir: string | null) => {
    pickedDirectory = dir
  },
  openFiles: () => openLauncherTab({ region: 'right', kind: 'file', workspace: useSessionStore.getState().activeWorkspace }),
  /** 会话被移动后，ActiveWorkspace 之类的上层会换 workspace；这里只给 probe 换项目，不迁移。 */
  setWorkspaceForProbe: (workspace: string) => {
    useSessionStore.getState().setActiveWorkspace(workspace)
  },
  openTerminal: () => openLauncherTab({ region: 'bottom', kind: 'terminal', workspace: useSessionStore.getState().activeWorkspace }),
  dockSnapshot: () =>
    useDockStore.getState().tabs.map((tab) => ({ id: tab.id, kind: tab.kind, payload: tab.payload, owner: tab.ownerSessionPath ?? null })),
  /** 旧列表代次：按 sessionCache 的真实规则判断是否应用（迁移成功会 bump 代次）。 */
  applyListAt: (sessions: SessionInfo[], startedEpoch: number) => {
    if (!isFreshResponse(startedEpoch)) return { applied: false }
    useSessionStore.getState().syncAllSessions(sessions)
    return { applied: true }
  },
  currentEpoch: () => getSessionMutationEpoch(),
  allSessions: () => useSessionStore.getState().allSessions.map((s) => ({ path: s.path, cwd: s.cwd, name: s.name })),
  workspaceSessionPaths: () => ({ ...useSessionStore.getState().workspaceSessionPaths }),
  pinned: () => useSidebarPrefsStore.getState().pinnedSessions.slice(),
  visitedRoots: () => visitedRoots.slice(),
  openedSessions: () => openedSessions.slice(),
  storage: () => ({ drafts: Object.keys(useChatDraftStore.getState().drafts), files: Object.keys(useComposerFilesStore.getState().byKey) }),
})

/** 与 App 的切工作区 effect 同义：迁移这一跳跳过 dock 重置，普通切换才重置。 */
function WorkspaceSwitch(): null {
  const workspace = useSessionStore((s) => s.activeWorkspace)
  const previous = useRef(workspace)
  useEffect(() => {
    if (previous.current === workspace) return
    previous.current = workspace
    if (!consumeTransferOpen(workspace)) {
      track(`reset-tabs:${workspace}`)
      useDockStore.getState().resetWorkspaceTabs()
    } else {
      track(`keep-tabs:${workspace}`)
    }
  }, [workspace])
  return null
}

/** 真实编辑器 + 同一套插件：只用来产出真实 composer JSON，不参与被测交互。 */
function SeedComposer({ onReady }: { onReady: (editor: ReturnType<typeof useEditor>) => void }): ReactElement {
  const editor = useEditor()
  const host = useMemo(() => ({ submit: () => {} }), [])
  useEffect(() => {
    onReady(editor)
  }, [editor, onReady])
  return (
    <div
      aria-hidden
      data-testid="seed-composer"
      style={{ position: 'fixed', left: -4000, top: 0, width: 560, height: 160, overflow: 'hidden', pointerEvents: 'none' }}
    >
      <CommandPillHostContext.Provider value={host}>
        <LobeEditor
          editor={editor}
          content=""
          type="text"
          variant="chat"
          pasteAsPlainText
          enablePasteMarkdown={false}
          markdownOption={false}
          plugins={[ReactChatTagPlugin, ReactCommandPillPlugin]}
        />
      </CommandPillHostContext.Provider>
    </div>
  )
}

const realStores = new Map<string, ReturnType<typeof createAgentStore>>()
function realStoreOf(workspace: string) {
  const existing = realStores.get(workspace)
  if (existing) return existing
  const created = createAgentStore(workspace)
  realStores.set(workspace, created)
  return created
}

/** 真实 agent store：DockPanel / ChatInput 会读它的缓存与加载状态；不发送，不会发模型请求。 */
function mockContext(workspace: string, _state: AgentState = initialAgentState()) {
  return {
    workspace,
    store: realStoreOf(workspace),
    workspaceReady: true,
    setWorkspaceReady: () => {},
    appBooted: true,
  } as never
}

function ScenarioInner(): ReactElement {
  const workspace = useSessionStore((s) => s.activeWorkspace)
  const [generation, setGeneration] = useState(0)
  // 先不挂输入框：草稿要先由真实编辑器种进去，否则首挂时的空草稿会把种子覆盖掉。
  const [composerMounted, setComposerMounted] = useState(false)
  useEffect(() => {
    remountChat = () => setGeneration((n) => n + 1)
    mountComposer = () => setComposerMounted(true)
    return () => {
      remountChat = () => {}
      mountComposer = () => {}
    }
  }, [])
  const ctx = useMemo(() => mockContext(workspace), [workspace])

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--gren-content-bg)' }}>
      <AgentStoreContext.Provider value={ctx}>
        <div style={{ width: 260, height: '100%', flex: 'none', display: 'flex', flexDirection: 'column' }} data-testid="sidebar">
          <Sidebar
            runningSessionPaths={new Set<string>()}
            onNewConversation={() => track('new-conversation')}
            onOpenProject={() => track('open-project')}
            onNewSession={() => track('new-session')}
            onOpenSession={(cwd, path) => {
              const st = useSessionStore.getState()
              st.clearDraftConversation()
              st.setActiveSession(path)
              st.setWorkspaceSessionPath(cwd, path)
              st.setActiveWorkspace(cwd)
              track(`open-session:${path}`)
            }}
            onDeleteSession={() => track('delete-session')}
            onDeleteConversation={() => track('delete-conversation')}
            onClearProjectSessions={() => track('clear-project')}
            onRemoveProject={() => track('remove-project')}
            onSubmitRename={() => track('rename')}
            onTransferSession={(cwd, path, title) => {
              useSessionProjectTransferStore.getState().open({ sourceWorkspace: cwd, sessionPath: path, title })
              track(`transfer-menu:${path}`)
            }}
          />
        </div>
        <div style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <div
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
              data-testid="chat-column"
              data-workspace={workspace}
            >
              <div style={{ flex: 1, minHeight: 0, padding: 16 }} data-testid="history-message" data-source-cwd={SOURCE}>
                {/* 真实历史消息投影：sourceCwd 是迁移前的项目根，正文里的相对链接按它解析。 */}
                <LazyMarkdown variant="chat">{HISTORY_MARKDOWN}</LazyMarkdown>
              </div>
              <div style={{ padding: 12 }}>
                {composerMounted ? (
                  <ChatInput key={`${workspace}:${generation}`} onSend={() => track('send')} onAbort={() => {}} />
                ) : null}
              </div>
            </div>
            <div style={{ width: 520, flex: 'none', display: 'flex', minHeight: 0 }} data-testid="right-host">
              <DockDndProvider>
                <DockPanel region="right" />
              </DockDndProvider>
            </div>
          </div>
          <div style={{ height: 200, flex: 'none', display: 'flex', minHeight: 0 }} data-testid="bottom-host">
            <DockDndProvider>
              <DockPanel region="bottom" />
            </DockDndProvider>
          </div>
        </div>
      </AgentStoreContext.Provider>
      <AppLinkGuard />
      <WorkspaceSwitch />
      <SessionProjectTransferDialog
        onOpened={async (result) => openAfterTransfer(result)}
        onRetryOpened={async (result) => openAfterTransfer(result)}
        onNeedsRefresh={() => track('refresh-after-needs-open')}
      />
      <SeedComposer
        onReady={(editor) => {
          seedEditor = editor
        }}
      />
    </div>
  )
}

export default function SessionProjectTransferScenario(): ReactElement {
  return (
    <App>
      <ScenarioInner />
    </App>
  )
}
