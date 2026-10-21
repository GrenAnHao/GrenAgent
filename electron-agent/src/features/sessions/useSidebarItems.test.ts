import { describe, expect, it } from 'vitest';
import { buildSidebarItems, type SidebarItem } from './useSidebarItems';
import type { ConversationItem } from './useConversations';
import type { ProjectGroup } from './useProjectGroups';

const conv: ConversationItem = { cwd: '/w/c', sessionPath: '/w/c/s.json', name: '对话1', timestamp: '', isCurrent: false };
const mkSession = (p: string) => ({ path: p, name: p, cwd: '/p/g', timestamp: '' }) as ProjectGroup['sessions'][number];
const group: ProjectGroup = {
  cwd: '/p/g',
  name: '组1',
  isCurrent: true,
  pinned: false,
  sessions: [mkSession('s1'), mkSession('s2'), mkSession('s3'), mkSession('s4'), mkSession('s5'), mkSession('s6')],
  lastActivity: '',
};

const sectionIds = (items: SidebarItem[]) => items.flatMap((i) => (i.type === 'section' ? [i.id] : []));
const indexOfSection = (items: SidebarItem[], id: string) =>
  items.findIndex((i) => i.type === 'section' && i.id === id);

describe('buildSidebarItems section session paths', () => {
  const sectionOf = (items: SidebarItem[], id: string) =>
    items.find((i): i is Extract<SidebarItem, { type: 'section' }> => i.type === 'section' && i.id === id);

  it('lists the sessions hidden by a collapsed section', () => {
    const pinnedConv: ConversationItem = { ...conv, cwd: '/w/p', sessionPath: '/w/p/s.json' };
    const items = buildSidebarItems({
      conversations: [conv, pinnedConv],
      pinnedGroups: [],
      normalGroups: [group],
      collapsed: {},
      pinnedSessions: ['s2'],
      pinnedConversations: ['/w/p'],
      showAllCwds: new Set(),
      collapsedSections: { pinned: true, conversations: true, projects: true },
    });
    expect(sectionOf(items, 'pinned')?.sessionPaths).toEqual(['/w/p/s.json', 's2']);
    expect(sectionOf(items, 'conversations')?.sessionPaths).toEqual(['/w/c/s.json']);
    expect(sectionOf(items, 'projects')?.sessionPaths).toEqual(['s1', 's3', 's4', 's5', 's6']);
  });

  it('has no session paths on an expanded section', () => {
    const items = buildSidebarItems({
      conversations: [conv],
      pinnedGroups: [],
      normalGroups: [group],
      collapsed: {},
      pinnedSessions: [],
      showAllCwds: new Set(),
    });
    expect(sectionOf(items, 'conversations')?.sessionPaths).toBeUndefined();
  });
});

