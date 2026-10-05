type SessionTitleListener = (sessionFile: string | undefined) => void;

function listeners(): Set<SessionTitleListener> {
  const g = globalThis as { __piAutoTitleListeners?: Set<SessionTitleListener> };
  return (g.__piAutoTitleListeners ??= new Set());
}

/** 原会话已不是当前 pi 时，标题写入文件后通知宿主刷新侧栏。 */
export function subscribeSessionTitleWritten(listener: SessionTitleListener): () => void {
  const set = listeners();
  set.add(listener);
  return () => set.delete(listener);
}

export function notifySessionTitleWritten(sessionFile: string | undefined): void {
  for (const listener of listeners()) {
    try {
      listener(sessionFile);
    } catch (err) {
      console.error("[auto-title] error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  }
}

export function __resetAutoTitleListenersForTest(): void {
  const g = globalThis as { __piAutoTitleListeners?: Set<SessionTitleListener> };
  g.__piAutoTitleListeners = new Set();
}
