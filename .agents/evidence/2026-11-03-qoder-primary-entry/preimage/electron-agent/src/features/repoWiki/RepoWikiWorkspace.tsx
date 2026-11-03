import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfigProvider, theme, type ThemeConfig } from 'antd';
import { RepoWikiPanel, type RepoWikiHostContext } from '../../../vendor/repo-wiki/apps/web/src/RepoWikiPanel';
import { createGrenRepoWikiClient } from '../../../vendor/repo-wiki/packages/renderer/src/index';
import { invoke, listen } from '../../platform/runtime';
import { pi } from '../../lib/pi';
import { applyOpenedProject } from '../../lib/pendingSession';
import { pathsEquivalent } from '../../lib/pathUtils';
import { useSessionStore } from '../../store';
import { registerModuleLeaveGuard, useModuleStore } from '../../stores/moduleStore';

import type { HostActivation, HostHydrateResult, HostProjectsSnapshot, HostProjectSummary } from '../../../vendor/repo-wiki/packages/contracts/src/host';
import type { Project } from '../../../vendor/repo-wiki/packages/contracts/src/index';
import type { TaskView } from '../../../electron/agentData/operationsContracts';
import { knowledgeActivity, knowledgeActivityKey, type KnowledgeActivity } from './knowledgeProjection';
const registerNavigationGuard = (guard: () => boolean) => registerModuleLeaveGuard('repoWiki', guard);
/**
 * The vendored panel paints a fixed light palette (index.css `--rw-*`, `color-scheme: light`).
 * Its antd controls must use the same light palette and forest-green accent, or a dark host
 * theme would render dark tokens on the light surface. A separate cssVar key scopes the tokens.
 */
const repoWikiAntdTheme: ThemeConfig = {
  // The host theme sets explicit dark tokens; inheriting them would defeat the light algorithm.
  inherit: false,
  algorithm: theme.defaultAlgorithm,
  cssVar: { key: 'repo-wiki' },
  hashed: false,
  token: { colorPrimary: '#2e7165', colorInfo: '#2e7165', colorLink: '#2e7165', colorText: '#33362f', colorTextSecondary: '#77796f', colorBorderSecondary: '#e9e6df', colorFillQuaternary: '#f6f5f2', borderRadius: 6, borderRadiusLG: 8, fontSize: 13 },
};
const close = () => useModuleStore.getState().setActiveModule('chat');
const summarize = (path: string): HostProjectSummary => ({ key: path, path, name: path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path });

