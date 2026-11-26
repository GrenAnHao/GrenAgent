import type { SessionInfo } from './pi';
import { isUnder, pathsEquivalent } from './pathUtils';

/**
 * 记住上次停在哪：哪个工作区、哪份会话（草稿时没有会话）。下次启动回到同一处，输入框草稿也按会话 key 跟着回来。
 * 见 .agents/notes/implemented/feature/2026-10-19-startup-restores-last-session.md
 */
export const LAST_OPEN_KEY = 'gren.lastOpen';

export interface LastOpen {
  workspace: string;
  /** 停在草稿（新建还没首发）时为 null。 */
  sessionPath: string | null;
  /** 未落盘对话的稳定身份；旧存档缺省时创建新身份。 */
  draftId?: string;
}

export function readLastOpen(): LastOpen | null {
  try {
    const raw = localStorage.getItem(LAST_OPEN_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { workspace, sessionPath, draftId } = parsed as Partial<LastOpen>;
    if (typeof workspace !== 'string' || !workspace) return null;
    return {
      workspace,
      sessionPath: typeof sessionPath === 'string' && sessionPath ? sessionPath : null,
      ...(typeof draftId === 'string' && draftId.startsWith('draft:') ? { draftId } : {}),
    };
  } catch {
    return null;
  }
}

export function writeLastOpen(value: LastOpen | null): void {
  try {
    if (!value) localStorage.removeItem(LAST_OPEN_KEY);
    else localStorage.setItem(LAST_OPEN_KEY, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function lastOpenEquals(a: LastOpen | null, b: LastOpen | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.workspace === b.workspace && a.sessionPath === b.sessionPath && a.draftId === b.draftId;
}

/** 会话 store 的当前位置 → 要记住的值；还没进任何工作区时为 null（启动过程中的空态不覆盖记忆）。 */
export function lastOpenFromState(state: {
  activeWorkspace: string;
  activeSessionPath: string | null;
  draftConversationCwd: string | null;
  draftConversationId?: string | null;
}): LastOpen | null {
  if (!state.activeWorkspace) return null;
  const draft = Boolean(
    state.draftConversationCwd && pathsEquivalent(state.draftConversationCwd, state.activeWorkspace),
  );
  return {
    workspace: state.activeWorkspace,
    sessionPath: draft ? null : state.activeSessionPath || null,
    ...(draft && state.draftConversationId ? { draftId: state.draftConversationId } : {}),
  };
}

export type StartupTarget =
  | { kind: 'session'; workspace: string; session: SessionInfo }
  | { kind: 'projectDraft'; workspace: string; draftId?: string }
  | null;

/** 只核对记住的那份会话或草稿，不需要先构造全局侧栏目录。 */
export async function pickStartupTarget(
  remembered: LastOpen | null,
  disk: {
    lookupStartupSession: (path: string) => Promise<SessionInfo | null>;
    getWorksDir: () => Promise<string>;
    startupScratchHasSessions: (workspace: string) => Promise<boolean>;
  },
): Promise<StartupTarget> {
  if (!remembered) return null;
  if (remembered.sessionPath) {
    const hit = await disk.lookupStartupSession(remembered.sessionPath);
    if (!hit || hit.archived) return null;
    return { kind: 'session', workspace: hit.cwd || remembered.workspace, session: hit };
  }
  const worksDir = await disk.getWorksDir().catch(() => '');
  if (worksDir && isUnder(remembered.workspace, worksDir)) {
    if (!remembered.draftId || await disk.startupScratchHasSessions(remembered.workspace)) return null;
  }
  return { kind: 'projectDraft', workspace: remembered.workspace, ...(remembered.draftId ? { draftId: remembered.draftId } : {}) };
}
