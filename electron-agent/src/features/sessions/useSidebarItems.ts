import { useMemo } from 'react';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import type { ConversationItem } from './useConversations';
import { useConversations } from './useConversations';
import type { ProjectGroup } from './useProjectGroups';
import { useProjectGroups } from './useProjectGroups';
import type { SessionInfo } from '../../lib/pi';
import { pathsEquivalent } from '../../lib/pathUtils';

export const DEFAULT_VISIBLE = 5;

export type SidebarItem =
  | { type: 'section'; key: string; label: string; action: 'new-conversation' | 'new-project' }
  | { type: 'conversation'; key: string; item: ConversationItem }
  | { type: 'pinned-label'; key: string }
  | { type: 'project'; key: string; group: ProjectGroup; expanded: boolean }
  | { type: 'session'; key: string; cwd: string; session: SessionInfo; pinned: boolean }
  | { type: 'more'; key: string; cwd: string; remaining: number };

interface BuildParams {
  conversations: ConversationItem[];
  pinnedGroups: ProjectGroup[];
  normalGroups: ProjectGroup[];
  collapsed: Record<string, boolean>;
  pinnedSessions: string[];
  pinnedConversations?: string[];
  showAllCwds: Set<string>;
}

export function buildSidebarItems(params: BuildParams): SidebarItem[] {
  const {
    conversations,
    pinnedGroups,
    normalGroups,
    collapsed,
    pinnedSessions,
    pinnedConversations = [],
    showAllCwds,
  } = params;
  const isPinnedSession = (path: string) => pinnedSessions.some((p) => pathsEquivalent(p, path));
  const isPinnedConversation = (cwd: string) =>
    pinnedConversations.some((p) => pathsEquivalent(p, cwd));
  const items: SidebarItem[] = [];

  const pushGroup = (g: ProjectGroup) => {
    const expanded = collapsed[g.cwd] === undefined ? g.isCurrent : !collapsed[g.cwd];
    items.push({ type: 'project', key: `proj-${g.cwd}`, group: g, expanded });
    if (!expanded) return;
    const remaining = g.sessions.filter((s) => !isPinnedSession(s.path));
    const showAll = showAllCwds.has(g.cwd);
    const visible = showAll ? remaining : remaining.slice(0, DEFAULT_VISIBLE);
    for (const s of visible) {
      items.push({ type: 'session', key: `sess-${s.path}`, cwd: g.cwd, session: s, pinned: false });
    }
    const hidden = remaining.length - visible.length;
    if (hidden > 0) items.push({ type: 'more', key: `more-${g.cwd}`, cwd: g.cwd, remaining: hidden });
  };

  const liftedSessions: { cwd: string; session: SessionInfo }[] = [];
  for (const g of [...pinnedGroups, ...normalGroups]) {
    for (const s of g.sessions) {
      if (isPinnedSession(s.path)) liftedSessions.push({ cwd: g.cwd, session: s });
    }
  }
  const liftedConvs = conversations.filter((c) => isPinnedConversation(c.cwd));
  const restConvs = conversations.filter((c) => !isPinnedConversation(c.cwd));

  // 置顶对话/会话/项目都归入顶部「置顶」区（对齐 Codex：无图钉前缀，仅换区）
  if (pinnedGroups.length > 0 || liftedSessions.length > 0 || liftedConvs.length > 0) {
    items.push({ type: 'pinned-label', key: 'pinned-label' });
    for (const c of liftedConvs) {
      items.push({ type: 'conversation', key: `conv-${c.cwd}`, item: c });
    }
    for (const { cwd, session } of liftedSessions) {
      items.push({ type: 'session', key: `sess-${session.path}`, cwd, session, pinned: true });
    }
    for (const g of pinnedGroups) pushGroup(g);
  }

  items.push({ type: 'section', key: 'sec-conv', label: '对话', action: 'new-conversation' });
  for (const c of restConvs) {
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
  const pinnedConversations = useSidebarPrefsStore((s) => s.pinnedConversations);

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
      pinnedConversations,
      showAllCwds,
    });
  }, [conversations, groups, collapsed, pinnedSessions, pinnedConversations, showAllCwds]);
}
