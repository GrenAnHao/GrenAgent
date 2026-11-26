import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useChatDraftStore } from '../../stores/chatDraftStore';
import { useComposerFilesStore } from '../chat/input/composerFiles';
import { agentStoreRegistry } from '../../stores/agentStoreRegistry';
import type { SessionInfo } from '../../lib/pi';
import { getSessionMutationEpoch } from '../../lib/sessionCache';
import { applyTransferOpened, restoreTransferProjection } from './sessionProjectTransferActions';
import {
  hasQueuedDraftHandoff,
  resetDraftHandoffs,
  subscribeDraftHandoff,
} from './sessionProjectTransferDraft';
import { consumeTransferOpen, resetTransferOpen } from './sessionProjectTransferScope';

const SOURCE = 'D:/repo';
const TARGET = 'D:/target';
const PATH = 'D:/s/repo/a.jsonl';

const session = (path: string, cwd: string, name = '会话'): SessionInfo => ({
  id: path,
  path,
  cwd,
  timestamp: '2026-11-01T00:00:00.000Z',
  name,
});

function reset() {
  localStorage.clear();
  resetDraftHandoffs();
  resetTransferOpen();
  useSessionStore.setState({
    sessions: [],
    allSessions: [],
    optimisticSessions: [],
    registeredProjects: [],
    activeWorkspace: SOURCE,
    activeSessionPath: PATH,
    workspaceSessionPaths: {},
    deletedSessionPaths: [],
    deletedConversationCwds: [],
  });
  useSidebarPrefsStore.setState({ pinnedSessions: [PATH], keptProjects: [], aliases: {}, collapsed: {}, hiddenProjects: [] });
  useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null }, activeBySession: {}, rightOpenBySession: {}, rightFillBySession: {} });
  useLayoutStore.setState({ rightPanelOpen: false, rightPanelFill: false });
  useChatDraftStore.setState({ drafts: {}, adoptions: {}, removed: {} });
  useComposerFilesStore.setState({ byKey: {}, adoptions: {}, removed: {} });
}

describe('session project transfer actions', () => {
  beforeEach(reset);

  it('moves the only matching entry, keeps title/pin, registers the target and clears the source binding', () => {
    useSessionStore.setState({
      sessions: [session(PATH, SOURCE, '要移动的'), session('D:/s/repo/b.jsonl', SOURCE, '留下的')],
      allSessions: [session(PATH, SOURCE, '要移动的'), session('D:/s/repo/b.jsonl', SOURCE, '留下的')],
      workspaceSessionPaths: { [SOURCE]: PATH },
    });
    const epoch = getSessionMutationEpoch();

    const result = applyTransferOpened({ sourceWorkspace: SOURCE, targetWorkspace: TARGET, sessionPath: PATH });

    const st = useSessionStore.getState();
    expect(result.clearedSourceBinding).toBe(true);
    expect(st.allSessions.find((s) => s.path === PATH)).toMatchObject({ cwd: TARGET, name: '要移动的' });
    expect(st.allSessions.filter((s) => s.path === PATH)).toHaveLength(1);
    expect(st.sessions.map((s) => s.path)).toEqual(['D:/s/repo/b.jsonl']);
    expect(st.workspaceSessionPaths[SOURCE]).toBe('');
    expect(st.registeredProjects).toContain(TARGET);
    expect(useSidebarPrefsStore.getState().keptProjects).toContain(TARGET);
    // 置顶按 path，保持原样
    expect(useSidebarPrefsStore.getState().pinnedSessions).toContain(PATH);
    expect(getSessionMutationEpoch()).toBeGreaterThan(epoch);
    // 这次 workspace 跳转要跳过 dock 重置
    expect(consumeTransferOpen(TARGET)).toBe(true);
  });

  it('does not touch other sessions or their drafts, and queues only this session draft for handoff', () => {
    useSessionStore.setState({ allSessions: [session(PATH, SOURCE), session('D:/s/repo/b.jsonl', SOURCE)] });
    useChatDraftStore.getState().setDraft('D:/s/repo/b.jsonl', '另一个会话的草稿');
    useChatDraftStore.getState().setDraft(PATH, '这份的草稿');
    const seen: string[] = [];
    const off = subscribeDraftHandoff((path) => seen.push(path));

    applyTransferOpened({ sourceWorkspace: SOURCE, targetWorkspace: TARGET, sessionPath: PATH });

    off();
    expect(seen).toEqual([PATH]);
    expect(hasQueuedDraftHandoff(PATH)).toBe(true);
    expect(useChatDraftStore.getState().getDraft('D:/s/repo/b.jsonl').text).toBe('另一个会话的草稿');
  });

  it('does not queue the draft again when retrying the open', () => {
    useSessionStore.setState({ allSessions: [session(PATH, SOURCE)] });
    applyTransferOpened({ sourceWorkspace: SOURCE, targetWorkspace: TARGET, sessionPath: PATH });
    // 消费掉排队项，模拟输入框已经转换过
    resetDraftHandoffs();
    applyTransferOpened({ sourceWorkspace: SOURCE, targetWorkspace: TARGET, sessionPath: PATH, handoffDraft: false, registerProject: false });
    expect(hasQueuedDraftHandoff(PATH)).toBe(false);
  });

  it('detaches only a source store that has this session loaded and no live activity', () => {
    const sourceStore = agentStoreRegistry.getOrCreate(SOURCE);
    sourceStore.reset();
    sourceStore.loadMessages([{ role: 'user', content: [{ type: 'text', text: '旧内容' }] } as never], {
      sessionPath: PATH,
      force: true,
    });
    useSessionStore.setState({ allSessions: [session(PATH, SOURCE)] });

    applyTransferOpened({ sourceWorkspace: SOURCE, targetWorkspace: TARGET, sessionPath: PATH });

    expect(sourceStore.getLoadedSessionPath()).toBeUndefined();
    agentStoreRegistry.release(SOURCE);
  });

  it('rolls the projection back to the source without touching a different session', () => {
    useSessionStore.setState({ allSessions: [session(PATH, TARGET), session('D:/s/repo/b.jsonl', TARGET)] });
    restoreTransferProjection(PATH, SOURCE);
    const st = useSessionStore.getState();
    expect(st.allSessions.find((s) => s.path === PATH)?.cwd).toBe(SOURCE);
    expect(st.allSessions.find((s) => s.path === 'D:/s/repo/b.jsonl')?.cwd).toBe(TARGET);
  });
});
