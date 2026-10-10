import type { HostApi, HostMethod, McpServerEntry } from './contract';
import type { PermissionAuthorization } from '../app/permissionManager';

type Request = <T>(method: HostMethod, params?: Record<string, unknown>) => Promise<T>;

/** 子进程这一侧：把 HostApi 的每个调用变成发给主进程的一条请求。 */
export function hostApiOverRequest(request: Request): HostApi {
  return {
    resolveWorkspace: (path) => request<string>('host.resolveWorkspace', { path }),
    agentDataEndpoint: async (cwd) => (await request<string | null>('host.agentDataEndpoint', { cwd })) ?? undefined,
    mcpRuntime: (workspace) => request<McpServerEntry[]>('host.mcpRuntime', { workspace }),
    allowedPluginIds: () => request<string[]>('host.allowedPluginIds'),
    authorize: (operation, profile) => request<PermissionAuthorization>('host.authorize', { operation, profile }),
    mergeRuntimeSettings: async (patch) => { await request('host.mergeRuntimeSettings', { patch }); },
    thread: {
      createThread: (input) => request('host.thread.createThread', input),
      createTurn: (input) => request('host.thread.createTurn', input),
      updateTurn: (id, patch) => request('host.thread.updateTurn', { id, patch }),
      upsertItem: (item) => request('host.thread.upsertItem', item),
    },
  };
}
