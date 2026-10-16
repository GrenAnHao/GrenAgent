/**
 * agentdata-host 子进程一侧：装配运行时、给主进程的处理表、到主进程的反向端口。
 * 不引入 electron，也不碰进程级的 process.on / process.send（那些在 hostEntry.ts），便于在测试里直接装进一对 RpcPeer。
 */
import { randomUUID } from 'node:crypto';
import type { MethodHandler } from '../agentProcess/rpcPeer';
import { RpcPeer } from '../agentProcess/rpcPeer';
import type { CodeGraphHostClient } from '../app/codeGraph/codeGraphHostClient';
import { PluginStateStore } from '../app/plugin/pluginStateStore';
import { assembleAgentData, type AgentDataModelPort, type AssembledAgentData } from './assemble';
import {
  AGENTDATA_MODEL_USAGE_CHANNEL,
  type AgentDataHostConfig,
  type AgentDataProcessMethod,
  type ModelUsageEvent,
} from './contract';

export interface AgentDataHostDeps {
  config: AgentDataHostConfig;
  peer: RpcPeer;
  createCodeGraph: (listWorkspaces: () => string[]) => Pick<CodeGraphHostClient, 'projects' | 'status' | 'search' | 'call' | 'runSync' | 'cancelSync' | 'close'>;
}

export interface AgentDataHost {
  assembled: AssembledAgentData;
  /** 到主进程的模型端口（运行时和 SystemWorkerManager 都用它）。 */
  model: AgentDataModelPort;
  methods: Record<AgentDataProcessMethod, MethodHandler>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createAgentDataHost({ config, peer, createCodeGraph }: AgentDataHostDeps): AgentDataHost {
  const known = new Set(config.knownWorkspaces);
  const usage = new Map<string, (report: { model: string; usage: unknown }) => void>();
  peer.onEvent((channel, payload) => {
    if (channel !== AGENTDATA_MODEL_USAGE_CHANNEL) return;
    const event = payload as ModelUsageEvent | null;
    if (event && typeof event.requestId === 'string') usage.get(event.requestId)?.(event.report);
  });

  // 模型短调用回到主进程。signal 变成 abort 请求；onUsage 变成先于应答送达的事件（失败的调用也记账）。
  const model: AgentDataModelPort = {
    describe: () => peer.request<string>('main.model.describe'),
    complete: async (input) => {
      const requestId = randomUUID();
      const { signal, onUsage, ...rest } = input;
      if (signal?.aborted) throw abortError(signal);
      if (onUsage) usage.set(requestId, onUsage);
      const onAbort = () => { void peer.request('main.model.abort', { requestId }).catch(() => undefined); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await peer.request<string>('main.model.complete', { requestId, input: rest, withUsage: Boolean(onUsage) });
      } finally {
        signal?.removeEventListener('abort', onAbort);
        usage.delete(requestId);
      }
    },
  };
  const mainMethod = (name: string) => (params: Record<string, unknown>) => peer.request('main.method', { name, params });

  const assembled = assembleAgentData({
    dataPath: config.dataPath,
    worksDir: config.worksDir,
    model,
    codeGraph: createCodeGraph(() => [...known]),
    resolveSession: (workspace, sessionId) => peer.request<boolean>('main.resolveSession', { workspace, sessionId }),
    methods: {
      'turn.start': mainMethod('turn.start'),
      'permission.authorize': mainMethod('permission.authorize'),
      'mcp.state.publish': mainMethod('mcp.state.publish'),
    },
    listenPath: config.listenPath,
    hostToken: config.hostToken,
    workspaceTokens: config.workspaceTokens,
  });
  const { runtime } = assembled;
  let plugins: PluginStateStore | undefined;
  const pluginStore = () => (plugins ??= runtime.pluginStateStore());

  const methods: Record<AgentDataProcessMethod, MethodHandler> = {
    'agentdata.admin': (p) => runtime.requestAdmin(str(p, 'name'), record(p.params)),
    'agentdata.registerWorkspace': (p) => runtime.adoptWorkspaceToken(str(p, 'workspace'), str(p, 'token')),
    'agentdata.registerKnownWorkspace': (p) => { known.add(str(p, 'workspace')); return null; },
    'agentdata.resolveDiagnosticPath': (p) => runtime.resolveDiagnosticPath(str(p, 'id')),
    'agentdata.plugins.load': () => pluginStore().load(),
    'agentdata.plugins.save': (p) => { pluginStore().save(p.record as never); return null; },
    // hostEntry 会覆盖它（还要退出进程）；这里的版本给测试和进程内调用用。
    'host.shutdown': async () => { await assembled.close(); return null; },
  };

  return {
    assembled,
    model,
    methods,
    start: async () => { await runtime.start(); },
    shutdown: () => assembled.close(),
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { name: 'AbortError' });
}
function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
