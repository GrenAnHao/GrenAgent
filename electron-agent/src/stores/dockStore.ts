import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useLayoutStore } from './layoutStore';
import { useSessionStore } from '../store/session';
import { pathsEquivalent } from '../lib/pathUtils';

export type DockRegion = 'right' | 'bottom';
export type DockTabKind =
  | 'terminal'
  | 'browser'
  | 'page'
  | 'subagent'
  | 'subagentLog'
  | 'projectContext'
  | 'file'
  | 'review'
  | 'visual'
  | 'plan';

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

export interface TerminalPayload {
  /** 运行时 shell 会话 id，不持久化。 */
  shellId?: string;
  status: TerminalStatus;
}

export interface PagePayload {
  url: string;
  content: string;
  title?: string;
  chars?: number;
  crawler?: string;
}

export interface BrowserPayload {
  url: string;
  title?: string;
  faviconUrl?: string;
}

/** 兼容现有调用方（extensionCards / PageContentViewer）的别名。 */
export type PageView = PagePayload;

export interface SubAgentPayload {
  messageId: string;
  toolCallId: string;
  /** null/缺省 = 单任务（整条消息）；数字 = 并行/链式里的子代理下标。 */
  subIndex?: number | null;
}

/** registry 后端子代理（无对应主对话消息时的兜底视图）。有 transcript 时实时回放完整工具调用+文本流，否则退回 output 文本。 */
export interface SubAgentLogPayload {
  agentId: string;
  task: string;
  output: string;
  status: 'running' | 'done' | 'error';
  /** 原始 JSONL transcript（registry 运行期增量写入）；缺省时面板退回纯 output 文本。 */
  transcript?: string;
}

export interface ProjectContextPayload {
  workspace: string;
}

export interface FilePayload {
  workspace: string;
  /** 文件管理器里打开着的文件（绝对路径，按标签顺序）。旧数据没有这一项。 */
  openFiles?: string[];
  /** 当前看的那个；null / 缺省 = 没有打开文件。 */
  activeFile?: string | null;
}

/** 文件管理器 dock 标签的名字。旧版本存下来的「文件」在读回和写盘时统一改成它。 */
export const FILE_TAB_TITLE = '文件管理器';

export interface ReviewPayload {
  workspace?: string;
  turnId?: string;
  fileIndex?: number;
}

export interface VisualPayload {
  /** 视觉设计的 rev（换页面时递增）。 */
  sessionId: number;
  /** visualStore 里这条视觉设计的 key：面板只读它，不读「当前会话」。 */
  visualKey: string;
}

export interface PlanPayload {
  /** planStore 里这份计划的 key（发起会话）：面板只读它，不读「当前会话」。 */
  planKey: string;
}

export type DockTabPayload = TerminalPayload | BrowserPayload | PagePayload | SubAgentPayload | SubAgentLogPayload | ProjectContextPayload | FilePayload | ReviewPayload | VisualPayload | PlanPayload;

export interface DockTab {
  id: string;
  kind: DockTabKind;
  region: DockRegion;
  title: string;
  closable: boolean;
  /** 同 region 内排序。 */
  order: number;
  payload: DockTabPayload;
  /** 最近一次打开或激活，标签列表用相对时间。 */
  touchedAt?: number;
  /**
   * 会话归属：打开时所在的聊天会话。右区的标签一律有归属（右侧边栏跟着会话走）；
   * 底部区只有 subagent / subagentLog / visual 带归属，其余（终端）全局共享。
   * undefined = 全局 tab；null = 当前工作区的草稿会话。只在归属会话里显示。
   */
  ownerSessionPath?: string | null;
  /** 归属会话所在工作区（草稿会话靠它区分）。 */
  ownerWorkspace?: string;
}

/** 当前正在查看的聊天会话。sessionPath 为 null 表示草稿。 */
export interface DockSessionView {
  sessionPath: string | null;
  workspace: string;
}

export type DockTabOwner = Pick<DockTab, 'ownerSessionPath' | 'ownerWorkspace'>;

/** 从会话 store 读取正在查看的会话（'' / null 都算草稿）。 */
export function currentDockView(): DockSessionView {
  const st = useSessionStore.getState();
  return { sessionPath: st.activeSessionPath || null, workspace: st.activeWorkspace ?? '' };
}

