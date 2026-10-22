import { join } from 'node:path';
import { ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { subscribeSessionTitleWritten } from '../../../extensions/auto-title/notify.js';
import { jobs as backgroundJobs } from '../../../extensions/jobs/service.js';
import { killAllSubagents } from '../../../extensions/multi-agent/subagentProcessRegistry.js';
import { releaseChildForDelete, releaseSubagentControlPlane } from '../../../extensions/multi-agent/controlPlane.js';
import { reconcileMcpManager, reloadMcpServer, setLiveWorkspaceMcpConfig } from '../../../extensions/mcp/manager.js';
import { probeServer } from '../../../extensions/mcp/probe.js';
import { writeToolsCacheEntry } from '../../../extensions/mcp/toolsCache.js';
import type { McpServerConfig } from '../../../extensions/mcp/config.js';
import { requestResourceReload } from '../../../extensions/_shared/resource-reload.js';
import { setSharedModelRuntime } from '../../../extensions/_shared/shared-model-runtime.js';
import { manifestExtensions } from '../../../extensions/index.js';
import type { Delivery } from '../../../extensions/multi-agent/inbox.js';
import { AgentHost } from '../agent/agentHost';
import { createWorkspaceHandle } from '../agent/createWorkspaceHandle';
import { ModelRuntimeHost } from '../agent/modelRuntimeHost';
import { snapshotSessionModel } from '../agent/workspaceHandle';
import { PiRuntimeService } from '../app/piRuntimeService';
import { SubagentService } from '../app/subagentService';
import { UsageService } from '../app/usageService';
import { SandboxManager } from '../app/sandbox/sandboxManager';
import { startJobsBridge } from '../app/jobsBridge';
import type { ActiveModel, AgentMethod, ExtensionCatalogEntry, HostApi } from './contract';
import type { MethodHandler } from './rpcPeer';

export interface RuntimeGraphOptions {
  host: HostApi;
  /** 推给所有窗口：pi://event / pi://ui-request / pi://exit / pi://jobs。 */
  broadcast(channel: string, payload: unknown): void;
  agentDir: string;
  runtimeConfigPath: string;
}

export interface RuntimeGraph {
  methods: Record<AgentMethod, MethodHandler>;
  shutdown(): Promise<void>;
}

/**
 * agent-host 子进程里的运行时对象图。原来在 main.ts 里装配，现在主进程只经 RPC 调用这里的 methods。
 * 交互运行时、后台 job、子代理、MCP 管理器、审批 / 模式表都在这个进程里。
 */
export function createRuntimeGraph(options: RuntimeGraphOptions): RuntimeGraph {
  const { host, broadcast, agentDir } = options;
  const modelRuntimeHost = new ModelRuntimeHost({
    create: async () => {
      const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });
      // 嵌入式子代理、冷恢复的子会话复用这一份，不再各自重建
      setSharedModelRuntime(runtime);
      return runtime;
    },
  });
  let piRuntime: PiRuntimeService | undefined;

  const agentHost: AgentHost = new AgentHost({
    createHandle: async (workspace, cwd) => createWorkspaceHandle({
      workspace,
      cwd,
      modelRuntime: await modelRuntimeHost.ensure(),
      allowedExtensionsJson: JSON.stringify(await host.allowedPluginIds()),
      resolveConfig: (origin) => piRuntime!.turnConfig(workspace, cwd, origin),
      emitUiRequest: (envelope) => {
        broadcast('pi://ui-request', {
          workspace: envelope.workspace,
          request: envelope.request,
          ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
          ...(envelope.sessionPath ? { sessionPath: envelope.sessionPath } : {}),
          source: envelope.source,
        });
      },
      onEvent: (event, meta) => {
        const envelope = piRuntime?.eventEnvelope(workspace, event, meta) ?? {
          workspace,
          event,
          source: meta.source,
          ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
          ...(meta.sessionPath ? { sessionPath: meta.sessionPath } : {}),
        };
        broadcast('pi://event', envelope);
        void piRuntime?.handlePiEvent(workspace, event, meta).catch((error) => console.error('Pi event handling failed', error));
      },
      onFatal: (error, handle) => {
        console.error('WorkspaceHandle fatal', error);
        let sessionId: string | undefined;
        let sessionPath: string | undefined;
        try {
          const id = handle?.session?.sessionId;
          if (typeof id === 'string' && id) sessionId = id;
          const file = handle?.session?.sessionFile;
          if (typeof file === 'string' && file) sessionPath = file;
        } catch { /* 会话已经拆掉 */ }
        const task = handle ? agentHost.evict(workspace, handle) : agentHost.close(workspace);
        void task.catch(() => {});
        broadcast('pi://exit', {
          workspace,
          code: 1,
          ...(sessionId ? { sessionId } : {}),
          ...(sessionPath ? { sessionPath } : {}),
        });
        void piRuntime?.handlePiExit(workspace, 1, sessionId ? { sessionId, source: 'interactive' } : undefined).catch(() => {});
      },
    }),
  });

  // AgentData 给每个工作区发一枚固定令牌，主进程不重启就不变。每回合都要用，记下来省一次往返。
  const endpoints = new Map<string, Promise<string | undefined>>();
  const agentDataEndpoint = (cwd: string): Promise<string | undefined> => {
    let pending = endpoints.get(cwd);
    if (!pending) {
      pending = host.agentDataEndpoint(cwd);
      endpoints.set(cwd, pending);
      pending.catch(() => endpoints.delete(cwd));
    }
    return pending;
  };

  piRuntime = new PiRuntimeService({
    agentDir,
    runtimeConfigPath: options.runtimeConfigPath,
    agentHost,
    modelRuntimeHost,
    agentDataEndpoint,
    mergeRuntimeSettings: (patch) => host.mergeRuntimeSettings(patch),
    resolveWorkspace: (path) => host.resolveWorkspace(path),
    permissionManager: { authorize: (operation, profile) => host.authorize(operation, profile) },
    mcpConfig: {
      effective: (workspace) => host.mcpRuntime(workspace),
      runtime: (workspace) => host.mcpRuntime(workspace),
    },
    allowedPluginIds: () => host.allowedPluginIds(),
    // 后台任务属于启动它的会话：有存活任务的会话换走时停靠，不原地销毁。
    hasLiveJobs: (sessionId) => backgroundJobs.hasLive(sessionId),
    threadStore: host.thread,
  });
  const pi = piRuntime;

  const jobsBridge = startJobsBridge((event, payload) => broadcast(event, payload), {
    workspaceForCwd: (cwd) => agentHost.workspaceForCwd(cwd) ?? cwd,
  });
  const subagents = new SubagentService(new SandboxManager({}));
  const usage = new UsageService(agentDir);
  // 会话已被替换时，auto-title 把标题写进原 jsonl，不会再走当前 pi 的 session_info_changed。
  // 补一次同名事件，侧栏会重读会话列表。workspace 留空，避免被当成当前画面上的会话事件。
  const stopAutoTitleNotice = subscribeSessionTitleWritten(() => {
    broadcast('pi://event', {
      workspace: '',
      event: { type: 'session_info_changed' },
      source: 'interactive',
    });
  });

  const methods: Record<AgentMethod, MethodHandler> = {
    'pi.openWorkspace': (p) => pi.openWorkspace(str(p, 'workspace')),
    'pi.listRunningTurns': () => pi.listRunningTurns(),
    'pi.warmWorkspace': (p) => pi.warmWorkspace(str(p, 'workspace')),
    'pi.closeWorkspace': (p) => pi.closeWorkspace(str(p, 'workspace')),
    'pi.respondUi': (p) => pi.respondUi(str(p, 'workspace'), record(p, 'response')),
    'pi.send': (p) => pi.send(str(p, 'workspace'), str(p, 'command'), record(p, 'args')),
    'pi.permissionProfile': (p) => pi.permissionProfile(str(p, 'workspace'), optionalStr(p, 'sessionId')) ?? null,
    'pi.refreshModelRegistry': () => pi.refreshModelRegistry(),
    'pi.enqueueTurn': (p) => pi.enqueueTurn(
      str(p, 'workspace'),
      typeof p.input === 'string' ? p.input : '',
      optionalStr(p, 'permissionProfile') ?? 'workspace',
      p.session && typeof p.session === 'object' ? p.session as never : undefined,
    ),
    'pi.releaseSessions': (p) => pi.releaseSessions(Array.isArray(p.paths) ? p.paths.filter((path): path is string => typeof path === 'string') : []),
    'pi.ownsSession': (p) => pi.ownsSession(str(p, 'workspace'), str(p, 'sessionId')),
    'pi.activeModel': (p): ActiveModel | null => {
      const snap = snapshotSessionModel(agentHost.get(str(p, 'workspace'))?.session.model);
      const provider = typeof snap?.provider === 'string' ? snap.provider : '';
      const modelId = typeof snap?.id === 'string' ? snap.id : '';
      return provider && modelId ? { provider, modelId } : null;
    },
    'subagent.list': (p) => subagents.list(str(p, 'workspace'), optionalStr(p, 'sessionPath')),
    'subagent.transcript': (p) => subagents.transcript(str(p, 'workspace'), str(p, 'agentId')),
    'subagent.sessionMessages': (p) => subagents.sessionMessages(str(p, 'sessionPath')),
    'subagent.catalog': (p) => subagents.catalog(str(p, 'parentSessionPath')),
    'subagent.catalogRowSample': (p) => subagents.catalogRowSample(str(p, 'sessionPath')),
    'subagent.promptChild': (p) => subagents.promptChild(
      str(p, 'workspace'), str(p, 'parentSessionPath'), str(p, 'sessionPath'),
      typeof p.message === 'string' ? p.message : '', p.delivery as Delivery,
    ),
    'subagent.interruptChild': (p) => subagents.interruptChild(str(p, 'workspace'), str(p, 'parentSessionPath'), str(p, 'sessionPath')),
    'subagent.cancel': (p) => subagents.cancel(str(p, 'workspace'), str(p, 'agentId')),
    'jobs.snapshot': (p) => jobsBridge.snapshot(str(p, 'jobId'), num(p, 'startedAt')),
    'jobs.kill': (p) => jobsBridge.kill(str(p, 'jobId'), num(p, 'startedAt')),
    'mcp.hotReload': (p) => {
      const workspace = str(p, 'workspace');
      setLiveWorkspaceMcpConfig(workspace, typeof p.runtime === 'string' ? p.runtime : '[]');
      reconcileMcpManager(workspace);
      return null;
    },
    'mcp.reload': (p) => reloadMcpServer(str(p, 'workspace'), str(p, 'name')),
    'mcp.probe': (p) => probeMcpServer(typeof p.configJson === 'string' ? p.configJson : ''),
    'mcp.workspaceForCwd': (p) => agentHost.workspaceForCwd(str(p, 'cwd')),
    'controlPlane.release': (p) => releaseSubagentControlPlane(str(p, 'path')),
    'controlPlane.releaseChildForDelete': (p) => releaseChildForDelete(
      str(p, 'workspace'),
      typeof p.agentId === 'string' ? p.agentId : null,
      str(p, 'path'),
    ),
    'resources.reload': () => requestResourceReload(),
    'extensions.catalog': (): ExtensionCatalogEntry[] => manifestExtensions.map((entry) => ({
      name: entry.name,
      ...(entry.manifest ? { manifest: { id: entry.manifest.id } } : {}),
    })),
    'usage.report': () => usage.report(),
    'usage.reconcile': () => usage.reconcile(),
  };

  return {
    methods,
    async shutdown() {
      stopAutoTitleNotice();
      jobsBridge.stop();
      await agentHost.closeAll();
      killAllSubagents();
    },
  };
}

/** 设置页「测试连接」。和原来主进程里的 McpPolicyService.probe 一致：缓存写失败不影响结果。 */
async function probeMcpServer(configJson: string): Promise<string> {
  let config: McpServerConfig;
  try {
    config = JSON.parse(configJson) as McpServerConfig;
  } catch {
    return JSON.stringify({ ok: false, toolNames: [], error: 'invalid MCP_PROBE_CONFIG' });
  }
  const result = await probeServer(config);
  try { writeToolsCacheEntry(config.name, result); } catch { /* 缓存失败不影响探测结果 */ }
  return JSON.stringify(result);
}

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalStr(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value ? value : undefined;
}

function record(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = params[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function num(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}
