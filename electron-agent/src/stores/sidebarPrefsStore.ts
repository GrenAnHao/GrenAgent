import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { pathsEquivalent } from '../lib/pathUtils';

/** 侧栏最顶层的三个分区。 */
export type SidebarSectionId = 'pinned' | 'conversations' | 'projects';

interface SidebarPrefsState {
  pinnedProjects: string[]; // 按 cwd
  pinnedConversations: string[]; // 按 conversation cwd
  pinnedSessions: string[]; // 按 session.path
  hiddenProjects: string[]; // 按 cwd
  keptProjects: string[]; // 清空会话后仍留在侧栏的项目 cwd（重启后仍在）
  aliases: Record<string, string>; // cwd -> 别名
  collapsed: Record<string, boolean>; // cwd -> 是否折叠（仅存非默认值）
  collapsedSections: Partial<Record<SidebarSectionId, boolean>>; // 分区 -> 是否折叠（默认展开）

  togglePinnedProject: (cwd: string) => void;
  togglePinnedConversation: (cwd: string) => void;
  togglePinnedSession: (path: string) => void;
  hideProject: (cwd: string) => void;
  unhideProject: (cwd: string) => void;
  keepProject: (cwd: string) => void;
  dropKeptProject: (cwd: string) => void;
  setAlias: (cwd: string, alias: string) => void;
  toggleCollapsed: (cwd: string, defaultCollapsed: boolean) => void;
  isCollapsed: (cwd: string, defaultCollapsed: boolean) => boolean;
  toggleSectionCollapsed: (id: SidebarSectionId) => void;
  expandSection: (id: SidebarSectionId) => void;
}

const toggle = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

/**
 * 置顶一项时，置顶区若是收起的就展开：不然刚置顶的那一行从原分区消失、又落进收起的区里，看起来像丢了。
 * 取消置顶不动分区。
 */
const pinPatch = (s: SidebarPrefsState, arr: string[], v: string) =>
  arr.includes(v) || !s.collapsedSections.pinned
    ? {}
    : { collapsedSections: { ...s.collapsedSections, pinned: false } };

export const useSidebarPrefsStore = create<SidebarPrefsState>()(
  persist(
    (set, get) => ({
      pinnedProjects: [],
      pinnedConversations: [],
      pinnedSessions: [],
      hiddenProjects: [],
      keptProjects: [],
      aliases: {},
      collapsed: {},
      collapsedSections: {},

      togglePinnedProject: (cwd) =>
        set((s) => ({ pinnedProjects: toggle(s.pinnedProjects, cwd), ...pinPatch(s, s.pinnedProjects, cwd) })),
      togglePinnedConversation: (cwd) =>
        set((s) => ({
          pinnedConversations: toggle(s.pinnedConversations, cwd),
          ...pinPatch(s, s.pinnedConversations, cwd),
        })),
      togglePinnedSession: (path) =>
        set((s) => ({ pinnedSessions: toggle(s.pinnedSessions, path), ...pinPatch(s, s.pinnedSessions, path) })),
      hideProject: (cwd) =>
        set((s) => ({
          hiddenProjects: s.hiddenProjects.includes(cwd)
            ? s.hiddenProjects
            : [...s.hiddenProjects, cwd],
        })),
      unhideProject: (cwd) =>
        set((s) => ({ hiddenProjects: s.hiddenProjects.filter((x) => x !== cwd) })),
      keepProject: (cwd) =>
        set((s) =>
          s.keptProjects.some((p) => pathsEquivalent(p, cwd))
            ? s
            : { keptProjects: [...s.keptProjects, cwd] },
        ),
      dropKeptProject: (cwd) =>
        set((s) => ({
          keptProjects: s.keptProjects.filter((p) => !pathsEquivalent(p, cwd)),
        })),
      setAlias: (cwd, alias) =>
        set((s) => {
          const next = { ...s.aliases };
          if (alias.trim()) next[cwd] = alias.trim();
          else delete next[cwd];
          return { aliases: next };
        }),
      toggleCollapsed: (cwd, defaultCollapsed) =>
        set((s) => ({
          collapsed: { ...s.collapsed, [cwd]: !get().isCollapsed(cwd, defaultCollapsed) },
        })),
      isCollapsed: (cwd, defaultCollapsed) => {
        const v = get().collapsed[cwd];
        return v === undefined ? defaultCollapsed : v;
      },
      toggleSectionCollapsed: (id) =>
        set((s) => ({ collapsedSections: { ...s.collapsedSections, [id]: !s.collapsedSections[id] } })),
      expandSection: (id) =>
        set((s) => (s.collapsedSections[id] ? { collapsedSections: { ...s.collapsedSections, [id]: false } } : s)),
    }),
    {
      name: 'pi-sidebar',
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<SidebarPrefsState>;
        return {
          ...current,
          ...stored,
          keptProjects: stored.keptProjects ?? current.keptProjects,
        };
      },
    },
  ),
);
