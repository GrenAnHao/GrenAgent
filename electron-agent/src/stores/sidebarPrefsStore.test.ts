import { beforeEach, describe, expect, it } from 'vitest';
import { useSidebarPrefsStore } from './sidebarPrefsStore';

const reset = () =>
  useSidebarPrefsStore.setState({
    pinnedProjects: [],
    pinnedConversations: [],
    pinnedSessions: [],
    hiddenProjects: [],
    keptProjects: [],
    aliases: {},
    collapsed: {},
    collapsedSections: {},
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

  it('keeps an empty project across drop/keep', () => {
    const s = useSidebarPrefsStore.getState();
    s.keepProject('/ws/c');
    s.keepProject('/ws/c');
    expect(useSidebarPrefsStore.getState().keptProjects).toEqual(['/ws/c']);
    s.dropKeptProject('/ws/c');
    expect(useSidebarPrefsStore.getState().keptProjects).toEqual([]);
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

  it('top-level sections default to expanded and toggle independently', () => {
    const s = useSidebarPrefsStore.getState();
    s.toggleSectionCollapsed('conversations');
    expect(useSidebarPrefsStore.getState().collapsedSections).toEqual({ conversations: true });
    s.toggleSectionCollapsed('projects');
    s.toggleSectionCollapsed('conversations');
    expect(useSidebarPrefsStore.getState().collapsedSections).toEqual({ conversations: false, projects: true });
  });

  it('expandSection only opens a collapsed section', () => {
    const s = useSidebarPrefsStore.getState();
    const before = useSidebarPrefsStore.getState().collapsedSections;
    s.expandSection('projects');
    expect(useSidebarPrefsStore.getState().collapsedSections).toBe(before);
    s.toggleSectionCollapsed('projects');
    s.expandSection('projects');
    expect(useSidebarPrefsStore.getState().collapsedSections.projects).toBe(false);
  });

  it('pinning something expands a collapsed pinned section; unpinning leaves it alone', () => {
    const s = useSidebarPrefsStore.getState();
    s.toggleSectionCollapsed('pinned');
    s.togglePinnedSession('/s/a.jsonl');
    expect(useSidebarPrefsStore.getState().collapsedSections.pinned).toBe(false);

    s.toggleSectionCollapsed('pinned');
    s.togglePinnedSession('/s/a.jsonl');
    expect(useSidebarPrefsStore.getState().collapsedSections.pinned).toBe(true);

    s.togglePinnedConversation('/w/c');
    expect(useSidebarPrefsStore.getState().collapsedSections.pinned).toBe(false);
    s.toggleSectionCollapsed('pinned');
    s.togglePinnedProject('/ws/a');
    expect(useSidebarPrefsStore.getState().collapsedSections.pinned).toBe(false);
  });

  it('old persisted prefs without collapsedSections still load expanded sections', async () => {
    localStorage.setItem('pi-sidebar', JSON.stringify({ state: { pinnedProjects: ['/ws/old'] }, version: 0 }));
    await useSidebarPrefsStore.persist.rehydrate();
    const state = useSidebarPrefsStore.getState();
    expect(state.pinnedProjects).toEqual(['/ws/old']);
    expect(state.collapsedSections).toEqual({});
  });
});
