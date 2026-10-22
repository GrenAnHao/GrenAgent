/**
 * 主进程这一侧的接线：
 * - createHostMethods：子进程回调主进程时的处理表（解析工作区、AgentData 令牌、授权、入库……）。
 * - createAgentPorts：主进程各服务和 IPC 命令调子进程的薄封装，方法签名与原来的进程内对象一致。
 * 本文件不引入任何扩展模块。
 */
import type { PermissionAuthorization, PermissionOperation } from '../app/permissionManager';
import type { UsageReport } from '../../src/lib/usageReport';
import type {
  ActiveModel,
  AgentMethod,
  ExtensionCatalogEntry,
  HostMethod,
  McpServerEntry,
  ThreadStorePort,
} from './contract';
import type { MethodHandler } from './rpcPeer';

export interface HostDeps {
  resolveWorkspace(path: string): Promise<string>;
  /** AgentData 端点的 JSON 字符串。agentdata-host 模式下要先把令牌登记到子进程，所以可以是异步的。 */
  agentDataEndpoint(cwd: string): string | undefined | Promise<string | undefined>;
  mcpRuntime(workspace: string): Promise<McpServerEntry[]>;
  allowedPluginIds(): string[];
  authorize(operation: PermissionOperation, profile: string): Promise<PermissionAuthorization>;
  mergeRuntimeSettings(patch: Record<string, string>): Promise<void>;
  thread: ThreadStorePort;
}

export function createHostMethods(deps: HostDeps): Record<HostMethod, MethodHandler> {
  return {
    'host.resolveWorkspace': (p) => deps.resolveWorkspace(str(p, 'path')),
    'host.agentDataEndpoint': async (p) => (await deps.agentDataEndpoint(str(p, 'cwd'))) ?? null,
    'host.mcpRuntime': (p) => deps.mcpRuntime(str(p, 'workspace')),
    'host.allowedPluginIds': () => deps.allowedPluginIds(),
    'host.authorize': (p) => {
      const operation = record(p, 'operation');
      return deps.authorize(
        { ...operation, kind: typeof operation.kind === 'string' ? operation.kind : 'unknown' },
        typeof p.profile === 'string' ? p.profile : 'interactive',
      );
    },
    'host.mergeRuntimeSettings': async (p) => {
      const patch = record(p, 'patch');
      if (!Object.values(patch).every((value) => typeof value === 'string')) throw new Error('patch values must be strings');
      await deps.mergeRuntimeSettings(patch as Record<string, string>);
      return null;
    },
    'host.thread.createThread': (p) => deps.thread.createThread(p as unknown as Parameters<ThreadStorePort['createThread']>[0]),
    'host.thread.createTurn': (p) => deps.thread.createTurn(p as unknown as Parameters<ThreadStorePort['createTurn']>[0]),
    'host.thread.updateTurn': (p) => deps.thread.updateTurn(str(p, 'id'), record(p, 'patch')),
    'host.thread.upsertItem': (p) => deps.thread.upsertItem(p as unknown as Parameters<ThreadStorePort['upsertItem']>[0]),
  };
}

export type AgentRequest = <T = unknown>(method: AgentMethod, params?: Record<string, unknown>) => Promise<T>;

export interface SessionContext {
  sessionId?: string;
  sessionPath?: string;
  source?: 'interactive' | 'goal';
}

/** 子进程退出时要通知的工作区：对它发过运行时命令、还没关掉的那些。 */
export class WorkspaceTracker {
  private readonly open = new Set<string>();

  touch(workspace: unknown): void {
    if (typeof workspace === 'string' && workspace) this.open.add(workspace);
  }

  close(workspace: unknown): void {
    if (typeof workspace === 'string') this.open.delete(workspace);
  }

  /** 取出并清空。 */
  drain(): string[] {
    const list = [...this.open];
    this.open.clear();
    return list;
  }
}

export interface AgentChannel {
  request: AgentRequest;
  /** 子进程在跑（含正在启动）。 */
  isRunning(): boolean;
}

/**
 * 运行时命令照常转发（子进程不在就拉起）。释放 / 查询类调用只在子进程在跑时转发：
 * 子进程不在，就没有活着的会话、MCP 连接、后台任务可释放或可查，直接给兜底值，
 * 不为此拉起子进程，崩溃冷却期间删会话也不会失败。
 */
