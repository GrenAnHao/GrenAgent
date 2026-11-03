/** Preload is capability-limited: no fs, shell, generic ipcRenderer or secrets exposed. */
import {
  validateRequest,
  PROGRESS_EVENT,
  type RepoWikiClient,
  type ProgressEvent,
} from "../../contracts/src/index.js";
export interface SafeIpcRenderer {
  invoke(channel: string, message: unknown): Promise<any>;
  on(
    channel: string,
    handler: (event: unknown, payload: unknown) => void,
  ): void;
  removeListener(
    channel: string,
    handler: (event: unknown, payload: unknown) => void,
  ): void;
}
export function createPreloadApi(ipc: SafeIpcRenderer): RepoWikiClient {
  return Object.freeze({
    invoke: async (action: any, input: any) => {
      validateRequest(action, input);
      return ipc.invoke("repoWiki:invoke", { action, input });
    },
    subscribe: (handler: (event: ProgressEvent) => void) => {
      const listener = (_event: unknown, payload: any) => {
        if (
          payload &&
          typeof payload.project_id === "string" &&
          payload.run &&
          typeof payload.run === "object"
        )
          handler(payload);
      };
      ipc.on(PROGRESS_EVENT, listener);
      return () => ipc.removeListener(PROGRESS_EVENT, listener);
    },
  });
}
export function exposeRepoWiki(
  contextBridge: { exposeInMainWorld(name: string, value: unknown): void },
  ipc: SafeIpcRenderer,
) {
  contextBridge.exposeInMainWorld("repoWiki", createPreloadApi(ipc));
}
