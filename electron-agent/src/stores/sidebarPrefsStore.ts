import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SidebarPrefsState {
  pinnedProjects: string[]; // 按 cwd
  pinnedConversations: string[]; // 按 conversation cwd
  pinnedSessions: string[]; // 按 session.path
  hiddenProjects: string[]; // 按 cwd
  aliases: Record<string, string>; // cwd -> 别名
  collapsed: Record<string, boolean>; // cwd -> 是否折叠（仅存非默认值）

  togglePinnedProject: (cwd: string) => void;
  togglePinnedConversation: (cwd: string) => void;
  togglePinnedSession: (path: string) => void;
  hideProject: (cwd: string) => void;
  unhideProject: (cwd: string) => void;
  setAlias: (cwd: string, alias: string) => void;
  toggleCollapsed: (cwd: string, defaultCollapsed: boolean) => void;
  isCollapsed: (cwd: string, defaultCollapsed: boolean) => boolean;
}

const toggle = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

export const useSidebarPrefsStore = create<SidebarPrefsState>()(
  persist(
    (set, get) => ({
      pinnedProjects: [],
      pinnedConversations: [],
      pinnedSessions: [],
      hiddenProjects: [],
      aliases: {},
      collapsed: {},

      togglePinnedProject: (cwd) =>
        set((s) => ({ pinnedProjects: toggle(s.pinnedProjects, cwd) })),
      togglePinnedConversation: (cwd) =>
        set((s) => ({ pinnedConversations: toggle(s.pinnedConversations, cwd) })),
      togglePinnedSession: (path) =>
        set((s) => ({ pinnedSessions: toggle(s.pinnedSessions, path) })),
      hideProject: (cwd) =>
        set((s) => ({
          hiddenProjects: s.hiddenProjects.includes(cwd)
            ? s.hiddenProjects
            : [...s.hiddenProjects, cwd],
        })),
      unhideProject: (cwd) =>
        set((s) => ({ hiddenProjects: s.hiddenProjects.filter((x) => x !== cwd) })),
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
    }),
    { name: 'pi-sidebar' },
  ),
);
