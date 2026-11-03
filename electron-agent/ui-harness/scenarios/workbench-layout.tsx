import { App } from 'antd';
import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react';
import { MainChatColumn } from '../../src/features/layout/MainChatColumn';
import { ModuleRail } from '../../src/features/layout/ModuleRail';
import { Sidebar } from '../../src/features/sessions/Sidebar';
import { useSessionStore } from '../../src/store/session';
import { AgentStoreContext } from '../../src/stores/AgentStoreContext';
import { createAgentStore } from '../../src/stores/agent';
import { applyEvent, initialAgentState } from '../../src/stores/agentReducer';
import { useSidebarPrefsStore } from '../../src/stores/sidebarPrefsStore';
import { useChatDraftStore } from '../../src/stores/chatDraftStore';
import { useComposerFilesStore } from '../../src/features/chat/input/composerFiles';
import { setComposerValue } from '../../src/features/chat/input/composerBridge';
import { readComposerOwnerKey } from '../../src/features/chat/input/composerOwner';
import { draftOwnerKey } from '../../src/lib/sessionPreferences';
import type { AgentEvent, SessionInfo } from '../../src/lib/pi';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

// 正式 Sidebar / MainChatColumn / ChatView / ChatInput，只把宿主读写替换为确定性数据。
const WORKSPACE = 'D:/workbench';
const OTHER = 'D:/catalog';
const WORKS = 'C:/agent/works';
const A: SessionInfo = { id: 'layout-a', path: 'D:/sessions/layout-a.jsonl', cwd: WORKSPACE, timestamp: '2026-10-29T08:00:00.000Z', name: '整理发布计划' };
const B: SessionInfo = { id: 'layout-b', path: 'D:/sessions/layout-b.jsonl', cwd: WORKSPACE, timestamp: '2026-10-28T08:00:00.000Z', name: '检查登录流程' };
const C: SessionInfo = { id: 'layout-c', path: 'D:/sessions/layout-c.jsonl', cwd: OTHER, timestamp: '2026-10-27T08:00:00.000Z', name: '整理商品目录' };
const CONVERSATION: SessionInfo = { id: 'layout-chat', path: 'D:/sessions/layout-chat.jsonl', cwd: `${WORKS}/chat`, timestamp: '2026-10-26T08:00:00.000Z', name: '起草项目周报' };
const model = { provider: 'fixture', id: 'workbench-model', name: 'Workbench Model', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 };
const preferences = { revision: 0, model: { provider: model.provider, id: model.id }, thinkingLevel: 'high', mode: 'agent', approval: 'ask' };
const LAST_LINE = '工作台布局验证：最后一行完整可见。';
const DRAFT = '继续检查工作台布局';
const RENAMED_B = '检查登录流程（已重命名）';
const LONG_TITLE = '核对发布前的会话标题、操作入口与窄屏显示，确保长标题完整保留且不会挤出工具栏。'.repeat(8);
const DRAFT_ID = 'workbench-header-draft';
const NEW_DRAFT_ID = 'workbench-bottom-new-draft';
const RESTORED_DRAFT = '切换草稿和重新挂载后仍保留的正文';
const NEW_DRAFT_TEXT = '新建对话待发送内容';
const CROWDED_DRAFT = '尚未发送的工作台草稿';

installBridge({
  subscribe: async () => () => {},
  webview: { onDragDropEvent: async () => () => {} },
  window: {
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => track('window:minimize'),
    toggleMaximize: async () => track('window:maximize'),
    close: async () => track('window:close'),
  },
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'warm_workspace': case 'enhance_prompt_abort': return undefined;
      case 'get_settings': return { defaultSessionModel: 'fixture/workbench-model' };
      case 'get_provider_config': return { modelsJson: JSON.stringify({ providers: { fixture: { name: 'Fixture', api: 'openai-responses', apiKey: 'fixture', models: [model] } } }), authJson: '{}', agentDir: 'C:/agent' };
      case 'agent_get_available_models': case 'list_models_global': return { models: [model] };
      case 'get_model_fast_preferences': return {};
      case 'agent_get_session_defaults': return structuredClone(preferences);
      case 'agent_get_state': return { sessionFile: args.targetSessionPath || A.path, sessionPath: args.targetSessionPath || A.path, model, thinkingLevel: 'high', preferences: structuredClone(preferences), unavailable: [] };
      case 'get_git_branches': return { current: 'main', branches: [{ name: 'main', current: true }] };
      case 'get_git_status': case 'subagent_list': return [];
      case 'get_file_tree': return { name: 'workbench', path: WORKSPACE, kind: 'directory', children: [] };
      case 'agent_get_commands': return { commands: [] };
      case 'list_prompt_commands': return [];
      default: throw new Error(`unstubbed invoke: ${command}`);
    }
  },
});

// Titlebar 在模块初始化时捕获窗口桥，等桩安装后再加载真实组件。
const Titlebar = lazy(async () => ({ default: (await import('../../src/components/Titlebar')).Titlebar }));