export function createAgentPorts(channel: AgentRequest | AgentChannel, tracker = new WorkspaceTracker()) {
  const request: AgentRequest = typeof channel === 'function' ? channel : channel.request;
  const isRunning = typeof channel === 'function' ? () => true : () => channel.isRunning();
  const whenRunning = <T>(method: AgentMethod, params: Record<string, unknown>, fallback: T): Promise<T> =>
    isRunning() ? request<T>(method, params) : Promise.resolve(fallback);
  const touching = <T>(workspace: string, task: Promise<T>): Promise<T> => {
    tracker.touch(workspace);
    return task;
  };
  return {
    tracker,
    pi: {
      openWorkspace: (workspace: string) => touching(workspace, request('pi.openWorkspace', { workspace })),
      listRunningTurns: () => whenRunning('pi.listRunningTurns', {}, [] as unknown[]),
      warmWorkspace: (workspace: string) => touching(workspace, request('pi.warmWorkspace', { workspace })),
      closeWorkspace: async (workspace: string) => {
        await whenRunning('pi.closeWorkspace', { workspace }, null);
        tracker.close(workspace);
      },
      respondUi: (workspace: string, response: Record<string, unknown>) => request('pi.respondUi', { workspace, response }),
      send: (workspace: string, command: string, args: Record<string, unknown>) =>
        touching(workspace, request('pi.send', { workspace, command, args })),
      permissionProfile: async (workspace: string, sessionId?: string) =>
        (await whenRunning<string | null>('pi.permissionProfile', { workspace, ...(sessionId ? { sessionId } : {}) }, null)) ?? undefined,
      refreshModelRegistry: () => whenRunning<{ refreshed: string[]; failed: Array<{ workspace: string; error: string }> }>(
        'pi.refreshModelRegistry', {}, { refreshed: [], failed: [] },
      ),
      enqueueTurn: (workspace: string, input: string, permissionProfile: string, session?: SessionContext) =>
        touching(workspace, request('pi.enqueueTurn', { workspace, input, permissionProfile, ...(session ? { session } : {}) })),
      releaseSessions: async (paths: string[]) => { await whenRunning('pi.releaseSessions', { paths }, null); },
      ownsSession: (workspace: string, sessionId: string) => whenRunning('pi.ownsSession', { workspace, sessionId }, false),
      activeModel: (workspace: string) => whenRunning<ActiveModel | null>('pi.activeModel', { workspace }, null),
    },
    subagent: {
      list: (workspace: string, sessionPath?: string) => request('subagent.list', { workspace, ...(sessionPath ? { sessionPath } : {}) }),
      transcript: (workspace: string, agentId: string) => request('subagent.transcript', { workspace, agentId }),
      sessionMessages: (sessionPath: string) => request<unknown[]>('subagent.sessionMessages', { sessionPath }),
      catalog: (parentSessionPath: string) => request('subagent.catalog', { parentSessionPath }),
      catalogRowSample: (sessionPath: string) => request('subagent.catalogRowSample', { sessionPath }),
      promptChild: async (workspace: string, parentSessionPath: string, sessionPath: string, message: string, delivery: 'followUp' | 'steer') => {
        await request('subagent.promptChild', { workspace, parentSessionPath, sessionPath, message, delivery });
      },
      interruptChild: async (workspace: string, parentSessionPath: string, sessionPath: string) => {
        await request('subagent.interruptChild', { workspace, parentSessionPath, sessionPath });
      },
      cancel: async (workspace: string, agentId: string) => { await request('subagent.cancel', { workspace, agentId }); },
    },
    jobs: {
      // 后台任务活在子进程里；子进程不在时任务已经没了
      snapshot: (jobId: string, startedAt: number) => whenRunning('jobs.snapshot', { jobId, startedAt }, null),
      kill: (jobId: string, startedAt: number) => whenRunning('jobs.kill', { jobId, startedAt }, 'not-found'),
    },
    mcp: {
      // 子进程下次启动时自己读最新配置
      hotReload: async (workspace: string, runtimeJson: string) => { await whenRunning('mcp.hotReload', { workspace, runtime: runtimeJson }, null); },
      reload: async (workspace: string, name: string) => { await request('mcp.reload', { workspace, name }); },
      probe: (configJson: string) => request<string>('mcp.probe', { configJson }),
      workspaceForCwd: (cwd: string) => whenRunning('mcp.workspaceForCwd', { cwd }, cwd),
    },
    controlPlane: {
      release: async (path: string) => { await whenRunning('controlPlane.release', { path }, null); },
      releaseChildForDelete: (workspace: string, agentId: string | null, path: string) =>
        whenRunning('controlPlane.releaseChildForDelete', { workspace, agentId, path }, { quiescent: true }),
    },
    resources: {
      reload: () => request<boolean>('resources.reload'),
    },
    extensions: {
      catalog: () => request<ExtensionCatalogEntry[]>('extensions.catalog'),
    },
    // 用量账本在 agent-host 里查：同步 sqlite 和历史导入都不占主进程。
    usage: {
      report: () => request<UsageReport>('usage.report'),
      reconcile: () => request<{ files: number; added: number }>('usage.reconcile'),
    },
  };
}

export type AgentPorts = ReturnType<typeof createAgentPorts>;

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function record(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = params[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}
