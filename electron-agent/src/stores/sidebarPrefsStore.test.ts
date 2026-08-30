import { beforeEach, describe, expect, it } from 'vitest';
import { useSidebarPrefsStore } from './sidebarPrefsStore';

const reset = () =>
  useSidebarPrefsStore.setState({
    pinnedProjects: [],
    pinnedSessions: [],
    hiddenProjects: [],
    aliases: {},
    collapsed: {},
  });

describe('sidebarPrefsStore', () => {
  beforeEach(reset);

  it('toggles a pinned project', () => {
    const { togglePinnedProject } = useSidebarPrefsStore.getState();
    togglePinnedProject('/ws/a');
    expect(useSidebarPrefsStore.getState().pinnedProjects).toContain('/ws/a');
    togglePinnedProject('/ws/a');
    expect(useSidebarPrefsStore.getState().pinnedProjects).not.toContain('/ws/a');
  });

  it('toggles a pinned session', () => {
    const { togglePinnedSession } = useSidebarPrefsStore.getState();
    togglePinnedSession('/s/a.jsonl');
    expect(useSidebarPrefsStore.getState().pinnedSessions).toContain('/s/a.jsonl');
    togglePinnedSession('/s/a.jsonl');
    expect(useSidebarPrefsStore.getState().pinnedSessions).not.toContain('/s/a.jsonl');
  });

  it('sets and clears a project alias', () => {
    const { setAlias } = useSidebarPrefsStore.getState();
    setAlias('/ws/a', 'My Project');
    expect(useSidebarPrefsStore.getState().aliases['/ws/a']).toBe('My Project');
    setAlias('/ws/a', '   ');
    expect(useSidebarPrefsStore.getState().aliases['/ws/a']).toBeUndefined();
  });

  it('hides a project idempotently and can unhide', () => {
    const s = useSidebarPrefsStore.getState();
    s.hideProject('/ws/b');
    s.hideProject('/ws/b');
    expect(useSidebarPrefsStore.getState().hiddenProjects).toEqual(['/ws/b']);
    s.unhideProject('/ws/b');
    expect(useSidebarPrefsStore.getState().hiddenProjects).not.toContain('/ws/b');
  });

  it('collapse falls back to default then can be toggled', () => {
    const s = useSidebarPrefsStore.getState();
    expect(s.isCollapsed('/ws/x', true)).toBe(true);
    expect(s.isCollapsed('/ws/x', false)).toBe(false);
    s.toggleCollapsed('/ws/x', true);
    expect(useSidebarPrefsStore.getState().isCollapsed('/ws/x', true)).toBe(false);
  });
});
