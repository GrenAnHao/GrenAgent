import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useLayoutStore } from './layoutStore';
import type { ChatMessage } from './agentReducer';
import { taskLabel } from '../features/panels/subagentUtils';

export type DockRegion = 'right' | 'bottom';
export type DockTabKind = 'terminal' | 'page' | 'subagent' | 'subagentLog';
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
}

/** registry 后端子代理（无对应主对话消息时的兜底视图，仅有最终 output 文本）。 */
export interface SubAgentLogPayload {
  agentId: string;
  task: string;
  output: string;
  status: 'running' | 'done' | 'error';
}

export type DockTabPayload = TerminalPayload | PagePayload | SubAgentPayload | SubAgentLogPayload;

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
  openSubAgentLog: (input: SubAgentLogPayload) => void;
  syncSubAgentTabs: (messages: ChatMessage[]) => void;
  resetWorkspaceTabs: () => void;
}

type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>;

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

      syncSubAgentTabs: (messages) =>
        set((s) => {
          const spawn = messages.filter((m): m is ToolMessage => m.kind === 'tool' && m.toolName === 'spawn_agent');
          const wantIds = new Set(spawn.map((m) => m.id));
          const others = s.tabs.filter((t) => t.kind !== 'subagent');
          const keptById = new Map(
            s.tabs.filter((t) => t.kind === 'subagent' && wantIds.has(t.id)).map((t) => [t.id, t] as const),
          );
          let appendOrder = nextOrder(others, 'right') + keptById.size;

          const subTabs: DockTab[] = spawn.map((m, i) => {
            const title = `#${i + 1} ${taskLabel(m.args)}`;
            const existing = keptById.get(m.id);
            if (existing) return { ...existing, title };
            return {
              id: m.id,
              kind: 'subagent',
              region: 'right',
              title,
              closable: false,
              order: appendOrder++,
              payload: { messageId: m.id, toolCallId: m.toolCallId },
            };
          });

          const tabs = [...others, ...subTabs];
          const activeByRegion = { ...s.activeByRegion };
          (['right', 'bottom'] as DockRegion[]).forEach((region) => {
            const activeId = activeByRegion[region];
            if (activeId && !tabs.some((t) => t.id === activeId && t.region === region)) {
              activeByRegion[region] = tabs.filter((t) => t.region === region).at(-1)?.id ?? null;
            }
          });
          // 子代理流式中 messages 每帧变化都会调到这里，但 spawn_agent 的 id/标题/顺序通常没变。
          // 结构等价时返回原 state，避免每帧重建 tabs 触发整坞（TabStrip/TabBodyStack）重渲染。
          const sameTabs =
            tabs.length === s.tabs.length &&
            tabs.every((t, i) => {
              const o = s.tabs[i];
              return (
                !!o &&
                o.id === t.id &&
                o.kind === t.kind &&
                o.region === t.region &&
                o.title === t.title &&
                o.order === t.order &&
                o.closable === t.closable
              );
            });
          const sameActive =
            activeByRegion.right === s.activeByRegion.right &&
            activeByRegion.bottom === s.activeByRegion.bottom;
          if (sameTabs && sameActive) return s;
          return { tabs, activeByRegion };
        }),

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