/** 打开会话归属 tab 时记录的 owner 字段。 */
export function currentDockOwner(): Required<DockTabOwner> {
  const view = currentDockView();
  return { ownerSessionPath: view.sessionPath, ownerWorkspace: view.workspace };
}

/**
 * 由渲染消息的 agent store 推出 owner：它实际加载的会话比 activeSessionPath 更可靠（切换中两者可能短暂不一致）。
 * 拿不到 store 时返回空对象，交给 dockStore 用会话 store 兜底。
 */
export function dockOwnerFromStore(
  store: { getLoadedSessionPath?: () => string | null | undefined } | null | undefined,
  workspace: string,
): DockTabOwner {
  if (!store?.getLoadedSessionPath) return {};
  return { ownerSessionPath: store.getLoadedSessionPath() ?? null, ownerWorkspace: workspace };
}

export function isSessionOwnedKind(kind: DockTabKind): boolean {
  return kind === 'subagent' || kind === 'subagentLog' || kind === 'visual' || kind === 'plan';
}

function normKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 会话视图的 map key（草稿按工作区区分）。 */
export function dockSessionKey(view: DockSessionView): string {
  return view.sessionPath ? `s:${normKey(view.sessionPath)}` : `d:${normKey(view.workspace)}`;
}

function ownerMatches(tab: DockTab, view: DockSessionView): boolean {
  if (tab.ownerSessionPath == null) return !view.sessionPath && pathsEquivalent(tab.ownerWorkspace ?? '', view.workspace);
  return Boolean(view.sessionPath) && pathsEquivalent(tab.ownerSessionPath, view.sessionPath as string);
}

/** 归属 owner 的会话是不是正在画面上。后台会话打开 tab 时不能抢占当前画面。 */
export function isDockOwnerViewed(owner: Required<DockTabOwner>, view: DockSessionView = currentDockView()): boolean {
  return ownerMatches({ ownerSessionPath: owner.ownerSessionPath, ownerWorkspace: owner.ownerWorkspace } as DockTab, view);
}

/** 全局 tab 总可见；会话归属 tab 只在归属会话里可见。 */
export function isDockTabVisible(tab: DockTab, view: DockSessionView): boolean {
  if (tab.ownerSessionPath === undefined) return true;
  return ownerMatches(tab, view);
}

/** 某 region 在给定会话下可见的 tab（按 order 排序）。 */
export function visibleRegionTabs(tabs: DockTab[], region: DockRegion, view: DockSessionView): DockTab[] {
  return tabs.filter((t) => t.region === region && isDockTabVisible(t, view)).sort((a, b) => a.order - b.order);
}

/**
 * 某 region 要挂载 body 的 tab：当前会话可见的，加上别的会话里不该卸载的（终端 shell、浏览器页面、
 * 文件里没保存的修改）。后者只藏起来，切回归属会话时原样还在。子代理 / 视觉设计照旧随会话卸载。
 */
export function mountedRegionTabs(tabs: DockTab[], region: DockRegion, view: DockSessionView): DockTab[] {
  return tabs
    .filter((t) => t.region === region && (isDockTabVisible(t, view) || !isSessionOwnedKind(t.kind)))
    .sort((a, b) => a.order - b.order);
}

/** 可见的激活 tab：activeByRegion 被隐藏时退回该会话上次激活的，再退回最后一个可见 tab。 */
export function resolveVisibleActive(
  state: Pick<DockState, 'activeByRegion' | 'activeBySession'>,
  region: DockRegion,
  view: DockSessionView,
  visible: DockTab[],
): string | null {
  const has = (id: string | null | undefined): id is string => Boolean(id) && visible.some((t) => t.id === id);
  const current = state.activeByRegion[region];
  if (has(current)) return current;
  const remembered = state.activeBySession?.[dockSessionKey(view)]?.[region];
  if (has(remembered)) return remembered;
  return visible.at(-1)?.id ?? null;
}

/** 关掉后可从标签列表恢复的快照。子代理 tab 不入列。 */
export interface ClosedDockTab {
  id: string;
  kind: DockTabKind;
  region: DockRegion;
  title: string;
  closable: boolean;
  payload: DockTabPayload;
  closedAt: number;
  /** 会话归属 tab 恢复时要回到原来的会话，不能变成全局 tab。 */
  ownerSessionPath?: string | null;
  ownerWorkspace?: string;
}

