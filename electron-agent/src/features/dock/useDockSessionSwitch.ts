import { useEffect } from 'react';
import { useSessionStore } from '../../store/session';
import {
  currentDockView,
  dockSessionKey,
  dockViewOfState,
  useDockStore,
  type DockSessionView,
} from '../../stores/dockStore';

/**
 * 聊天会话切换时让坞跟着会话走：保存离开会话的激活 tab / 右面板展开态，恢复目标会话的。
 * 切会话常常是 setActiveSession + setActiveWorkspace 两次写入，用微任务合并成一次切换，
 * 避免把中间态（新路径+旧工作区 / 新工作区草稿）当成一次真实切换记下来。
 *
 * 草稿的身份是 draftId 而不是工作区：同一项目的两份未落盘草稿、或「草稿 → 另一份草稿」的切换
 * （activeSessionPath 都没变）也必须算一次视图切换，否则两份草稿的右栏会互相串。
 */
export function useDockSessionSwitch(): void {
  useEffect(() => {
    // 身份 = 视图 key；只在它变化时切换。
    let committedKey = dockSessionKey(currentDockView());
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const next: DockSessionView = currentDockView();
      const prev = previousView ?? next;
      previousView = null;
      const nextKey = dockSessionKey(next);
      const prevKey = committedKey;
      committedKey = nextKey;
      if (prevKey === nextKey) return;
      useDockStore.getState().switchSessionView(prev, next);
    };
    // 切换前的视图快照：setActiveSession / setDraftConversation / clearDraftConversation 之间可能有多次写入，
    // 取第一次变化前的完整 view（含 draftId），而不是从当前 store 反推。
    let previousView: DockSessionView | null = null;
    return useSessionStore.subscribe((state, prevState) => {
      if (
        state.activeSessionPath === prevState.activeSessionPath &&
        state.activeWorkspace === prevState.activeWorkspace &&
        state.draftConversationCwd === prevState.draftConversationCwd &&
        state.draftConversationId === prevState.draftConversationId
      ) {
        return;
      }
      if (!previousView) previousView = dockViewOfState(prevState);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    });
  }, []);
}
