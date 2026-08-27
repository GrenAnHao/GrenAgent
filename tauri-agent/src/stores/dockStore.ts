import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useLayoutStore } from './layoutStore';

export type DockRegion = 'right' | 'bottom';
export type DockTabKind = 'terminal' | 'page' | 'subagent' | 'subagentLog' | 'projectContext';
// 后续阶段：| 'file' | 'diff' | 'sidechat'

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

export type DockTabPayload = TerminalPayload | PagePayload | SubAgentPayload | SubAgentLogPayload | ProjectContextPayload;

export interface DockTab {
  id: string;
  kind: DockTabKind;
  region: DockRegion;
  title: string;
  closable: boolean;
  /** 同 region 内排序。 */
  order: number;
  payload: DockTabPayload;
}

interface DockState {
  tabs: DockTab[];
  activeByRegion: Record<DockRegion, string | null>;

  addTab: (input: Omit<DockTab, 'order'> & { order?: number }) => void;
  closeTab: (id: string) => void;
  setActive: (region: DockRegion, id: string) => void;
  setTerminalStatus: (id: string, status: TerminalStatus, shellId?: string) => void;
  reorderTabs: (region: DockRegion, fromIndex: number, toIndex: number) => void;
  moveTabRegion: (id: string, targetRegion: DockRegion, insertIndex?: number) => void;
  openPage: (page: PageView) => void;
  openProjectContext: (workspace: string) => void;
  openSubAgent: (input: SubAgentOpenInput) => void;
  openSubAgentLog: (input: SubAgentLogPayload) => void;
  resetWorkspaceTabs: () => void;
}

/** 按需打开（或激活）某个子代理的右坞 tab。单任务 subIndex 传 null。 */
export interface SubAgentOpenInput {
  messageId: string;
  toolCallId: string;
  subIndex: number | null;
  title: string;
}

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

export const useDockStore = create<DockState>()(
  persist(
    (set) => ({
      tabs: [],
      activeByRegion: { right: null, bottom: null },

      addTab: (input) => {
        set((s) => {
          const order = input.order ?? nextOrder(s.tabs, input.region);
          const tab: DockTab = { ...input, order };
          return {
            tabs: [...s.tabs, tab],
            activeByRegion: { ...s.activeByRegion, [input.region]: tab.id },
          };
        });
        if (input.region === 'right') useLayoutStore.getState().setRightPanelOpen(true);
        else useLayoutStore.getState().setTerminalOpen(true);
      },

      closeTab: (id) =>
        set((s) => {
          const target = s.tabs.find((t) => t.id === id);
          if (!target) return s;
          const region = target.region;
          const regionTabs = s.tabs.filter((t) => t.region === region).sort((a, b) => a.order - b.order);
          const index = regionTabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          const activeByRegion = { ...s.activeByRegion };
          if (activeByRegion[region] === id) {
            const remaining = regionTabs.filter((t) => t.id !== id);
            const fallback = remaining[Math.max(0, index - 1)] ?? remaining[0] ?? null;
            activeByRegion[region] = fallback ? fallback.id : null;
          }
          return { tabs, activeByRegion };
        }),

      setActive: (region, id) =>
        set((s) => ({ activeByRegion: { ...s.activeByRegion, [region]: id } })),

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
        set((s) => {
          const tab = s.tabs.find((t) => t.id === id);
          if (!tab) return s;
          // 终端钉在底坞：拒绝移入右坞。
          if (tab.kind === 'terminal' && targetRegion === 'right') return s;
          if (tab.region === targetRegion) return s;

          const targetTabs = s.tabs.filter((t) => t.region === targetRegion).sort((a, b) => a.order - b.order);
          const at = insertIndex == null ? targetTabs.length : Math.max(0, Math.min(insertIndex, targetTabs.length));
          const movedTab: DockTab = { ...tab, region: targetRegion };
          const nextTarget = [...targetTabs.slice(0, at), movedTab, ...targetTabs.slice(at)].map((t, i) => ({ ...t, order: i }));
          moved = true;
          return {
            tabs: patchTabs(s.tabs, nextTarget),
            activeByRegion: { ...s.activeByRegion, [targetRegion]: id },
          };
        });
        if (!moved) return;
        if (targetRegion === 'right') useLayoutStore.getState().setRightPanelOpen(true);
        else useLayoutStore.getState().setTerminalOpen(true);
      },

      openPage: (page) => {
        const id = `page:${page.url}`;
        const title = page.title || page.url;
        set((s) => {
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs.map((t) => (t.id === id ? { ...t, title, payload: { ...page } } : t))
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
                },
              ];
          return { tabs, activeByRegion: { ...s.activeByRegion, right: id } };
        });
        useLayoutStore.getState().setRightPanelOpen(true);
      },

      openProjectContext: (workspace) => {
        const id = 'project-context';
        set((s) => {
          const exists = s.tabs.some((tab) => tab.id === id);
          const tabs = exists
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
                },
              ];
          return { tabs, activeByRegion: { ...s.activeByRegion, right: id } };
        });
        useLayoutStore.getState().setRightPanelOpen(true);
      },

      openSubAgentLog: (input) => {
        const id = `salog:${input.agentId}`;
        set((s) => {
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs.map((t) => (t.id === id ? { ...t, title: input.task, payload: { ...input } } : t))
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
                },
              ];
          return { tabs, activeByRegion: { ...s.activeByRegion, right: id } };
        });
        useLayoutStore.getState().setRightPanelOpen(true);
      },

      openSubAgent: ({ messageId, toolCallId, subIndex, title }) => {
        const id = subAgentTabId(messageId, subIndex);
        set((s) => {
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs.map((t) => (t.id === id ? { ...t, title } : t))
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
    }),
    {
      name: 'hermes-dock',
      // 终端 runtime shellId 不持久化，重置为 idle；subagent / subagentLog tab
      // 由 messages 同步或浮动列表点击重建，不持久化（output 可能很大）。
      partialize: (s) => ({
        tabs: s.tabs
          .filter((t) => t.kind !== 'subagent' && t.kind !== 'subagentLog')
          .map((t) => (t.kind === 'terminal' ? { ...t, payload: { status: 'idle' as const } } : t)),
        activeByRegion: s.activeByRegion,
      }),
    },
  ),
);
