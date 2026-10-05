import { useCallback, useEffect, useState } from 'react';
import { pi, onPiEvent, type AgentEvent } from '../lib/pi';
import { pathsEquivalent } from '../lib/pathUtils';
import { mapSessionStats, type ContextStats } from '../lib/sessionStats';

const REFETCH_EVENTS = new Set(['agent_end', 'compaction_end', 'message_end']);

function shouldRefetch(event: AgentEvent): boolean {
  if (REFETCH_EVENTS.has(event.type)) {
    if (event.type === 'message_end') {
      return (event as { message: { role?: string } }).message?.role === 'assistant';
    }
    return true;
  }
  return false;
}

/**
 * sessionPath：画面上这份会话的 jsonl。同项目多个会话同时在跑时按它取统计，
 * 也只在它自己的事件上重拉；不给则打到项目前景会话。
 */
export function useSessionStats(workspace: string, refetchKey?: number, sessionPath?: string | null) {
  const [stats, setStats] = useState<ContextStats | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    try {
      const raw = sessionPath ? await pi.getSessionStats(workspace, sessionPath) : await pi.getSessionStats(workspace);
      setStats(mapSessionStats(raw));
      setError(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [workspace, sessionPath]);

  // 触发重拉：workspace 变 / refetch 重建，以及 refetchKey 变化——后者用于「打开旧会话时历史异步加载完成」
  // 的场景：切 workspace 那一刻 sidecar 会话往往尚未就绪、首拉为 0，历史加载进 store 后须再拉一次才有数据。
  useEffect(() => {
    void refetch();
  }, [refetch, refetchKey]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPiEvent((env) => {
      if (env.workspace !== workspace) return;
      if (sessionPath && env.sessionPath && !pathsEquivalent(env.sessionPath, sessionPath)) return;
      if (shouldRefetch(env.event)) void refetch();
    }).then((un) => {
      unlisten = un;
    });
    return () => unlisten?.();
  }, [workspace, sessionPath, refetch]);

  return { stats, error, loading, refetch };
}
