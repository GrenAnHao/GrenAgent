// Host hook: Electron WorkspaceHandle registers a sink so in-process child
// session events are broadcast as pi://event with the child sessionPath.

export interface EmbeddedSubagentEventMeta {
  sessionId?: string;
  sessionPath: string;
  workspace: string;
}

/**
 * 返回 true 表示这个 sink 认领了事件（已经转发出去）。
 * 同一项目里会同时活着多个 host（前景会话加停靠的忙会话），它们都按 workspace 过滤；
 * 一个子会话事件只能被广播一次，否则渲染层的增量累加器会把每个 delta 追加 N 遍。
 */
export type EmbeddedSubagentEventSink = (
  event: Record<string, unknown>,
  meta: EmbeddedSubagentEventMeta,
) => void | boolean;

const sinks = new Set<EmbeddedSubagentEventSink>();

export function registerEmbeddedSubagentEventSink(sink: EmbeddedSubagentEventSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function emitEmbeddedSubagentEvent(event: Record<string, unknown>, meta: EmbeddedSubagentEventMeta): void {
  for (const sink of sinks) {
    try {
      if (sink(event, meta) === true) return;
    } catch {
      /* one broken host must not drop sibling workspaces */
    }
  }
}

export function __resetEmbeddedSubagentEventSinksForTest(): void {
  sinks.clear();
}
