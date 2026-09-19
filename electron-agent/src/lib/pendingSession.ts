import { clearComposerUserPick } from '../features/chat/input/actions/ModelThinkingAction';
import { useSessionStore } from '../store/session';
import { pathsEquivalent } from './pathUtils';

/** 当前工作区还没有可写会话时，发送路径需要先 newSession。 */
export function needsSessionCreateOnSend(input: {
  workspace: string;
  activeSessionPath: string | null | undefined;
  draftConversationCwd: string | null | undefined;
}): boolean {
  if (input.draftConversationCwd && pathsEquivalent(input.draftConversationCwd, input.workspace)) {
    return true;
  }
  return !input.activeSessionPath;
}

/**
 * 点「新建对话 / 新建会话」只进入空白草稿：不落盘、不出现在侧栏。
 * 同工作区时 reset 当前消息区；切工作区只改 activeWorkspace，交给 Workspace effect。
 */
export function enterPendingNewSession(cwd: string, onSameWorkspace?: () => void): void {
  clearComposerUserPick(cwd);
  const st = useSessionStore.getState();
  st.setActiveSession('');
  st.setDraftConversation(cwd);
  if (st.activeWorkspace && pathsEquivalent(st.activeWorkspace, cwd)) {
    onSameWorkspace?.();
    return;
  }
  st.setActiveWorkspace(cwd);
}

/** 打开项目：有 last_session 则恢复；否则标成空白草稿，让输入栏走新会话默认模型。 */
export function applyOpenedProject(
  cwd: string,
  sessionFile: string | null | undefined,
  onSameWorkspace?: () => void,
): void {
  if (sessionFile) {
    const st = useSessionStore.getState();
    st.clearDraftConversation();
    st.setActiveSession(sessionFile);
    st.setWorkspaceSessionPath(cwd, sessionFile);
    if (!(st.activeWorkspace && pathsEquivalent(st.activeWorkspace, cwd))) {
      st.setActiveWorkspace(cwd);
    }
    return;
  }
  enterPendingNewSession(cwd, onSameWorkspace);
}