export const MAX_CLOSED_TABS = 20;

interface DockState {
  tabs: DockTab[];
  closedTabs: ClosedDockTab[];
  activeByRegion: Record<DockRegion, string | null>;
  /** 每个会话上次激活的 tab（不持久化）。 */
  activeBySession: Record<string, Partial<Record<DockRegion, string>>>;
  /** 每个会话离开时右面板是否展开（不持久化）。 */
  rightOpenBySession: Record<string, boolean>;
  /** 每个会话离开时右面板是否占满（不持久化）。 */
  rightFillBySession: Record<string, boolean>;

  addTab: (input: Omit<DockTab, 'order'> & { order?: number }) => void;
  updateTab: (
    id: string,
    patch: Partial<Pick<DockTab, 'title' | 'payload' | 'touchedAt' | 'ownerSessionPath' | 'ownerWorkspace'>>,
  ) => void;
  closeTab: (id: string) => void;
  restoreClosedTab: (id: string, closedAt: number) => void;
  setActive: (region: DockRegion, id: string) => void;
  setTerminalStatus: (id: string, status: TerminalStatus, shellId?: string) => void;
  reorderTabs: (region: DockRegion, fromIndex: number, toIndex: number) => void;
  moveTabRegion: (id: string, targetRegion: DockRegion, insertIndex?: number) => void;
  openPage: (page: PageView) => void;
  openProjectContext: (workspace: string) => void;
  openSubAgent: (input: SubAgentOpenInput) => void;
  openSubAgentLog: (input: SubAgentLogPayload & DockTabOwner) => void;
  resetWorkspaceTabs: () => void;
  /** 聊天会话切换：保存/恢复每会话的激活 tab 与右面板展开态。 */
  switchSessionView: (prev: DockSessionView, next: DockSessionView) => void;
  /**
   * 草稿首发落盘成会话：草稿名下的标签和右面板状态过户给新会话。必须在 setActiveSession(新路径) 之前调，
   * 随后那次「草稿 → 新会话」的切换不再当成换会话处理。
   */
  adoptDraftView: (workspace: string, sessionPath: string) => void;
  /** 删除会话时丢弃它名下的 tab。 */
  dropSessionTabs: (sessionPath: string, wasViewed?: boolean) => void;
}

/** 按需打开（或激活）某个子代理的右坞 tab。单任务 subIndex 传 null。 */
export interface SubAgentOpenInput {
  messageId: string;
  toolCallId: string;
  subIndex: number | null;
  title: string;
  /** 归属会话；缺省取当前查看的会话。 */
  ownerSessionPath?: string | null;
  ownerWorkspace?: string;
}

function ownerOf(input: DockTabOwner): Required<DockTabOwner> {
  if (input.ownerSessionPath !== undefined) {
    return { ownerSessionPath: input.ownerSessionPath, ownerWorkspace: input.ownerWorkspace ?? currentDockView().workspace };
  }
  return currentDockOwner();
}

/**
 * 右侧边栏跟着会话走：落到右区、还没有归属的 tab 记到当前会话名下。
 * 不在这里补的话，任何新入口直接 addTab 都会造出一个所有会话共用的右栏标签。
 */
function withRightOwner<T extends DockTabOwner & { region: DockRegion }>(tab: T): T {
  if (tab.region !== 'right' || tab.ownerSessionPath !== undefined) return tab;
  return { ...tab, ...currentDockOwner() };
}

/** 回到底部区的非会话类 tab（终端等）重新全局共享，和底部区原来的语义一致。 */
function withoutOwner(tab: DockTab): DockTab {
  const { ownerSessionPath: _p, ownerWorkspace: _w, ...rest } = tab;
  void _p;
  void _w;
  return rest;
}

/** 同一个规范 id 被别的会话的 tab 占着时，给当前会话另起一个。 */
function freeTabId(tabs: DockTab[], canonical: string): string {
  if (!tabs.some((t) => t.id === canonical)) return canonical;
  let n = 2;
  while (tabs.some((t) => t.id === `${canonical}#${n}`)) n += 1;
  return `${canonical}#${n}`;
}

/** 草稿首发落盘的那一次切换（adoptDraftView 记下，switchSessionView 消费）。 */
let pendingDraftAdoption: { from: string; to: string } | null = null;

