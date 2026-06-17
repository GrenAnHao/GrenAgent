import { useMemo } from 'react';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import type { ConversationItem } from './useConversations';
import { useConversations } from './useConversations';
import type { ProjectGroup } from './useProjectGroups';
import { useProjectGroups } from './useProjectGroups';
import type { SessionInfo } from '../../lib/pi';

export const DEFAULT_VISIBLE = 5;

export type SidebarItem =
  | { type: 'section'; key: string; label: string; action: 'new-conversation' | 'new-project' }
  | { type: 'conversation'; key: string; item: ConversationItem }
  | { type: 'pinned-label'; key: string }
  | { type: 'project'; key: string; group: ProjectGroup; expanded: boolean }
  | { type: 'session'; key: string; cwd: string; session: SessionInfo; pinned: boolean }
  | { type: 'more'; key: string; cwd: string; total: number };

interface BuildParams {
  conversations: ConversationItem[];
  pinnedGroups: ProjectGroup[];
  normalGroups: ProjectGroup[];
  collapsed: Record<string, boolean>;
  pinnedSessions: string[];
  showAllCwds: Set<string>;
}

export function buildSidebarItems(params: BuildParams): SidebarItem[] {
  const { conversations, pinnedGroups, normalGroups, collapsed, pinnedSessions, showAllCwds } = params;
  const pinnedSet = new Set(pinnedSessions);
  const items: SidebarItem[] = [];

  const pushGroup = (g: ProjectGroup) => {
    const expanded = collapsed[g.cwd] === undefined ? g.isCurrent : !collapsed[g.cwd];
    items.push({ type: 'project', key: `proj-${g.cwd}`, group: g, expanded });
    if (!expanded) return;
    const showAll = showAllCwds.has(g.cwd);
    const visible = showAll ? g.sessions : g.sessions.slice(0, DEFAULT_VISIBLE);
    for (const s of visible) {
      items.push({ type: 'session', key: `sess-${s.path}`, cwd: g.cwd, session: s, pinned: pinnedSet.has(s.path) });
    }
    const hidden = g.sessions.length - visible.length;
    if (hidden > 0) items.push({ type: 'more', key: `more-${g.cwd}`, cwd: g.cwd, total: g.sessions.length });
  };

  // 置顶项目放在「对话」分区之上（对齐 Codex 侧栏顺序）
  if (pinnedGroups.length > 0) {
    items.push({ type: 'pinned-label', key: 'pinned-label' });
    for (const g of pinnedGroups) pushGroup(g);
  }

  items.push({ type: 'section', key: 'sec-conv', label: '对话', action: 'new-conversation' });
  for (const c of conversations) {
    items.push({ type: 'conversation', key: `conv-${c.cwd}`, item: c });
  }

  items.push({ type: 'section', key: 'sec-proj', label: '项目', action: 'new-project' });
  for (const g of normalGroups) pushGroup(g);

  return items;
}

export function useSidebarItems(showAllCwds: Set<string>): SidebarItem[] {
  const conversations = useConversations();
  const groups = useProjectGroups();
  const collapsed = useSidebarPrefsStore((s) => s.collapsed);
  const pinnedSessions = useSidebarPrefsStore((s) => s.pinnedSessions);

  return useMemo(() => {
    const pinnedGroups: ProjectGroup[] = [];
    const normalGroups: ProjectGroup[] = [];
    for (const g of groups) (g.pinned ? pinnedGroups : normalGroups).push(g);
    return buildSidebarItems({
      conversations,
      pinnedGroups,
      normalGroups,
      collapsed,
      pinnedSessions,
      showAllCwds,
    });
  }, [conversations, groups, collapsed, pinnedSessions, showAllCwds]);
}
