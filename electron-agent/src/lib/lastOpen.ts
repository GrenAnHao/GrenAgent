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
}

export function readLastOpen(): LastOpen | null {
  try {
    const raw = localStorage.getItem(LAST_OPEN_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { workspace, sessionPath } = parsed as Partial<LastOpen>;
    if (typeof workspace !== 'string' || !workspace) return null;
    return { workspace, sessionPath: typeof sessionPath === 'string' && sessionPath ? sessionPath : null };
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
  return a.workspace === b.workspace && a.sessionPath === b.sessionPath;
}

/** 会话 store 的当前位置 → 要记住的值；还没进任何工作区时为 null（启动过程中的空态不覆盖记忆）。 */
export function lastOpenFromState(state: {
  activeWorkspace: string;
  activeSessionPath: string | null;
  draftConversationCwd: string | null;
}): LastOpen | null {
  if (!state.activeWorkspace) return null;
  const draft = Boolean(
    state.draftConversationCwd && pathsEquivalent(state.draftConversationCwd, state.activeWorkspace),
  );
  return { workspace: state.activeWorkspace, sessionPath: draft ? null : state.activeSessionPath || null };
}

export type StartupTarget =
  | { kind: 'session'; workspace: string; sessionPath: string }
  | { kind: 'projectDraft'; workspace: string }
  | null;

/**
 * 启动时回到哪：
 * - 记住的会话仍在磁盘列表里且没归档 → 打开它（工作区以列表里的 cwd 为准）。
 * - 记住的是项目里的草稿（不在 works 目录下、没有会话）→ 回到那个项目的空草稿。
 * - 其余（没记忆、会话已删 / 已归档、works 下的空白对话）→ null，走原来的空白对话逻辑。
 */
export function pickStartupTarget(
  remembered: LastOpen | null,
  sessions: readonly SessionInfo[],
  worksDir: string,
): StartupTarget {
  if (!remembered) return null;
  if (remembered.sessionPath) {
    const hit = sessions.find((s) => pathsEquivalent(s.path, remembered.sessionPath!));
    if (!hit || hit.archived) return null;
    return { kind: 'session', workspace: hit.cwd || remembered.workspace, sessionPath: hit.path };
  }
  if (worksDir && isUnder(remembered.workspace, worksDir)) return null;
  return { kind: 'projectDraft', workspace: remembered.workspace };
}
