/** Renderer-safe adapter for the EXISTING GrenRuntimeBridge from src/platform/runtime.ts. */
import {
  PROGRESS_EVENT,
  validateRequest,
  type RepoWikiClient,
  type ProgressEvent,
} from "../../contracts/src/index.js";
export interface GrenRuntimeBridge {
  invoke<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T>;
  subscribe<T = unknown>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}
export function createGrenRepoWikiClient(
  runtime: GrenRuntimeBridge,
): RepoWikiClient {
  return {
    invoke: async (action: any, input: any) => {
      validateRequest(action, input);
      return runtime.invoke(`repoWiki_${action}`, input);
    },
    subscribe: (handler: (event: ProgressEvent) => void) => {
      let disposed = false,
        off: (() => void) | undefined;
      void runtime
        .subscribe<ProgressEvent>(PROGRESS_EVENT, (event) => {
          if (!disposed && event.payload?.project_id) handler(event.payload);
        })
        .then((unsubscribe) => {
          if (disposed) unsubscribe();
          else off = unsubscribe;
        })
        .catch(() => {});
      return () => {
        disposed = true;
        off?.();
      };
    },
  };
}
