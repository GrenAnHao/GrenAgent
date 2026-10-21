// 会话归档的渲染层动作：乐观标记、调主进程、失败回滚。切走当前会话由调用方（App）决定。
// Note: 见 .agents/notes/implemented/feature/2026-10-19-session-archive.md
import { pi, type SessionInfo } from '../../lib/pi';
import { pathsEquivalent } from '../../lib/pathUtils';
import { bumpSessionMutationEpoch, invalidateAllSessionsCache } from '../../lib/sessionCache';
import { useSessionStore } from '../../store/session';

/**
 * 乐观地把这些会话标成（取消）归档：侧栏立刻更新，主进程写完登记表后再重拉对齐。
 * 同时 bump 会话变更代次，丢掉在途、还是旧状态的全量列表。
 */
export function markSessionsArchived(paths: string[], archived: boolean): void {
  const apply = (list: SessionInfo[]) =>
    list.map((s) => (paths.some((p) => pathsEquivalent(p, s.path)) ? { ...s, archived } : s));
  useSessionStore.setState((s) => ({ allSessions: apply(s.allSessions), sessions: apply(s.sessions) }));
  bumpSessionMutationEpoch();
  invalidateAllSessionsCache();
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 归档成功返回 true。回合还在跑的会话不归档（侧栏菜单已置灰，这里再挡一次）。 */
export async function archiveSessionPaths(paths: string[], runningPaths: Iterable<string>): Promise<boolean> {
  if (paths.length === 0) return false;
  const st = useSessionStore.getState();
  const running = [...runningPaths];
  if (paths.some((p) => running.some((r) => pathsEquivalent(r, p)))) {
    st.setError('会话还在运行，停下后再归档');
    return false;
  }
  markSessionsArchived(paths, true);
  try {
    await pi.setSessionsArchived(paths, true);
    return true;
  } catch (error) {
    markSessionsArchived(paths, false);
    st.setError(`归档失败：${errorText(error)}`);
    return false;
  }
}

export async function unarchiveSessionPath(path: string): Promise<boolean> {
  markSessionsArchived([path], false);
  try {
    await pi.setSessionsArchived([path], false);
    return true;
  } catch (error) {
    markSessionsArchived([path], true);
    useSessionStore.getState().setError(`取消归档失败：${errorText(error)}`);
    return false;
  }
}

/** 对话一行代表 works 下一个目录：归档时这个目录下的会话一起归档，否则次新的那份会顶上来。 */
export function conversationSessionPaths(cwd: string): string[] {
  return useSessionStore
    .getState()
    .allSessions.filter((s) => s.cwd && pathsEquivalent(s.cwd, cwd))
    .map((s) => s.path);
}
