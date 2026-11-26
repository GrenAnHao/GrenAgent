import { useCallback, useEffect, useRef, useState } from 'react';
import { pi, onPiEvent, type AgentEvent } from '../lib/pi';
import { pathsEquivalent } from '../lib/pathUtils';
import { mapSessionStats, type ContextStats } from '../lib/sessionStats';

const REFETCH_EVENTS = new Set(['agent_end', 'compaction_end', 'message_end']);
const completedContexts = new Map<string, { ownerEpoch?: string; revision: number }>();
let trackingStarted = false;
function trackCompletedContexts(): void {
  if (trackingStarted) return;
  trackingStarted = true;
  void onPiEvent((env) => {
    if (env.source === 'goal' || env.source === 'subagent' || env.event.type !== 'compaction_end' || !env.sessionPath) return;
    const event = env.event as { contextRevision?: number; ownerEpoch?: string };
    if (event.contextRevision === undefined) return;
    const key = `${env.workspace}\0${env.sessionPath.toLowerCase().replaceAll('\\', '/')}`;
    const current = completedContexts.get(key);
    if (!current || current.ownerEpoch !== event.ownerEpoch || event.contextRevision > current.revision) {
      completedContexts.set(key, { ownerEpoch: event.ownerEpoch, revision: event.contextRevision });
    }
  });
}
function contextKey(workspace: string, path: string): string {
  return `${workspace}\0${path.toLowerCase().replaceAll('\\', '/')}`;
}

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
export function useSessionStats(workspace: string, refetchKey?: number | string, sessionPath?: string | null) {
  const [stats, setStats] = useState<ContextStats | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const owner = useRef('');
  const displayedOwner = useRef('');
  const identity = contextKey(workspace, sessionPath ?? '');
  if (owner.current !== identity) { owner.current = identity; generation.current++; }

  const refetch = useCallback(async () => {
    if (!workspace) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const raw = sessionPath ? await pi.getSessionStats(workspace, sessionPath) : await pi.getSessionStats(workspace);
      if (request !== generation.current) return;
      if (sessionPath && raw.sessionPath && !pathsEquivalent(raw.sessionPath, sessionPath)) return;
      if (sessionPath && raw.sessionFile && !pathsEquivalent(raw.sessionFile, sessionPath)) return;
      const finalized = completedContexts.get(contextKey(workspace, sessionPath ?? raw.sessionFile ?? ''));
      if (finalized && finalized.ownerEpoch === raw.ownerEpoch && (raw.contextRevision ?? 0) < finalized.revision) {
        // A pre-compaction request returned late; re-read the actual finalized context.
        void refetch();
        return;
      }
      setStats(mapSessionStats(raw));
      setError(undefined);
    } catch (e) {
      if (request === generation.current) setError(String(e));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [workspace, sessionPath]);

  // 触发重拉：workspace 变 / refetch 重建，以及 refetchKey 变化——后者用于「打开旧会话时历史异步加载完成」
  // 的场景：切 workspace 那一刻 会话宿主 会话往往尚未就绪、首拉为 0，历史加载进 store 后须再拉一次才有数据。
  useEffect(() => {
    trackCompletedContexts();
    if (displayedOwner.current !== identity) {
      displayedOwner.current = identity;
      setStats(null);
    }
    void refetch();
    return () => { generation.current++; };
  }, [refetch, refetchKey]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onPiEvent((env) => {
      if (env.workspace !== workspace) return;
      if (sessionPath && (!env.sessionPath || !pathsEquivalent(env.sessionPath, sessionPath))) return;
      if (shouldRefetch(env.event)) void refetch();
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => { disposed = true; unlisten?.(); };
  }, [workspace, sessionPath, refetch]);

  return { stats, error, loading, refetch };
}
