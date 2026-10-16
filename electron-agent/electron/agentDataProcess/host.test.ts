import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDataClient } from '../agentData/client';
import { RpcPeer } from '../agentProcess/rpcPeer';
import { AgentDataService, type AgentDataProcessPort } from '../app/agentDataService';
import { PluginManager } from '../app/plugin/pluginManager';
import { AGENTDATA_MODEL_USAGE_CHANNEL, type AgentDataHostConfig } from './contract';
import { createAgentDataHost } from './host';
import { agentDataPipePath } from './pipePath';

/**
 * child 模式整条链路，只是不起进程：AgentDataService（主进程门面）↔ 一对 RpcPeer（结构化克隆）↔ createAgentDataHost（子进程一侧）。
 * 命名管道、令牌、反向调用、插件状态都是真的；进程的拉起 / 崩溃由 fakeProcess 模拟，见 hostEntry 冒烟。
 */
type MainSide = { describe: () => Promise<string>; complete: (input: Record<string, unknown>, emitUsage: (report: unknown) => void, signal: AbortSignal) => Promise<string>; ownsSession?: () => boolean; method?: (name: string, params: Record<string, unknown>) => unknown };

function harness(main: MainSide) {
  const dir = mkdtempSync(join(tmpdir(), 'agentdata-host-'));
  const listenPath = agentDataPipePath();
  const launches: Array<{ host: ReturnType<typeof createAgentDataHost>; mainPeer: RpcPeer; childPeer: RpcPeer }> = [];
  const codeGraph = { projects: vi.fn((list: string[]) => list.map((workspace) => ({ workspace, indexed: false }))) };
  let current: (typeof launches)[number] | undefined;
  let launchState!: () => { hostToken: string; listenPath: string; workspaceTokens: Record<string, string>; knownWorkspaces: string[] };
  const aborts = new Map<string, AbortController>();

  const launch = async () => {
    const state = launchState();
    let childPeer!: RpcPeer;
    const mainPeer = new RpcPeer({ send: (message) => queueMicrotask(() => childPeer.receive(structuredClone(message))) });
    childPeer = new RpcPeer({ send: (message) => queueMicrotask(() => mainPeer.receive(structuredClone(message))) });
    mainPeer.handleAll({
      'main.model.describe': () => main.describe(),
      'main.model.complete': async (p) => {
        const controller = new AbortController();
        aborts.set(p.requestId as string, controller);
        try {
          return await main.complete(p.input as Record<string, unknown>, (report) => mainPeer.emit(AGENTDATA_MODEL_USAGE_CHANNEL, { requestId: p.requestId, report }), controller.signal);
        } finally { aborts.delete(p.requestId as string); }
      },
      'main.model.abort': (p) => { aborts.get(p.requestId as string)?.abort(); return null; },
      'main.resolveSession': () => main.ownsSession?.() ?? false,
      'main.method': (p) => main.method?.(p.name as string, p.params as Record<string, unknown>) ?? null,
    });
    const config: AgentDataHostConfig = {
      ...state, dataPath: join(dir, 'agent-data.db'), worksDir: join(dir, 'works'),
      codeGraph: { hostEntry: '', workerEntry: '', jobGuardExe: '', execPath: '' },
    };
    const host = createAgentDataHost({
      config, peer: childPeer,
      createCodeGraph: (list) => ({
        projects: () => codeGraph.projects(list()),
        status: async (workspace: string) => ({ workspace, connected: false, indexed: false, sdkAvailable: true, sdkVersion: '1.6.2', state: 'unavailable' as const }),
        search: async (workspace: string) => ({ workspace, available: false, results: [] }),
        call: async () => { throw new Error('not indexed'); },
        runSync: async () => {},
        cancelSync: async () => {},
        close: async () => {},
      }),
    });
    childPeer.handleAll(host.methods);
    await host.start();
    current = { host, mainPeer, childPeer };
    launches.push(current);
  };

  const port: AgentDataProcessPort = {
    start: async () => { if (!current) await launch(); },
    request: async (method, params = {}) => {
      if (!current) await launch();
      return current!.mainPeer.request(method, params);
    },
    shutdown: async () => { if (current) { await current.host.shutdown(); current = undefined; } },
    get isRunning() { return current !== undefined; },
  };
  const service = new AgentDataService({ mode: 'child', listenPath, createProcess: (state) => { launchState = state; return port; } });
  return {
    service, dir, listenPath, launches, codeGraph,
    /** 模拟子进程崩溃：运行时直接关掉（不走 shutdown），下一条请求重新拉起。 */
    crash: async () => { const victim = current!; current = undefined; victim.mainPeer.close(new Error('AGENTDATA_HOST_EXITED')); await victim.host.assembled.close(); },
    cleanup: async () => { await service.stop().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('agentdata-host (child mode, in-process wire)', () => {
  let h: ReturnType<typeof harness> | undefined;
  afterEach(async () => { await h?.cleanup(); h = undefined; });

  it('serves extension clients over the named pipe with tokens issued by the main process', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => '' });
    await expect(h.service.start()).resolves.toEqual({ version: 1 });
    const endpoint = await h.service.agentEndpoint(join(h.dir, 'ws'));
    expect(endpoint).toMatchObject({ path: h.listenPath, host: '', port: 0 });
    expect(endpoint.token).toMatch(/^[0-9a-f]{64}$/);
    // 扩展侧那份客户端（extensions/memory/client.ts）同样只认 path，这里用主进程的 AgentDataClient 走同一个管道
    const extension = new AgentDataClient(endpoint);
    const scope = { userId: 'u', workspace: join(h.dir, 'ws'), sessionId: 's', source: 'session:s', transcript: 'user: hi', fingerprint: 'f1' };
    await expect(extension.request('memory.capture', scope)).resolves.toMatchObject({ changed: true });
    await expect(extension.request('admin.export')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(new AgentDataClient({ ...endpoint, token: 'f'.repeat(64) }).request('system.status')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // 同一工作区再要一次拿到同一个令牌，不同工作区不同令牌
    expect((await h.service.agentEndpoint(join(h.dir, 'ws'))).token).toBe(endpoint.token);
    expect((await h.service.agentEndpoint(join(h.dir, 'other'))).token).not.toBe(endpoint.token);
    await extension.close();
  });

  it('keeps the admin plane private and preserves the requestAdmin error shape', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => '' });
    await h.service.start();
    await expect(h.service.requestAdmin('wiki.create', { name: 'kb' })).resolves.toMatchObject({ name: 'kb' });
    await expect(h.service.requestAdmin('admin.nothing')).rejects.toThrow('METHOD_NOT_FOUND: unknown management method: admin.nothing');
    await expect(h.service.request('thread.list')).resolves.toEqual([]);
  });

  it('survives a crash: same pipe, same tokens, the extension endpoint it already holds keeps working', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => '' });
    await h.service.start();
    const ws = join(h.dir, 'ws');
    const endpoint = await h.service.agentEndpoint(ws);
    await new AgentDataClient(endpoint).request('memory.upsert', { userId: 'u', workspace: ws, level: 1, content: 'remember me' });
    await h.crash();
    // 下一条主进程请求把子进程拉回来，带着原来的令牌表
    await expect(h.service.requestAdmin('admin.tasks.list', {})).resolves.toMatchObject({ items: [] });
    expect(h.launches).toHaveLength(2);
    const extension = new AgentDataClient(endpoint);
    await expect(extension.request('memory.search', { userId: 'u', workspace: ws, query: 'remember', limit: 5 })).resolves.toEqual([expect.objectContaining({ content: 'remember me' })]);
    await extension.close();
  });

  it('routes model calls back to the main process with usage delivered before the reply, even when the call fails', async () => {
    const order: string[] = [];
    h = harness({
      describe: async () => 'p/m',
      complete: async (input, emitUsage) => {
        emitUsage({ model: 'p/m', usage: { input: 3, output: 4 } });
        order.push('main-complete');
        if (String(input.user).includes('fail')) throw new Error('MODEL_UNAVAILABLE: boom');
        return '# Page\n\nbody';
      },
    });
    await h.service.start();
    const { model } = h.launches[0].host;
    await expect(model.describe()).resolves.toBe('p/m');
    // 不带 onUsage（Wiki 的 completeSimple）：只拿文本
    await expect(model.complete({ user: 'write' })).resolves.toBe('# Page\n\nbody');
    // 带 onUsage（SystemWorkerManager）：用量先于应答到达；失败的调用用量也到
    const seen: string[] = [];
    const ok = await model.complete({ user: 'write', onUsage: (report) => seen.push(`usage:${JSON.stringify(report.usage)}`) });
    seen.push(`reply:${ok.length}`);
    await expect(model.complete({ user: 'fail please', onUsage: () => seen.push('usage-on-failure') })).rejects.toThrow('MODEL_UNAVAILABLE: boom');
    expect(seen).toEqual(['usage:{"input":3,"output":4}', 'reply:12', 'usage-on-failure']);
    expect(order).toEqual(['main-complete', 'main-complete', 'main-complete']);
  });

  it('aborting the signal in the child aborts the model call in the main process', async () => {
    let mainSignal: AbortSignal | undefined;
    h = harness({
      describe: async () => 'p/m',
      complete: (_input, _usage, signal) => new Promise((_resolve, reject) => {
        mainSignal = signal;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    });
    await h.service.start();
    const controller = new AbortController();
    const call = h.launches[0].host.model.complete({ user: 'slow', signal: controller.signal });
    await vi.waitFor(() => expect(mainSignal).toBeDefined());
    controller.abort();
    await expect(call).rejects.toThrow('aborted');
    expect(mainSignal!.aborted).toBe(true);
    const pre = new AbortController(); pre.abort();
    await expect(h.launches[0].host.model.complete({ user: 'x', signal: pre.signal })).rejects.toBeTruthy();
  });

  it('forwards main-only socket methods (permission.authorize) back to the main process', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    h = harness({ describe: async () => 'p/m', complete: async () => '', method: (name, params) => { calls.push([name, params]); return { status: 'allowed', decision: 'allow' }; } });
    await h.service.start();
    const endpoint = await h.service.agentEndpoint(join(h.dir, 'ws'));
    const extension = new AgentDataClient(endpoint);
    await expect(extension.request('permission.authorize', { operation: { kind: 'desktop.click' }, profile: 'workspace' })).resolves.toEqual({ status: 'allowed', decision: 'allow' });
    expect(calls).toEqual([['permission.authorize', { operation: { kind: 'desktop.click' }, profile: 'workspace' }]]);
    await extension.close();
  });

  it('persists plugin state through the child; the main process never opens the database', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => '' });
    await h.service.start();
    const plugin = { id: 'mcp', manifest: { id: 'mcp', version: '1', apiVersion: '1', capabilities: ['tool' as const] }, load: async () => ({}) };
    const manager = new PluginManager({ state: { initial: await h.service.loadPluginStates(), save: (r) => h!.service.savePluginState(r) }, apiVersion: '1' });
    manager.discover([plugin]);
    await manager.startAll();
    await vi.waitFor(async () => expect(await h!.service.loadPluginStates()).toEqual([expect.objectContaining({ id: 'mcp', state: 'ready' })]));
    const restored = new PluginManager({ state: { initial: await h.service.loadPluginStates(), save: () => {} }, apiVersion: '1' });
    expect(restored.get('mcp')).toMatchObject({ state: 'ready' });
  });

  it('lists projects from workspaces the main process registered, including after a restart', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => '' });
    await h.service.start();
    h.service.registerKnownWorkspace(join(h.dir, 'ws'));
    await vi.waitFor(async () => expect(await h!.service.request('codeRetrieval.admin.projects')).toEqual([{ workspace: join(h!.dir, 'ws'), indexed: false }]));
    await h.crash();
    await expect(h.service.request('codeRetrieval.admin.projects')).rejects.toBeTruthy(); // 管道上的连接随旧运行时断开
    await h.service.requestAdmin('admin.tasks.list', {});
    await expect(h.service.request('codeRetrieval.admin.projects')).resolves.toEqual([{ workspace: join(h.dir, 'ws'), indexed: false }]);
  });
});
