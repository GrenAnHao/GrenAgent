// Host hook: Electron WorkspaceHandle registers a sink so in-process child
// session events are broadcast as pi://event with the child sessionPath.

export interface EmbeddedSubagentEventMeta {
  sessionId?: string;
  sessionPath: string;
  workspace: string;
}

export type EmbeddedSubagentEventSink = (
  event: Record<string, unknown>,
  meta: EmbeddedSubagentEventMeta,
) => void;

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
      sink(event, meta);
    } catch {
      /* one broken host must not drop sibling workspaces */
    }
  }
}

export function __resetEmbeddedSubagentEventSinksForTest(): void {
  sinks.clear();
}
