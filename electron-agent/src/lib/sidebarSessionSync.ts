import { fallbackSessionTitle } from '@extensions/_shared/session-title';
import { pi } from './pi';
import { isUnder } from './pathUtils';
import { useSessionStore } from '../store/session';

interface RpcSessionState {
  sessionFile?: string;
}

/** 首条消息发送后立刻在侧栏占位（pi 延迟落盘，list_all_sessions 扫不到）。 */
export async function syncSidebarOnSend(cwd: string, text: string, images = 0): Promise<void> {
  const st = useSessionStore.getState();
  let path: string | null = st.activeSessionPath ?? st.workspaceSessionPaths[cwd] ?? null;
  if (!path) {
    try {
      const state = (await pi.getState(cwd)) as RpcSessionState;
      path = state.sessionFile ?? null;
      if (path) st.setActiveSession(path);
    } catch {
      /* ignore */
    }
  }
  if (!path) return;

  // 和主进程列会话时同一套兑底：粘贴块、/skill: 调用、图片说明不原样当标题。
  st.upsertOptimisticSession({
    id: `opt-${path}`,
    path,
    cwd,
    timestamp: new Date().toISOString(),
    name: fallbackSessionTitle(text, images),
  });

  if (st.worksDir && !isUnder(cwd, st.worksDir)) st.registerProject(cwd);
}