describe('buildSidebarItems', () => {
  it('flattens conversations and groups with section headers', () => {
    const items = buildSidebarItems({
      conversations: [conv],
      pinnedGroups: [],
      normalGroups: [group],
      collapsed: {},
      pinnedSessions: [],
      showAllCwds: new Set(),
    });
    const types = items.map((i) => i.type);
    expect(types[0]).toBe('section'); // 对话
    expect(sectionIds(items)).toEqual(['conversations', 'projects']);
    expect(types).toContain('conversation');
    expect(types).toContain('project');
    // isCurrent=true 默认展开，6 条 > DEFAULT_VISIBLE(5) → 5 session + 1 more
    expect(items.filter((i) => i.type === 'session')).toHaveLength(5);
    expect(items.filter((i) => i.type === 'more')).toHaveLength(1);
  });

  it('hides sessions when collapsed', () => {
    const items = buildSidebarItems({
      conversations: [],
      pinnedGroups: [],
      normalGroups: [group],
      collapsed: { '/p/g': true },
      pinnedSessions: [],
      showAllCwds: new Set(),
    });
    expect(items.filter((i) => i.type === 'session')).toHaveLength(0);
    expect(items.filter((i) => i.type === 'more')).toHaveLength(0);
  });

  it('shows all sessions when showAll set', () => {
    const items = buildSidebarItems({
      conversations: [],
      pinnedGroups: [],
      normalGroups: [group],
      collapsed: {},
      pinnedSessions: [],
      showAllCwds: new Set(['/p/g']),
    });
    expect(items.filter((i) => i.type === 'session')).toHaveLength(6);
    expect(items.filter((i) => i.type === 'more')).toHaveLength(0);
  });

  it('adds pinned label before pinned groups and above conversations', () => {
    const items = buildSidebarItems({
      conversations: [conv],
      pinnedGroups: [{ ...group, cwd: '/p/pin', pinned: true }],
      normalGroups: [],
      collapsed: { '/p/pin': true },
      pinnedSessions: [],
      showAllCwds: new Set(),
    });
    expect(sectionIds(items)).toEqual(['pinned', 'conversations', 'projects']);
    expect(indexOfSection(items, 'pinned')).toBe(0);
    expect(items.findIndex((i) => i.type === 'project')).toBeLessThan(indexOfSection(items, 'conversations'));
    expect(items.findIndex((i) => i.type === 'conversation')).toBeGreaterThan(indexOfSection(items, 'conversations'));
  });

  it('lifts a pinned session into the pinned section and does not duplicate it in the project', () => {
    const items = buildSidebarItems({
      conversations: [conv],
      pinnedGroups: [],
      normalGroups: [group],
      collapsed: {},
      pinnedSessions: ['s6'],
      showAllCwds: new Set(),
    });
    const convIdx = indexOfSection(items, 'conversations');
    const lifted = items.filter(
      (i): i is Extract<SidebarItem, { type: 'session' }> => i.type === 'session' && i.session.path === 's6',
    );
    expect(indexOfSection(items, 'pinned')).toBe(0);
    expect(lifted).toHaveLength(1);
    expect(lifted[0]?.pinned).toBe(true);
    expect(items.indexOf(lifted[0]!)).toBeLessThan(convIdx);
  });

  it('lifts a pinned conversation into the pinned section and keeps others under 对话', () => {
    const other: ConversationItem = { cwd: '/w/other', sessionPath: '/w/other/s.json', name: '对话2', timestamp: '', isCurrent: false };
    const items = buildSidebarItems({
      conversations: [conv, other],
      pinnedGroups: [],
      normalGroups: [],
      collapsed: {},
      pinnedSessions: [],
      pinnedConversations: ['/w/other'],
      showAllCwds: new Set(),
    });
    const convIdx = indexOfSection(items, 'conversations');
    const lifted = items.filter((i) => i.type === 'conversation' && i.item.cwd === '/w/other');
    const rest = items.filter((i) => i.type === 'conversation' && i.item.cwd === '/w/c');
    expect(indexOfSection(items, 'pinned')).toBe(0);
    expect(lifted).toHaveLength(1);
    expect(rest).toHaveLength(1);
    expect(items.indexOf(lifted[0]!)).toBeLessThan(convIdx);
    expect(items.indexOf(rest[0]!)).toBeGreaterThan(convIdx);
  });

  it('collapsed top-level sections keep only their header', () => {
    const other: ConversationItem = { cwd: '/w/other', sessionPath: '/w/other/s.json', name: '对话2', timestamp: '', isCurrent: false };
    const base = {
      conversations: [conv, other],
      pinnedGroups: [{ ...group, cwd: '/p/pin', pinned: true }],
      normalGroups: [group],
      collapsed: {},
      pinnedSessions: ['s6'],
      pinnedConversations: ['/w/other'],
      showAllCwds: new Set<string>(),
    };

    const all = buildSidebarItems({
      ...base,
      collapsedSections: { pinned: true, conversations: true, projects: true },
    });
    expect(all.map((i) => i.type)).toEqual(['section', 'section', 'section']);
    expect(all.every((i) => i.type === 'section' && i.collapsed)).toBe(true);
    // 新建入口跟着区头走，折叠了也在
    expect(all.map((i) => (i.type === 'section' ? i.action : null))).toEqual([undefined, 'new-conversation', 'new-project']);

    const onlyPinned = buildSidebarItems({ ...base, collapsedSections: { pinned: true } });
    // 置顶的会话 s6 不回到原项目，置顶的对话也不回「对话」区
    expect(onlyPinned.some((i) => i.type === 'session' && i.session.path === 's6')).toBe(false);
    expect(onlyPinned.some((i) => i.type === 'project' && i.group.cwd === '/p/pin')).toBe(false);
    expect(onlyPinned.filter((i) => i.type === 'conversation').map((i) => i.type === 'conversation' && i.item.cwd)).toEqual(['/w/c']);
    expect(onlyPinned.some((i) => i.type === 'project' && i.group.cwd === '/p/g')).toBe(true);

    const onlyConvs = buildSidebarItems({ ...base, collapsedSections: { conversations: true } });
    const convIdx = indexOfSection(onlyConvs, 'conversations');
    expect(onlyConvs[convIdx + 1]).toMatchObject({ type: 'section', id: 'projects' });
    // 置顶区里的对话不受「对话」区折叠影响
    expect(onlyConvs.some((i) => i.type === 'conversation' && i.item.cwd === '/w/other')).toBe(true);

    const onlyProjects = buildSidebarItems({ ...base, collapsedSections: { projects: true } });
    expect(onlyProjects[onlyProjects.length - 1]).toMatchObject({ type: 'section', id: 'projects', collapsed: true });
    expect(onlyProjects.some((i) => i.type === 'project' && i.group.cwd === '/p/pin')).toBe(true);
  });
});