/** 子代理 tab 的稳定 id：单任务用 messageId，多任务用 `${messageId}#${subIndex}`。 */
export function subAgentTabId(messageId: string, subIndex: number | null): string {
  return subIndex == null ? messageId : `${messageId}#${subIndex}`;
}

/** 终端默认标题（Windows → PowerShell）。 */
export function defaultTerminalTitle(): string {
  if (typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent)) return 'PowerShell';
  return 'Terminal';
}

function nextOrder(tabs: DockTab[], region: DockRegion): number {
  return tabs.filter((t) => t.region === region).reduce((max, t) => Math.max(max, t.order), -1) + 1;
}

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 用一批已更新的 tab 覆盖原列表中的同 id 项。 */
function patchTabs(tabs: DockTab[], updated: DockTab[]): DockTab[] {
  const byId = new Map(updated.map((t) => [t.id, t]));
  return tabs.map((t) => byId.get(t.id) ?? t);
}

function collapseEmptyRegion(region: DockRegion, tabs: DockTab[]): void {
  const view = currentDockView();
  if (tabs.some((t) => t.region === region && isDockTabVisible(t, view))) return;
  if (region === 'right') useLayoutStore.getState().setRightPanelOpen(false);
  else useLayoutStore.getState().setTerminalOpen(false);
}

function revealRegion(region: DockRegion): void {
  if (region === 'right') useLayoutStore.getState().setRightPanelOpen(true);
  else useLayoutStore.getState().setTerminalOpen(true);
}

function snapshotClosedTab(tab: DockTab): ClosedDockTab | null {
  if (tab.kind === 'subagent' || tab.kind === 'subagentLog') return null;
  return {
    id: tab.id,
    kind: tab.kind,
    region: tab.region,
    title: tab.title,
    closable: tab.closable,
    payload: tab.kind === 'terminal' ? { status: 'idle' } : tab.payload,
    closedAt: Date.now(),
    ...(tab.ownerSessionPath !== undefined
      ? { ownerSessionPath: tab.ownerSessionPath, ownerWorkspace: tab.ownerWorkspace }
      : {}),
  };
}

function findLiveForRestore(tabs: DockTab[], entry: ClosedDockTab): DockTab | undefined {
  const byId = tabs.find((t) => t.id === entry.id);
  if (byId) return byId;
  if (entry.kind === 'file') {
    const workspace = (entry.payload as FilePayload).workspace;
    return tabs.find(
      (t) => t.region === entry.region && t.kind === 'file' && (t.payload as FilePayload).workspace === workspace,
    );
  }
  if (entry.kind === 'review') {
    return tabs.find((t) => t.region === entry.region && t.kind === 'review');
  }
  return undefined;
}

function pushClosed(list: ClosedDockTab[] | undefined, snap: ClosedDockTab): ClosedDockTab[] {
  return [snap, ...(list ?? []).filter((c) => c.id !== snap.id)].slice(0, MAX_CLOSED_TABS);
}

function isSessionOnlyDockKind(kind: DockTabKind): boolean {
  return kind === 'subagent' || kind === 'subagentLog' || kind === 'browser' || kind === 'visual' || kind === 'plan';
}

/** 右区没有归属的 tab 是旧版本留下的全局右栏标签：不再存、读回来也丢掉，否则它会出现在每个会话里。 */
function isOwnerlessRight(t: { region: DockRegion; ownerSessionPath?: string | null }): boolean {
  return t.region === 'right' && t.ownerSessionPath === undefined;
}

function sanitizePersistedActive(
  active: Record<DockRegion, string | null>,
  tabs: DockTab[],
): Record<DockRegion, string | null> {
  const pick = (region: DockRegion): string | null => {
    if (active[region] && tabs.some((tab) => tab.id === active[region])) return active[region];
    return tabs.filter((tab) => tab.region === region).sort((a, b) => a.order - b.order)[0]?.id ?? null;
  };
  return { right: pick('right'), bottom: pick('bottom') };
}

/** 终端的 runtime 状态不落盘；文件标签的旧标题改成新名字。 */
function normalizePersistedTab<T extends Pick<DockTab, 'kind' | 'title' | 'payload'>>(t: T): T {
  if (t.kind === 'terminal') return { ...t, payload: { status: 'idle' as const } } as T;
  if (t.kind === 'file' && t.title !== FILE_TAB_TITLE) return { ...t, title: FILE_TAB_TITLE };
  return t;
}

