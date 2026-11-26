type OpenSession = (workspace: string, path: string) => void | Promise<void>;
let opener: OpenSession | undefined;

/** The app owns module switching, workspace selection, and restoring the actual conversation. */
export function registerWorkbenchSessionOpener(fn: OpenSession): () => void {
  opener = fn;
  return () => { if (opener === fn) opener = undefined; };
}

export function openWorkbenchSession(workspace: string, path: string): void {
  if (opener) void Promise.resolve(opener(workspace, path)).catch(() => {});
}
