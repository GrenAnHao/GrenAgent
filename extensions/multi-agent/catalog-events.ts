// Host hook: Electron WorkspaceHandle registers a sink so parent catalog
// writes are broadcast without going through session.subscribe.

export interface CatalogChangeMeta {
  sessionPath: string;
}

export type CatalogChangeSink = (meta: CatalogChangeMeta) => void;

const sinks = new Set<CatalogChangeSink>();

export function registerCatalogChangeSink(sink: CatalogChangeSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function emitCatalogChanged(meta: CatalogChangeMeta): void {
  for (const sink of sinks) {
    try {
      sink(meta);
    } catch {
      /* one broken host must not drop sibling workspaces */
    }
  }
}

export function __resetCatalogChangeSinksForTest(): void {
  sinks.clear();
}
