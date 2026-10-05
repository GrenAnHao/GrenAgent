import { useEffect } from 'react';
import { useSessionStore } from '../../store/session';
import { dockSessionKey, useDockStore, type DockSessionView } from '../../stores/dockStore';

function viewOf(s: { activeSessionPath: string | null; activeWorkspace: string }): DockSessionView {
  return { sessionPath: s.activeSessionPath || null, workspace: s.activeWorkspace ?? '' };
}

/**
 * 聊天会话切换时让坞跟着会话走：保存离开会话的激活 tab / 右面板展开态，恢复目标会话的。
 * 切会话常常是 setActiveSession + setActiveWorkspace 两次写入，用微任务合并成一次切换，
 * 避免把中间态（新路径+旧工作区 / 新工作区草稿）当成一次真实切换记下来。
 */
export function useDockSessionSwitch(): void {
  useEffect(() => {
    let committed = viewOf(useSessionStore.getState());
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const next = viewOf(useSessionStore.getState());
      const prev = committed;
      committed = next;
      if (dockSessionKey(prev) === dockSessionKey(next)) return;
      useDockStore.getState().switchSessionView(prev, next);
    };
    return useSessionStore.subscribe((state, prevState) => {
      if (
        state.activeSessionPath === prevState.activeSessionPath &&
        state.activeWorkspace === prevState.activeWorkspace
      ) {
        return;
      }
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    });
  }, []);
}
