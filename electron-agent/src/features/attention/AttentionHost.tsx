import { App, Button } from 'antd';
import { useEffect } from 'react';
import { onAttentionOpen, pi } from '../../lib/pi';
import { pathsEquivalent } from '../../lib/pathUtils';
import { useSessionStore } from '../../store/session';
import type { AttentionKind } from '../../stores/attentionView';
import { listedSessionKeys, resolveSessionTarget, startSessionAttention } from '../../stores/sessionAttention';
import { friendlyTime } from '../sessions/useConversations';
import { createAttentionNotifier } from './attentionNotifier';
import { drawBadgeOverlay } from './badgeOverlay';
import { playChime } from './chime';
import { openSessionFromAttention } from './openSessionBridge';

const TOAST_TYPE: Record<AttentionKind, 'warning' | 'info' | 'error' | 'success'> = {
  approval: 'warning',
  choice: 'info',
  failed: 'error',
  blocked: 'warning',
  done: 'success',
};

function sessionTitleOf(path: string): string {
  const found = useSessionStore.getState().getMergedSessions().find((s) => pathsEquivalent(s.path, path));
  if (!found) return '会话';
  return found.name || friendlyTime(found.timestamp);
}

/** 用侧栏列表里的写法打开：事件 / 通知带回来的路径大小写、分隔符可能不同。 */
function openListed(workspace: string, path: string): void {
  const target = resolveSessionTarget(workspace, path);
  openSessionFromAttention(target.workspace, target.path);
}

/**
 * 会话注意状态的提醒端：启动状态跟踪，把状态转变交给主进程决定怎么提醒，窗口在前台时弹应用内提示，
 * 同步任务栏待处理数，系统通知被点击时打开那个会话。无可见 UI。
 */
export function AttentionHost() {
  const { notification } = App.useApp();

  useEffect(() => {
    startSessionAttention();
    const notifier = createAttentionNotifier({
      notify: (input) => pi.attentionNotify(input),
      badge: (count, overlayDataUrl) => pi.attentionBadge(count, overlayDataUrl),
      drawOverlay: drawBadgeOverlay,
      toast: {
        open: (cfg) =>
          notification.open({
            key: cfg.key,
            type: TOAST_TYPE[cfg.kind],
            title: cfg.title,
            description: cfg.body,
            duration: cfg.autoClose ? 8 : false,
            actions: (
              <Button size="small" type="primary" data-testid="attention-go" onClick={cfg.onGo}>
                前往
              </Button>
            ),
            props: { 'data-testid': 'attention-toast', 'data-kind': cfg.kind } as Record<string, string>,
          }),
        destroy: (key) => notification.destroy(key),
      },
      chime: playChime,
      clear: (path) => {
        void pi.attentionClear(path).catch(() => {});
      },
      openSession: openListed,
      titleOf: sessionTitleOf,
      listedKeys: listedSessionKeys,
    });
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onAttentionOpen((e) => openListed(e.workspace, e.sessionPath)).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      notifier.stop();
      unlisten?.();
    };
  }, [notification]);

  return null;
}
