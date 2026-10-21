import { useMemo } from 'react';
import { useSidebarPrefsStore, type SidebarSectionId } from '../../stores/sidebarPrefsStore';
import type { ConversationItem } from './useConversations';
import { useConversations } from './useConversations';
import type { ProjectGroup } from './useProjectGroups';
import { useProjectGroups } from './useProjectGroups';
import type { SessionInfo } from '../../lib/pi';
import { pathsEquivalent } from '../../lib/pathUtils';

export const DEFAULT_VISIBLE = 5;

export type SidebarItem =
  | {
      type: 'section';
      key: string;
      id: SidebarSectionId;
      label: string;
      collapsed: boolean;
      action?: 'new-conversation' | 'new-project';
      /** 收起时藏起来的会话路径：区头用它算注意状态汇总。展开时没有。 */
      sessionPaths?: string[];
    }
  | { type: 'conversation'; key: string; item: ConversationItem }
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
  /** 最顶层分区的折叠状态：折叠的区只留区头。 */
  collapsedSections?: Partial<Record<SidebarSectionId, boolean>>;
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
    collapsedSections = {},
  } = params;
  const isSectionCollapsed = (id: SidebarSectionId) => collapsedSections[id] === true;
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

  const pushSection = (
    id: SidebarSectionId,
    label: string,
    action: 'new-conversation' | 'new-project' | undefined,
    hiddenPaths: () => string[],
  ): boolean => {
    const collapsed = isSectionCollapsed(id);
    items.push({
      type: 'section',
      key: `sec-${id}`,
      id,
      label,
      collapsed,
      ...(action ? { action } : {}),
      ...(collapsed ? { sessionPaths: hiddenPaths() } : {}),
    });
    return !collapsed;
  };
  const groupPaths = (groups: ProjectGroup[]) =>
    groups.flatMap((g) => g.sessions.filter((s) => !isPinnedSession(s.path)).map((s) => s.path));

  // 置顶对话/会话/项目都归入顶部「置顶」区（对齐 Codex：无图钉前缀，仅换区）。
  // 没有置顶项时连区头都不出；折叠时置顶的会话也不回到原项目里。
  if (pinnedGroups.length > 0 || liftedSessions.length > 0 || liftedConvs.length > 0) {
    const pinnedPaths = () => [
      ...liftedConvs.map((c) => c.sessionPath),
      ...liftedSessions.map(({ session }) => session.path),
      ...groupPaths(pinnedGroups),
    ];
    if (pushSection('pinned', '置顶', undefined, pinnedPaths)) {
      for (const c of liftedConvs) {
        items.push({ type: 'conversation', key: `conv-${c.cwd}`, item: c });
      }
      for (const { cwd, session } of liftedSessions) {
        items.push({ type: 'session', key: `sess-${session.path}`, cwd, session, pinned: true });
      }
      for (const g of pinnedGroups) pushGroup(g);
    }
  }

  if (pushSection('conversations', '对话', 'new-conversation', () => restConvs.map((c) => c.sessionPath))) {
    for (const c of restConvs) {
      items.push({ type: 'conversation', key: `conv-${c.cwd}`, item: c });
    }
  }

  if (pushSection('projects', '项目', 'new-project', () => groupPaths(normalGroups))) {
    for (const g of normalGroups) pushGroup(g);
  }

  return items;
}

export function useSidebarItems(showAllCwds: Set<string>): SidebarItem[] {
  const conversations = useConversations();
  const groups = useProjectGroups();
  const collapsed = useSidebarPrefsStore((s) => s.collapsed);
  const pinnedSessions = useSidebarPrefsStore((s) => s.pinnedSessions);
  const pinnedConversations = useSidebarPrefsStore((s) => s.pinnedConversations);
  const collapsedSections = useSidebarPrefsStore((s) => s.collapsedSections);

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
      collapsedSections,
    });
  }, [conversations, groups, collapsed, pinnedSessions, pinnedConversations, showAllCwds, collapsedSections]);
}