function persistDockSnapshot(s: Pick<DockState, 'tabs' | 'closedTabs' | 'activeByRegion'>): Pick<
  DockState,
  'tabs' | 'closedTabs' | 'activeByRegion'
> {
  const tabs = s.tabs
    .filter((t) => !isSessionOnlyDockKind(t.kind) && !isOwnerlessRight(t))
    .map((t) => normalizePersistedTab(t));
  const closedTabs = (s.closedTabs ?? [])
    .filter((t) => !isSessionOnlyDockKind(t.kind) && !isOwnerlessRight(t))
    .map((t) => normalizePersistedTab(t));
  return {
    tabs,
    closedTabs,
    activeByRegion: sanitizePersistedActive(s.activeByRegion, tabs),
  };
}

export const useDockStore = create<DockState>()(
  persist(
    (set, get) => ({
      tabs: [],
      closedTabs: [],
      activeByRegion: { right: null, bottom: null },
      activeBySession: {},
      rightOpenBySession: {},
      rightFillBySession: {},

      addTab: (input) => {
        set((s) => {
          const order = input.order ?? nextOrder(s.tabs, input.region);
          const tab: DockTab = withRightOwner({ ...input, order, touchedAt: input.touchedAt ?? Date.now() });
          return {
            tabs: [...s.tabs, tab],
            activeByRegion: { ...s.activeByRegion, [input.region]: tab.id },
          };
        });
        revealRegion(input.region);
      },

      updateTab: (id, patch) =>
        set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) })),

      closeTab: (id) => {
        const target = get().tabs.find((t) => t.id === id);
        if (!target) return;
        const region = target.region;
        const snap = snapshotClosedTab(target);
        const view = currentDockView();
        set((s) => {
          // 只在当前会话可见的 tab 里挑兜底，别把激活指向别的会话的 tab。
          const regionTabs = visibleRegionTabs(s.tabs, region, view);
          const index = regionTabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          const activeByRegion = { ...s.activeByRegion };
          if (activeByRegion[region] === id) {
            const remaining = regionTabs.filter((t) => t.id !== id);
            const fallback = remaining[Math.max(0, index - 1)] ?? remaining[0] ?? null;
            activeByRegion[region] = fallback ? fallback.id : null;
          }
          return {
            tabs,
            activeByRegion,
            closedTabs: snap ? pushClosed(s.closedTabs, snap) : s.closedTabs,
          };
        });
        collapseEmptyRegion(region, get().tabs);
      },

      restoreClosedTab: (id, closedAt) => {
        const entry = get().closedTabs.find((c) => c.id === id && c.closedAt === closedAt);
        if (!entry) return;
        set((s) => ({
          closedTabs: s.closedTabs.filter((c) => !(c.id === id && c.closedAt === closedAt)),
        }));
        // 只复用当前会话看得见的同类 tab；别的会话里的同 id 标签不能被拉过来。
        const view = currentDockView();
        const live = findLiveForRestore(get().tabs.filter((t) => isDockTabVisible(t, view)), entry);
        if (live) {
          get().setActive(live.region, live.id);
          revealRegion(live.region);
          return;
        }
        get().addTab({
          id: freeTabId(get().tabs, entry.id),
          kind: entry.kind,
          region: entry.region,
          title: entry.title,
          closable: entry.closable,
          payload: entry.kind === 'terminal' ? { status: 'idle' } : entry.payload,
          ...(entry.ownerSessionPath !== undefined
            ? { ownerSessionPath: entry.ownerSessionPath, ownerWorkspace: entry.ownerWorkspace }
            : {}),
        });
      },

      setActive: (region, id) =>
        set((s) => ({
          activeByRegion: { ...s.activeByRegion, [region]: id },
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, touchedAt: Date.now() } : t)),
        })),

      setTerminalStatus: (id, status, shellId) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id && t.kind === 'terminal'
              ? { ...t, payload: { ...(t.payload as TerminalPayload), status, ...(shellId !== undefined ? { shellId } : {}) } }
              : t,
          ),
        })),

      reorderTabs: (region, fromIndex, toIndex) =>
        set((s) => {
          const inRegion = s.tabs.filter((t) => t.region === region).sort((a, b) => a.order - b.order);
          if (fromIndex < 0 || toIndex < 0 || fromIndex >= inRegion.length || toIndex >= inRegion.length) return s;
          const moved = moveItem(inRegion, fromIndex, toIndex).map((t, i) => ({ ...t, order: i }));
          return { tabs: patchTabs(s.tabs, moved) };
        }),

      moveTabRegion: (id, targetRegion, insertIndex) => {
        let moved = false;
        let sourceRegion: DockRegion | null = null;
        set((s) => {
          const tab = s.tabs.find((t) => t.id === id);
          if (!tab) return s;
          if (tab.region === targetRegion) return s;

          const fromRegion = tab.region;
          sourceRegion = fromRegion;
          const targetTabs = s.tabs.filter((t) => t.region === targetRegion).sort((a, b) => a.order - b.order);
          const at = insertIndex == null ? targetTabs.length : Math.max(0, Math.min(insertIndex, targetTabs.length));
          const relocated: DockTab = { ...tab, region: targetRegion };
          const movedTab: DockTab =
            targetRegion === 'right'
              ? withRightOwner(relocated)
              : isSessionOwnedKind(tab.kind)
                ? relocated
                : withoutOwner(relocated);
          const nextTarget = [...targetTabs.slice(0, at), movedTab, ...targetTabs.slice(at)].map((t, i) => ({ ...t, order: i }));
          const activeByRegion = { ...s.activeByRegion, [targetRegion]: id };
          if (activeByRegion[fromRegion] === id) {
            const sourceTabs = visibleRegionTabs(s.tabs, fromRegion, currentDockView());
            const index = sourceTabs.findIndex((t) => t.id === id);
            const remaining = sourceTabs.filter((t) => t.id !== id);
            const fallback = remaining[Math.max(0, index - 1)] ?? remaining[0] ?? null;
            activeByRegion[fromRegion] = fallback ? fallback.id : null;
          }
          moved = true;
          return {
            tabs: patchTabs(s.tabs, nextTarget),
            activeByRegion,
          };
        });
        if (!moved) return;
        if (targetRegion === 'right') useLayoutStore.getState().setRightPanelOpen(true);
        else useLayoutStore.getState().setTerminalOpen(true);
        if (sourceRegion) collapseEmptyRegion(sourceRegion, get().tabs);
      },

      openPage: (page) => {
        const title = page.title || page.url;
        const view = currentDockView();
        set((s) => {
          // 同一网址只在当前会话里复用；别的会话打开的同一页是那个会话自己的标签。
          const existing = s.tabs.find(
            (t) => t.kind === 'page' && (t.payload as PagePayload).url === page.url && isDockTabVisible(t, view),
          );
          const id = existing?.id ?? freeTabId(s.tabs, `page:${page.url}`);
          const tabs = existing
            ? s.tabs.map((t) => (t.id === id ? { ...t, title, payload: { ...page }, touchedAt: Date.now() } : t))
            : [
                ...s.tabs,
                {
                  id,
                  kind: 'page' as const,
                  region: 'right' as const,
                  title,
                  closable: true,
                  order: nextOrder(s.tabs, 'right'),
                  payload: { ...page },
                  touchedAt: Date.now(),
                  ...ownerOf({}),
                },
              ];
          return { tabs, activeByRegion: { ...s.activeByRegion, right: id } };
        });
        useLayoutStore.getState().setRightPanelOpen(true);
      },

      openProjectContext: (workspace) => {
        const view = currentDockView();
        set((s) => {
          // 每个会话各有一个「项目上下文」标签。
          const existing = s.tabs.find((tab) => tab.kind === 'projectContext' && isDockTabVisible(tab, view));
          const id = existing?.id ?? freeTabId(s.tabs, 'project-context');
          const tabs = existing
            ? s.tabs.map((tab) => (
                tab.id === id
                  ? { ...tab, title: '项目上下文', payload: { workspace } }
                  : tab
              ))
            : [
                ...s.tabs,
                {
                  id,
                  kind: 'projectContext' as const,
                  region: 'right' as const,
                  title: '项目上下文',
                  closable: true,
                  order: nextOrder(s.tabs, 'right'),
                  payload: { workspace },
                  ...ownerOf({}),
                },
              ];
          return { tabs, activeByRegion: { ...s.activeByRegion, right: id } };
        });
        useLayoutStore.getState().setRightPanelOpen(true);
      },

      openSubAgentLog: ({ ownerSessionPath, ownerWorkspace, ...input }) => {
        const id = `salog:${input.agentId}`;
        const owner = ownerOf({ ownerSessionPath, ownerWorkspace });
        set((s) => {
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs.map((t) => (t.id === id ? { ...t, ...owner, title: input.task, payload: { ...input } } : t))
            : [
                ...s.tabs,
                {
                  id,
                  kind: 'subagentLog' as const,
                  region: 'right' as const,
                  title: input.task,
                  closable: true,
                  order: nextOrder(s.tabs, 'right'),
                  payload: { ...input },
                  ...owner,
                },
              ];
          return { tabs, activeByRegion: { ...s.activeByRegion, right: id } };
        });
        useLayoutStore.getState().setRightPanelOpen(true);
      },

      openSubAgent: ({ messageId, toolCallId, subIndex, title, ownerSessionPath, ownerWorkspace }) => {
        const id = subAgentTabId(messageId, subIndex);
        const owner = ownerOf({ ownerSessionPath, ownerWorkspace });
        set((s) => {
          const exists = s.tabs.some((t) => t.id === id);
          // 同 id 已存在：归属改到当前会话（消息 id 理论上不跨会话重复，防御性接管）。
          const tabs = exists
            ? s.tabs.map((t) => (t.id === id ? { ...t, ...owner, title, payload: { messageId, toolCallId, subIndex } } : t))
            : [
                ...s.tabs,
                {
                  id,
                  kind: 'subagent' as const,
                  region: 'right' as const,
                  title,
                  closable: true,
                  order: nextOrder(s.tabs, 'right'),
                  payload: { messageId, toolCallId, subIndex },
                  ...owner,
                },
              ];
          return { tabs, activeByRegion: { ...s.activeByRegion, right: id } };
        });
        useLayoutStore.getState().setRightPanelOpen(true);
      },

      resetWorkspaceTabs: () =>
        set((s) => {
          const hadTerminal = s.tabs.some((t) => t.kind === 'terminal');
          const kept = s.tabs.filter((t) => t.kind !== 'terminal');
          const fresh: DockTab | null = hadTerminal
            ? {
                id: `terminal-${Date.now()}`,
                kind: 'terminal',
                region: 'bottom',
                title: defaultTerminalTitle(),
                closable: true,
                order: 0,
                payload: { status: 'idle' },
              }
            : null;
          const tabs = fresh ? [...kept, fresh] : kept;
          return {
            tabs,
            activeByRegion: { ...s.activeByRegion, bottom: fresh ? fresh.id : null },
          };
        }),

      switchSessionView: (prev, next) => {
        const prevKey = dockSessionKey(prev);
        const nextKey = dockSessionKey(next);
        if (prevKey === nextKey) return;
        const adopted = pendingDraftAdoption?.from === prevKey && pendingDraftAdoption.to === nextKey;
        pendingDraftAdoption = null;
        // 草稿首发落盘：画面还是这一份对话，标签已经过户，右面板原样保留，草稿也不再单独记状态。
        if (adopted) return;
        const s = get();
        const layout = useLayoutStore.getState();
        const prevActive: Partial<Record<DockRegion, string>> = {};
        for (const region of ['right', 'bottom'] as const) {
          const id = resolveVisibleActive(s, region, prev, visibleRegionTabs(s.tabs, region, prev));
          if (id) prevActive[region] = id;
        }
        const nextRight = visibleRegionTabs(s.tabs, 'right', next);
        // 激活优先级：本会话上次激活 → 最后一个可见。
        const has = (id: string | null | undefined): id is string => Boolean(id) && nextRight.some((t) => t.id === id);
        const remembered = s.activeBySession[nextKey]?.right;
        const right = has(remembered) ? remembered : nextRight.at(-1)?.id ?? null;
        set({
          activeBySession: { ...s.activeBySession, [prevKey]: prevActive },
          rightOpenBySession: { ...s.rightOpenBySession, [prevKey]: layout.rightPanelOpen },
          rightFillBySession: { ...s.rightFillBySession, [prevKey]: layout.rightPanelFill },
          activeByRegion: { ...s.activeByRegion, right },
        });
        // 右面板的展开 / 占满按会话记：目标会话离开时什么样就恢复成什么样，没去过的会话默认收起。
        // 不看上一个会话开没开、有没有标签——否则在 A 打开的面板（哪怕是空的启动页）会原样带进 B。
        const open = Boolean(s.rightOpenBySession[nextKey]);
        if (open !== layout.rightPanelOpen) layout.setRightPanelOpen(open);
        const fill = open && Boolean(s.rightFillBySession[nextKey]);
        if (fill !== useLayoutStore.getState().rightPanelFill) useLayoutStore.setState({ rightPanelFill: fill });
      },

      adoptDraftView: (workspace, sessionPath) => {
        if (!workspace || !sessionPath) return;
        const from = dockSessionKey({ sessionPath: null, workspace });
        const to = dockSessionKey({ sessionPath, workspace });
        const draftOwned = (o: DockTabOwner) =>
          o.ownerSessionPath === null && pathsEquivalent(o.ownerWorkspace ?? '', workspace);
        set((s) => {
          const { [from]: draftActive, ...activeBySession } = s.activeBySession;
          const { [from]: draftOpen, ...rightOpenBySession } = s.rightOpenBySession;
          const { [from]: draftFill, ...rightFillBySession } = s.rightFillBySession;
          return {
            tabs: s.tabs.map((t) => (draftOwned(t) ? { ...t, ownerSessionPath: sessionPath } : t)),
            closedTabs: s.closedTabs.map((c) => (draftOwned(c) ? { ...c, ownerSessionPath: sessionPath } : c)),
            activeBySession: draftActive ? { ...activeBySession, [to]: draftActive } : activeBySession,
            rightOpenBySession: draftOpen === undefined ? rightOpenBySession : { ...rightOpenBySession, [to]: draftOpen },
            rightFillBySession: draftFill === undefined ? rightFillBySession : { ...rightFillBySession, [to]: draftFill },
          };
        });
        pendingDraftAdoption = { from, to };
      },

      dropSessionTabs: (sessionPath, wasViewed = false) => {
        if (!sessionPath) return;
        const s = get();
        const doomed = new Set(
          s.tabs
            .filter((t) => t.ownerSessionPath && pathsEquivalent(t.ownerSessionPath, sessionPath))
            .map((t) => t.id),
        );
        const key = dockSessionKey({ sessionPath, workspace: '' });
        const { [key]: _a, ...activeBySession } = s.activeBySession;
        const { [key]: _o, ...rightOpenBySession } = s.rightOpenBySession;
        const { [key]: _f, ...rightFillBySession } = s.rightFillBySession;
        void _a;
        void _o;
        void _f;
        const activeByRegion = { ...s.activeByRegion };
        for (const region of ['right', 'bottom'] as const) {
          if (activeByRegion[region] && doomed.has(activeByRegion[region] as string)) activeByRegion[region] = null;
        }
        set({
          tabs: s.tabs.filter((t) => !doomed.has(t.id)),
          // 最近关闭里属于这个会话的项一起丢掉：会话没了，它们在哪儿都列不出来。
          closedTabs: (s.closedTabs ?? []).filter(
            (c) => !(c.ownerSessionPath && pathsEquivalent(c.ownerSessionPath, sessionPath)),
          ),
          activeBySession,
          rightOpenBySession,
          rightFillBySession,
          activeByRegion,
        });
        // 删的是正在看的会话且右坞里有它的 tab：当前视图若已无可见 tab 就收起右面板。
        if (wasViewed && s.tabs.some((t) => doomed.has(t.id) && t.region === 'right')) {
          collapseEmptyRegion('right', get().tabs);
        }
      },
    }),
    {
      name: 'hermes-dock',
      // 终端 runtime shellId 不持久化，重置为 idle；subagent / subagentLog / browser
      // 只活在当前会话：重启后不要自动打开上次的网页。
      partialize: (s) => persistDockSnapshot(s),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<Pick<DockState, 'tabs' | 'closedTabs' | 'activeByRegion'>>;
        return {
          ...current,
          ...persistDockSnapshot({
            tabs: stored.tabs ?? current.tabs,
            closedTabs: stored.closedTabs ?? current.closedTabs,
            activeByRegion: stored.activeByRegion ?? current.activeByRegion,
          }),
        };
      },
    },
  ),
);
