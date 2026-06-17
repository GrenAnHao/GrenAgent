import { describe, expect, it } from 'vitest';
import { buildSidebarItems } from './useSidebarItems';
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
    const types = items.map((i) => i.type);
    expect(types[0]).toBe('pinned-label');
    expect(types.indexOf('pinned-label')).toBeLessThan(types.indexOf('section'));
    expect(types.indexOf('conversation')).toBeGreaterThan(types.indexOf('pinned-label'));
  });
});
