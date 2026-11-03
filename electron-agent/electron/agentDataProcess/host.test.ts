import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDataClient } from '../agentData/client';
import { RpcPeer } from '../agentProcess/rpcPeer';
import { AgentDataService, type AgentDataProcessHooks, type AgentDataProcessPort } from '../app/agentDataService';
import { PluginManager } from '../app/plugin/pluginManager';
import { AGENTDATA_MODEL_USAGE_CHANNEL, type AgentDataHostConfig } from './contract';
import { createAgentDataHost } from './host';
import { agentDataPipePath } from './pipePath';

/**
 * child 模式整条链路，只是不起进程：AgentDataService（主进程门面）↔ 一对 RpcPeer（结构化克隆）↔ createAgentDataHost（子进程一侧）。
 * 命名管道、令牌、反向调用、插件状态都是真的；进程的拉起 / 崩溃由 fakeProcess 模拟，见 hostEntry 冒烟。
 */
type MainSide = { describe: () => Promise<string>; complete: (input: Record<string, unknown>, emitUsage: (report: unknown) => void, signal: AbortSignal) => Promise<string>; ownsSession?: () => boolean; method?: (name: string, params: Record<string, unknown>) => unknown; modelEpoch?: (epoch: unknown) => void };

function harness(main: MainSide, relaunch: { relaunchDelayMs?: number; relaunchRetryMs?: number } = { relaunchDelayMs: 60_000 }, knowledgeKernelVersion?: 1) {
  const dir = mkdtempSync(join(tmpdir(), 'agentdata-host-'));
  const listenPath = agentDataPipePath();
  const launches: Array<{ host: ReturnType<typeof createAgentDataHost>; mainPeer: RpcPeer; childPeer: RpcPeer }> = [];
  const codeGraph = { projects: vi.fn((list: string[]) => list.map((workspace) => ({ workspace, indexed: false }))) };
  let current: (typeof launches)[number] | undefined;
  let launchState!: () => { hostToken: string; listenPath: string; workspaceTokens: Record<string, string>; knownWorkspaces: string[] };
  let hooks!: AgentDataProcessHooks;
  const aborts = new Map<string, AbortController>();

  let failLaunches = 0;
  const launch = async () => {
    if (failLaunches > 0) { failLaunches -= 1; throw new Error('AGENT_HOST_CRASH_LOOP: test'); }
    const state = launchState();
    let childPeer!: RpcPeer;
    const mainPeer = new RpcPeer({ send: (message) => queueMicrotask(() => childPeer.receive(structuredClone(message))) });
    childPeer = new RpcPeer({ send: (message) => queueMicrotask(() => mainPeer.receive(structuredClone(message))) });
    mainPeer.handleAll({
      'main.model.describe': () => main.describe(),
      'main.model.complete': async (p) => {
        main.modelEpoch?.(p.controllerEpoch);
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
      ...state, dataPath: join(dir, 'agent-data.db'),
      knowledgeKernelVersion,
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
  const service = new AgentDataService({ mode: 'child', listenPath, ...relaunch, createProcess: (state, h) => { launchState = state; hooks = h; return port; } });
  return {
    service, dir, listenPath, launches, codeGraph,
    /** 模拟子进程崩溃：运行时直接关掉（不走 shutdown），再像 AgentProcessClient 的 onExit 一样回报门面。 */
    crash: async () => {
      const victim = current!; current = undefined;
      victim.mainPeer.close(new Error('AGENTDATA_HOST_EXITED')); await victim.host.assembled.close();
      hooks.onExit({ expected: false });
    },
    /** 下一次拉起失败（模拟连续崩溃被冷却）。 */
    failNextLaunches: (n: number) => { failLaunches = n; },
    cleanup: async () => { await service.stop().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('agentdata-host (child mode, in-process wire)', () => {
  let h: ReturnType<typeof harness> | undefined;
  afterEach(async () => { await h?.cleanup(); h = undefined; });

  it('starts the endpoint before epoch binding and routes version 1 knowledge methods through main', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: Array<{name:string; params:Record<string,unknown>}> = [];
    const key = { workspaceInstanceId: 'w', projectId: 'p', portableProjectId: 'portable', branch: 'main', language: 'zh', domain: 'wiki' };
    const binding = { bindingId: 'b', expectedModel: 'provider/model', expectedConfiguration: 'config', model: { id: 'model', name: 'Model', api: 'openai-completions', provider: 'provider', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
    h = harness({ describe: async () => 'provider/model', complete: async () => '', method: async (name, params) => {
      calls.push({ name, params });
      if (name === 'knowledge.bindEpoch') { await gate; return []; }
      if (name === 'knowledge.bindModel') return binding;
      if (name === 'knowledge.worker') return { key, root: 'C:/project', projectId: 'p', language: 'zh', scope: 's', planToken: 'plan', guardFloor: 0, content: { publishedCount: 0 } };
      return null;
    } }, undefined, 1);
    try {
      await h.service.start();
      await vi.waitFor(() => expect(calls.some(call => call.name === 'knowledge.bindEpoch')).toBe(true));
      const prepared = h.service.requestAdmin<any>('admin.knowledge.prepare', { projectId: 'p', domain: 'wiki' });
      expect(calls.some(call => call.name === 'knowledge.worker')).toBe(false);
      release();
      expect(await prepared).toMatchObject({ key, admission: { state: 'ready', modelDisplayName: 'Model' } });
      expect(calls).toContainEqual(expect.objectContaining({ name: 'knowledge.worker', params: { method: 'project.read', input: { projectId: 'p', domain: 'wiki' } } }));
      expect(calls).toContainEqual(expect.objectContaining({ name: 'knowledge.activateEpoch' }));
      await expect(h.service.requestAdmin('admin.jobs.create', { kind: 'repoWiki.generate', workspace: h.dir, metadata: { payload: { projectId: 'p', language: 'zh', target: 'wiki', force: false, confirmExternal: true } } })).rejects.toThrow(/KNOWLEDGE_START_REQUIRED/);
      expect(calls.some(call => call.name === 'repoWiki.run')).toBe(false);
    } finally { release(); }
  });

  it('forwards the controller epoch on old Wiki calls only in kernel mode', async () => {
    const epochs: unknown[] = [];
    h = harness({ describe: async () => 'p/m', complete: async () => 'ok', modelEpoch: epoch => { epochs.push(epoch); }, method: name => name === 'knowledge.bindEpoch' ? [] : null }, undefined, 1);
    await h.service.start();
    expect(await h.service.completeKnowledge({ user: 'old wiki call' })).toBe('ok');
    expect(epochs[0]).toMatch(/^[0-9a-f-]{36}$/);
    await h.cleanup();
    h = harness({ describe: async () => 'p/m', complete: async () => 'ok', modelEpoch: epoch => { epochs.push(epoch); } });
    await h.service.start();
    expect(await h.service.completeKnowledge({ user: 'legacy call' })).toBe('ok');
    expect(epochs[1]).toBeUndefined();
  });

  it('keeps a Repo Wiki generation alive across long reverse RPC waits and persists its terminal state', async () => {
    let finish!: (value: { cancelled?: boolean }) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    h = harness({ describe: async () => 'p/m', complete: async () => '', method: (name) => {
      if (name === 'repoWiki.run') {
        notifyStarted();
        return new Promise<{ cancelled?: boolean }>((resolve) => { finish = resolve; });
      }
      if (name === 'repoWiki.cancel') finish?.({ cancelled: true });
      return null;
    } });
    await h.service.start();
    const job = await h.service.requestAdmin<{ id: string }>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: h.dir,
      metadata: { payload: { projectId: 'project', language: 'zh', target: 'wiki', force: false, confirmExternal: true } } });
    await started;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(await h.service.requestAdmin('admin.jobs.get', { id: job.id })).toMatchObject({ state: 'running' });
      finish({});
    } finally { vi.useRealTimers(); }
    await vi.waitFor(async () => expect(await h!.service.requestAdmin('admin.jobs.get', { id: job.id })).toMatchObject({ state: 'completed', progress: 100 }));
  });

  it('serves extension clients over the named pipe with tokens issued by the main process', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => '' });
    await expect(h.service.start()).resolves.toEqual({ version: 1 });
    const endpoint = await h.service.agentEndpoint(join(h.dir, 'ws'));
    expect(endpoint).toMatchObject({ path: h.listenPath, host: '', port: 0 });
    expect(endpoint.token).toMatch(/^[0-9a-f]{64}$/);
    // 扩展侧那份客户端（extensions/_shared/agent-data-client.ts）同样只认 path，这里用主进程的 AgentDataClient 走同一个管道
    const extension = new AgentDataClient(endpoint);
    await expect(extension.request('wiki.list')).resolves.toEqual([]);
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
    await h.service.requestAdmin('wiki.create', { name: 'Survives restart' });
    await h.crash();
    // 下一条主进程请求把子进程拉回来，带着原来的令牌表
    await expect(h.service.requestAdmin('admin.tasks.list', {})).resolves.toMatchObject({ items: [] });
    expect(h.launches).toHaveLength(2);
    const extension = new AgentDataClient(endpoint);
    await expect(extension.request('wiki.list')).resolves.toEqual([expect.objectContaining({ name: 'Survives restart' })]);
    await extension.close();
  });

  it('relaunches on its own after a crash, without waiting for a main-process request', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => '' }, { relaunchDelayMs: 5, relaunchRetryMs: 5 });
    await h.service.start();
    const ws = join(h.dir, 'ws');
    const endpoint = await h.service.agentEndpoint(ws);
    h.failNextLaunches(2);
    await h.crash();
    // 两次拉起失败后第三次成功；全程没有主进程请求
    await vi.waitFor(() => expect(h!.launches).toHaveLength(2), { timeout: 2000 });
    const extension = new AgentDataClient(endpoint);
    await expect(extension.request('wiki.list')).resolves.toEqual([]);
    await extension.close();
  });

  it('brings the child back before a pipe request from the main process (thread persistence)', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => '' });
    await h.service.start();
    await h.crash();
    // 主动重拉还没到时间（默认设成 60 秒），管道请求自己先拉起子进程，而不是报 ENOENT
    await expect(h.service.request('thread.list')).resolves.toEqual([]);
    expect(h.launches).toHaveLength(2);
  });

  it('does not relaunch after stop', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => '' }, { relaunchDelayMs: 5 });
    await h.service.start();
    await h.crash();
    await h.service.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.launches).toHaveLength(1);
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

  it('routes private knowledge calls through the child Wiki scheduler without altering JSON prompts', async () => {
    const seen: Record<string, unknown>[] = [];
    h = harness({ describe: async () => 'configured/wiki-model', complete: async (input) => {
      seen.push(input);
      return '{"page":"original JSON"}';
    } });
    await expect(h.service.describeKnowledgeModel()).resolves.toBe('configured/wiki-model');
    const expectedConfiguration = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    await expect(h.service.completeKnowledge({ user: 'exact repo source', systemPrompt: 'strict JSON', maxTokens: 8192, expectedModel: 'configured/wiki-model', expectedConfiguration }))
      .resolves.toBe('{"page":"original JSON"}');
    expect(seen).toEqual([{ user: 'exact repo source', systemPrompt: 'strict JSON', maxTokens: 8192, expectedModel: 'configured/wiki-model', expectedConfiguration }]);
    const extension = new AgentDataClient(await h.service.agentEndpoint(join(h.dir, 'ws')));
    try {
      await expect(extension.request('agentdata.knowledge.complete', { requestId: 'spoof', input: { user: 'forbidden' } })).rejects.toBeTruthy();
      await expect(h.service.requestAdmin('agentdata.knowledge.complete', { requestId: 'spoof', input: { user: 'forbidden' } })).rejects.toThrow(/METHOD_NOT_FOUND|unknown management/);
      expect(seen).toHaveLength(1);
    } finally { await extension.close(); }
  });

  it('rejects malformed private knowledge configuration identities before model dispatch', async () => {
    const seen: string[] = [];
    h = harness({ describe: async () => 'p/m', complete: async ({ user }) => { seen.push(String(user)); return '{}'; } });
    await h.service.start();
    for (const expectedConfiguration of ['', 'not-a-hash', 'a'.repeat(63), 'g'.repeat(64), 123]) {
      await expect(h.launches[0].mainPeer.request('agentdata.knowledge.complete', { requestId: `invalid-${String(expectedConfiguration)}`, input: { user: 'never dispatch', expectedConfiguration } }))
        .rejects.toThrow(/configuration/i);
    }
    expect(seen).toEqual([]);
  });

  it('cancels a private knowledge call all the way to the main model signal', async () => {
    let signal: AbortSignal | undefined;
    h = harness({ describe: async () => 'p/m', complete: (_input, _usage, current) => new Promise((_resolve, reject) => {
      signal = current;
      current.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
    }) });
    const controller = new AbortController();
    const request = h.service.completeKnowledge({ user: 'private slow request' }, { signal: controller.signal });
    const failure = request.catch((error: Error) => error.message);
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    expect(await failure).toContain('aborted');
    expect(signal!.aborted).toBe(true);
  });

  it('rejects pre-cancelled private knowledge calls without starting the host', async () => {
    h = harness({ describe: async () => 'p/m', complete: async () => 'must not execute' });
    const controller = new AbortController(); controller.abort();
    await expect(h.service.completeKnowledge({ user: 'never dispatch' }, { signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(h.launches).toHaveLength(0);
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
    // 管道请求自己把子进程拉回来，新进程带着主进程记下的工作区
    await expect(h.service.request('codeRetrieval.admin.projects')).resolves.toEqual([{ workspace: join(h.dir, 'ws'), indexed: false }]);
  });
});