localStorage.removeItem('pi-sidebar');
useSidebarPrefsStore.setState({ collapsed: {}, collapsedSections: {}, pinnedSessions: [], pinnedConversations: [], pinnedProjects: [], hiddenProjects: [], aliases: { [WORKSPACE]: '专业工作台' } });
useSessionStore.setState({ worksDir: WORKS, activeWorkspace: WORKSPACE, activeSessionPath: A.path, draftConversationCwd: null, draftConversationId: null, allSessions: [A, B, C, CONVERSATION], registeredProjects: [WORKSPACE, OTHER], isLoading: false, allSessionsLoading: false });
const store = createAgentStore(WORKSPACE);
store.bindSessionPath(A.path);
const running = new Set<string>();
const noop = (): void => {};
let remountMainChatColumn = noop;
let resizeFixtureSidebar: (width: number) => void = noop;

exposeData({ WORKSPACE, OTHER, sessionA: A.path, sessionB: B.path, titleA: A.name, titleB: B.name, conversationTitle: CONVERSATION.name, LAST_LINE, DRAFT, RENAMED_B, LONG_TITLE, DRAFT_ID, NEW_DRAFT_ID, RESTORED_DRAFT, NEW_DRAFT_TEXT, CROWDED_DRAFT });
exposeActions({
  renameHeaderSession: (path: string, name: string) => {
    const sessions = useSessionStore.getState();
    sessions.setAllSessions(sessions.allSessions.map((session) => session.path === path ? { ...session, name } : session));
  },
  headerDraft: (draftId: string = DRAFT_ID) => {
    const sessions = useSessionStore.getState();
    sessions.setDraftConversation(WORKSPACE, draftId);
    sessions.setActiveSession('');
  },
  headerSessionA: () => {
    const sessions = useSessionStore.getState();
    sessions.clearDraftConversation();
    sessions.setActiveSession(A.path);
  },
  remountChat: () => remountMainChatColumn(),
  sidebarWidth: (width: number) => resizeFixtureSidebar(width),
  empty: () => store.useStore.setState(initialAgentState(), true),
  crowdedDraft: () => {
    const key = readComposerOwnerKey(WORKSPACE);
    useComposerFilesStore.getState().restore(key, {
      attachments: [],
      pastedTexts: Array.from({ length: 12 }, (_, index) => ({ id: `layout-paste-${index}`, text: '确定性的粘贴内容\n'.repeat(30), lines: 30, chars: 270, label: `工作台检查资料 ${index + 1}` })),
    });
    setComposerValue(CROWDED_DRAFT);
  },
  conversation: () => {
    let state = initialAgentState();
    const message = { role: 'assistant', timestamp: 1793260800000, content: [{ type: 'text', text: `${Array.from({ length: 32 }, (_, i) => `第 ${i + 1} 项检查：侧栏保持清楚的项目与会话层级，输入区和对话内容各自留出阅读空间。`).join('\n\n')}\n\n${LAST_LINE}` }] };
    for (const event of [{ type: 'message_start', message }, { type: 'message_end', message }, { type: 'agent_end', messages: [message] }]) {
      state = applyEvent(state, event as unknown as AgentEvent);
    }
    store.useStore.setState(state, true);
  },
});

export default function WorkbenchLayoutScenario(): ReactElement {
  const [ready, setReady] = useState(false);
  const [chatGeneration, setChatGeneration] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  useEffect(() => {
    remountMainChatColumn = () => setChatGeneration((generation) => generation + 1);
    resizeFixtureSidebar = setSidebarWidth;
    // harness 复跑会复用浏览器存档；只清理此场景自己的 owner，等 IndexedDB 恢复后再挂输入框。
    void Promise.resolve(useComposerFilesStore.persist.rehydrate()).then(() => {
      for (const key of [WORKSPACE, A.path, B.path, draftOwnerKey(DRAFT_ID), draftOwnerKey(NEW_DRAFT_ID)]) {
        useComposerFilesStore.getState().clear(key);
        useChatDraftStore.getState().clearDraft(key);
      }
      setReady(true);
    });
    return () => { remountMainChatColumn = noop; resizeFixtureSidebar = noop; store.destroy(); };
  }, []);
  if (!ready) return <div />;
  return (
    <App style={{ height: '100vh' }}>
      <AgentStoreContext.Provider value={{ workspace: WORKSPACE, store, workspaceReady: true, setWorkspaceReady: noop, appBooted: true }}>
        <div data-testid="workbench-layout" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--gren-content-bg)' }}>
          <Suspense fallback={null}><Titlebar /></Suspense>
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <ModuleRail />
          <aside data-testid="workbench-sidebar" style={{ width: sidebarWidth, flex: `0 0 ${sidebarWidth}px`, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--gren-sidebar-bg)' }}>
            <Sidebar
              runningSessionPaths={running}
              onNewConversation={() => track('new-conversation')}
              onOpenProject={() => track('open-project')}
              onNewSession={noop}
              onOpenSession={(_cwd, path) => { useSessionStore.getState().setActiveSession(path); track(`open:${path}`); }}
              onDeleteSession={noop}
              onDeleteConversation={noop}
              onClearProjectSessions={noop}
              onRemoveProject={noop}
              onSubmitRename={noop}
            />
          </aside>
          <main data-testid="workbench-main" style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}>
            <MainChatColumn key={chatGeneration} />
          </main>
          </div>
        </div>
      </AgentStoreContext.Provider>
    </App>
  );
}
