import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../lib/pi';

/**
 * 列表代次：迁移成功会 bump 逻辑代次，提交前发出的 list 响应回来后必须作废。
 * 这里只替换主进程 I/O，走真实的 refresh 逻辑（App 内的同名实现随 App 一起被重建，这里按同一算法验证）。
 */

const SOURCE = 'D:/repo';
const TARGET = 'D:/target';
const PATH = 'D:/s/repo/a.jsonl';

const session = (path: string, cwd: string): SessionInfo => ({
  id: path,
  path,
  cwd,
  timestamp: '2026-11-01T00:00:00.000Z',
  name: '会话',
});

const hoisted = vi.hoisted(() => ({
  listAllSessions: vi.fn(),
}));

vi.mock('../../lib/pi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pi')>();
  return { ...actual, pi: { ...actual.pi, listAllSessions: hoisted.listAllSessions } };
});

import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import {
  bumpSessionMutationEpoch,
  getSessionMutationEpoch,
  invalidateAllSessionsCache,
  isFreshResponse,
} from '../../lib/sessionCache';
import { applyTransferOpened } from './sessionProjectTransferActions';
import { resetDraftHandoffs } from './sessionProjectTransferDraft';
import { resetTransferOpen } from './sessionProjectTransferScope';
import { resetTransferOriginsForTests } from '../../lib/sessionTransferOrigin';

beforeEach(() => {
  localStorage.clear();
  resetDraftHandoffs();
  resetTransferOpen();
  resetTransferOriginsForTests();
  invalidateAllSessionsCache();
  hoisted.listAllSessions.mockReset();
  useSessionStore.setState({
    sessions: [],
    allSessions: [session(PATH, SOURCE), session('D:/s/repo/b.jsonl', SOURCE)],
    optimisticSessions: [],
    registeredProjects: [],
    activeWorkspace: SOURCE,
    activeSessionPath: PATH,
    workspaceSessionPaths: {},
    deletedSessionPaths: [],
    deletedConversationCwds: [],
  });
  useSidebarPrefsStore.setState({ pinnedSessions: [], keptProjects: [], aliases: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('transfer list generation', () => {
  it('drops a list response that started before the transfer committed', async () => {
    const startedEpoch = getSessionMutationEpoch();
    // 模拟提交前发出、迁移后才回来的旧列表
    const stale = [session(PATH, SOURCE), session('D:/s/repo/b.jsonl', SOURCE)];

    applyTransferOpened({ sourceWorkspace: SOURCE, targetWorkspace: TARGET, sessionPath: PATH });
    expect(isFreshResponse(startedEpoch)).toBe(false);

    // 应用层规则：旧响应作废，不把会话放回源项目
    if (isFreshResponse(startedEpoch)) useSessionStore.getState().syncAllSessions(stale);
    const all = useSessionStore.getState().allSessions;
    expect(all.filter((s) => s.path === PATH)).toHaveLength(1);
    expect(all.find((s) => s.path === PATH)?.cwd).toBe(TARGET);
  });

  it('accepts a list response that started after the transfer and never duplicates the session', async () => {
    applyTransferOpened({ sourceWorkspace: SOURCE, targetWorkspace: TARGET, sessionPath: PATH });
    const startedEpoch = getSessionMutationEpoch();
    const authoritative = [session(PATH, TARGET), session('D:/s/repo/b.jsonl', SOURCE)];
    hoisted.listAllSessions.mockResolvedValue(authoritative);

    // 真实刷新链（与 App 内 refreshAllSessions 相同的代次判定）
    const sessions = await hoisted.listAllSessions();
    if (isFreshResponse(startedEpoch)) useSessionStore.getState().syncAllSessions(sessions);

    const all = useSessionStore.getState().allSessions;
    expect(all.filter((s) => s.path === PATH)).toHaveLength(1);
    expect(all.find((s) => s.path === PATH)?.cwd).toBe(TARGET);
    expect(all.find((s) => s.path === 'D:/s/repo/b.jsonl')?.cwd).toBe(SOURCE);
  });

  it('bumping the epoch once invalidates every earlier response', () => {
    const first = getSessionMutationEpoch();
    const second = bumpSessionMutationEpoch() - 1;
    expect(isFreshResponse(first)).toBe(false);
    expect(isFreshResponse(second)).toBe(false);
    expect(isFreshResponse(getSessionMutationEpoch())).toBe(true);
  });
});