export function RepoWikiWorkspace({ visible = true, registerNavigationGuard: registerGuard = registerNavigationGuard, onTaskCreated, integrated = false, onOpenTasks, navigation, tasks }: {
  visible?: boolean;
  registerNavigationGuard?: (guard: () => boolean) => () => void;
  onTaskCreated?: (id: string) => void;
  integrated?: boolean;
  onOpenTasks?: () => void;
  navigation?: { workspace: string; language?: string; request: number };
  /** Host task list; its Repo Wiki tasks drive live state on the project collection. */
  tasks?: TaskView[];
} = {}) {
  const taskCreated = useRef(onTaskCreated);
  taskCreated.current = onTaskCreated;
  const [viewId] = useState(() => globalThis.crypto.randomUUID());
  const workspacePath = useSessionStore((state) => state.activeWorkspace) || '';
  const registeredProjects = useSessionStore((state) => state.registeredProjects);
  const localKey = JSON.stringify(registeredProjects);
  const localKeyRef = useRef(localKey);
  localKeyRef.current = localKey;
  const localProjects = registeredProjects.map(summarize);
  const [snapshot, setSnapshot] = useState<{ localKey: string; value: HostProjectsSnapshot } | null>(null);
  const hostProjects = snapshot?.localKey === localKey && snapshot.value.state === 'ready' ? snapshot.value.projects : localProjects;
  const [activation, setActivation] = useState<(HostActivation & { requested: string; revision: number }) | null>(null);
  const [hydrated, setHydrated] = useState<{ token: string; project: Project } | null>(null);
  const [failure, setFailure] = useState<{ workspace: string; message: string } | null>(null);
  const epoch = useRef(0);
  const activateCurrent = useRef<(projectId?: string, retryFailed?: boolean, language?: string) => Promise<void>>(async () => {});
  useEffect(() => {
    const current = ++epoch.current;
    let disposed = false, off: (() => void) | undefined;
    let serial = 0;
    let ownedToken = '';
    const release = (token: string) => { if (token) void invoke('repoWiki_release', { __repoWikiContext: token }).catch(() => {}); };
    const acceptSnapshot = (value: HostProjectsSnapshot, requestedKey = localKeyRef.current) => {
      if (!disposed) setSnapshot({ localKey: requestedKey, value });
    };
    const refresh = async (projectId?: string, retryFailed = false, language?: string) => {
      const request = ++serial;
      setFailure(null);
      try {
        const next = await invoke<HostActivation>('repoWiki_activate', { workspace: workspacePath || null, view_id: viewId, ...(projectId ? { project_id: projectId } : {}), ...(language ? { language } : {}), ...(retryFailed ? { retry: true } : {}) });
        if (disposed || current !== epoch.current) { release(next.context_id); return; }
        if (request !== serial) return;
        ownedToken = next.context_id;
        liveContext.current.token = next.context_id;
        setActivation((previous) => ({ ...next, requested: workspacePath, revision: (previous?.revision || 0) + 1 }));
        if (next.status !== 'bound') return;
        const result = await invoke<HostHydrateResult>('repoWiki_hydrate', { __repoWikiContext: next.context_id });
        if (disposed || current !== epoch.current || request !== serial || result.context_id !== next.context_id) return;
        setHydrated({ token: next.context_id, project: result.project });
      } catch (error) {
        if (!disposed && current === epoch.current && request === serial) setFailure({ workspace: workspacePath, message: (error as Error).message });
      }
    };
    activateCurrent.current = refresh;
    void listen<{ context_id?: string; projects?: HostProjectsSnapshot }>('repoWiki://workspaces', (event) => {
      if (disposed) return;
      if (event.payload?.projects) acceptSnapshot(event.payload.projects);
      if (event.payload?.context_id && event.payload.context_id !== liveContext.current.token) {
        liveContext.current.token = '';
        setActivation(null); setHydrated(null);
      }
      void refresh();
    }).then((release) => { if (disposed) release(); else off = release; }).catch(() => {});
    // This endpoint reads an in-memory host snapshot; it is independent of preparation.
    void invoke<HostProjectsSnapshot>('repoWiki_hostProjects').then((value) => acceptSnapshot(value, localKey)).catch(() => {});
    void refresh();
    return () => { disposed = true; ++serial; off?.(); release(ownedToken); };
  }, [workspacePath]);
  const current = activation?.requested === workspacePath ? activation : null;
  const token = current?.context_id || '';
  const liveContext = useRef({ token, workspacePath });
  liveContext.current = { token, workspacePath };
  const client = useMemo(() => createGrenRepoWikiClient({
    async invoke<T>(command: string, args: Record<string, unknown> = {}) {
      const isCurrent = () => token && liveContext.current.token === token && liveContext.current.workspacePath === workspacePath && (useSessionStore.getState().activeWorkspace || '') === workspacePath;
      if (!isCurrent()) throw new Error('Repo Wiki workspace changed');
      const result = await invoke<T>(command, { ...args, __repoWikiContext: token });
      if (command === 'repoWiki_generate' && typeof (result as { task_id?: unknown })?.task_id === 'string') taskCreated.current?.((result as { task_id: string }).task_id);
      if (!isCurrent()) throw new Error('Repo Wiki workspace changed');
      return result;
    },
    subscribe: (event, handler) => !token ? Promise.resolve(() => {}) : listen(event, (message) => {
      const payload = message.payload as { context_id?: string };
      if (payload.context_id === token && liveContext.current.token === token && (useSessionStore.getState().activeWorkspace || '') === workspacePath) handler(message as never);
    }),
  }), [token, workspacePath]);
  const currentProject = current?.status === 'bound' && hydrated?.token === token ? hydrated.project : undefined;
  const appliedNavigation = useRef('');
  useEffect(() => {
    if (!visible || !currentProject || !navigation?.language || !pathsEquivalent(workspacePath, navigation.workspace)) return;
    const key = JSON.stringify([navigation.workspace, navigation.language, navigation.request]);
    if (appliedNavigation.current === key) return;
    appliedNavigation.current = key;
    if (current?.language !== navigation.language) void activateCurrent.current(undefined, false, navigation.language);
  }, [visible, workspacePath, currentProject?.id, current?.language, navigation?.workspace, navigation?.language, navigation?.request]);
  const activity = useMemo(() => {
    const map: Record<string, KnowledgeActivity> = {};
    for (const task of tasks ?? []) {
      if (task.kind !== 'repoWiki.generate' || !task.workspace) continue;
      const live = knowledgeActivity(task.knowledge, task.updatedAt), key = knowledgeActivityKey(task.workspace);
      if (live && (!map[key] || map[key].updatedAt < live.updatedAt)) map[key] = live;
    }
    return map;
  }, [tasks]);
  const hostContext: RepoWikiHostContext = {
    key: workspacePath, contextId: token, projectId: currentProject?.id || null,
    status: current?.status || 'pending', revision: current?.revision || 0,
    projects: hostProjects, project: currentProject,
    currentSummary: hostProjects.find((item) => pathsEquivalent(item.path, workspacePath)) || ((!current || current.status === 'pending') && workspacePath ? summarize(workspacePath) : undefined),
    onLanguage: (language) => activateCurrent.current(undefined, false, language),
    error: failure?.workspace === workspacePath ? failure.message : undefined,
    onRetry: () => { void activateCurrent.current(undefined, true); },
    activity,
  };
  const openWorkspace = async (path: string, projectId?: string) => {
    const origin = useSessionStore.getState().activeWorkspace;
    if (pathsEquivalent(origin, path)) {
      if (projectId) await activateCurrent.current(projectId);
      return;
    }
    const result = await pi.openWorkspace(path);
    if (useSessionStore.getState().activeWorkspace !== origin) return;
    applyOpenedProject(path, result.sessionFile);
  };
  return <ConfigProvider theme={repoWikiAntdTheme} button={{ autoInsertSpace: false }}>
    <RepoWikiPanel client={client} workspacePath={workspacePath || undefined}
      hostContext={hostContext} onSelectWorkspace={openWorkspace}
      onClose={close} visible={visible} integrated={integrated} onOpenTasks={onOpenTasks} registerNavigationGuard={registerGuard}
      style={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%' }} />
  </ConfigProvider>;
}
