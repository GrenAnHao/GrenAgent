import { describe, expect, it, vi } from 'vitest';
import { AGENT_METHODS, HOST_METHODS, type AgentMethod } from './contract.js';
import { hostApiOverRequest } from './hostApi.js';
import { createAgentPorts, createHostMethods, WorkspaceTracker, type HostDeps } from './mainBindings.js';

function hostDeps(over: Partial<HostDeps> = {}): HostDeps {
  return {
    resolveWorkspace: vi.fn(async (path: string) => `real:${path}`),
    agentDataEndpoint: vi.fn(() => '{"port":1}'),
    mcpRuntime: vi.fn(async () => [{ name: 'a', config: { command: 'x' } }]),
    allowedPluginIds: vi.fn(() => ['mcp']),
    authorize: vi.fn(async () => ({ status: 'allowed' as const, decision: 'allow' as const })),
    mergeRuntimeSettings: vi.fn(async () => {}),
    thread: {
      createThread: vi.fn(async () => ({})),
      createTurn: vi.fn(async () => ({})),
      updateTurn: vi.fn(async () => ({})),
      upsertItem: vi.fn(async () => ({})),
    },
    ...over,
  };
}

describe('createHostMethods', () => {
  it('处理表正好覆盖 HOST_METHODS', () => {
    expect(Object.keys(createHostMethods(hostDeps())).sort()).toEqual([...HOST_METHODS].sort());
  });

  it('子进程经 hostApi 发出的每个调用都落到对应的主进程依赖上', async () => {
    const deps = hostDeps();
    const methods = createHostMethods(deps);
    // 把 hostApi 直接接到处理表上，验证两边的方法名和参数形状对得上
    const host = hostApiOverRequest(async (method, params) => methods[method](params ?? {}) as never);

    await expect(host.resolveWorkspace('D:/p')).resolves.toBe('real:D:/p');
    await expect(host.agentDataEndpoint('D:/p')).resolves.toBe('{"port":1}');
    await expect(host.mcpRuntime('D:/p')).resolves.toEqual([{ name: 'a', config: { command: 'x' } }]);
    await expect(host.allowedPluginIds()).resolves.toEqual(['mcp']);
    await host.authorize({ kind: 'pi.agent_prompt', workspace: 'D:/p' }, 'interactive');
    expect(deps.authorize).toHaveBeenCalledWith({ kind: 'pi.agent_prompt', workspace: 'D:/p' }, 'interactive');
    await host.mergeRuntimeSettings({ 'approval:D:/p': 'ask' });
    expect(deps.mergeRuntimeSettings).toHaveBeenCalledWith({ 'approval:D:/p': 'ask' });
    await host.thread.createThread({ id: 't', projectId: 'p', workspace: 'D:/p' });
    expect(deps.thread.createThread).toHaveBeenCalledWith({ id: 't', projectId: 'p', workspace: 'D:/p' });
    await host.thread.updateTurn('turn-1', { status: 'completed', completedAt: 5 });
    expect(deps.thread.updateTurn).toHaveBeenCalledWith('turn-1', { status: 'completed', completedAt: 5 });
    await host.thread.upsertItem({ id: 'i', threadId: 't', turnId: 'u', type: 'tool_call', status: 'started', payload: {} });
    expect(deps.thread.upsertItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'i', type: 'tool_call' }));
  });

  it('主进程没有 AgentData 端点时子进程拿到 undefined', async () => {
    const methods = createHostMethods(hostDeps({ agentDataEndpoint: () => undefined }));
    const host = hostApiOverRequest(async (method, params) => methods[method](params ?? {}) as never);
    await expect(host.agentDataEndpoint('D:/p')).resolves.toBeUndefined();
  });

  it('授权请求缺 kind 时按 unknown 交给 PermissionManager，缺档位时按 interactive', async () => {
    const deps = hostDeps();
    await createHostMethods(deps)['host.authorize']({ operation: { workspace: 'D:/p' } });
    expect(deps.authorize).toHaveBeenCalledWith({ workspace: 'D:/p', kind: 'unknown' }, 'interactive');
  });

  it('runtime-settings 补丁里出现非字符串值时拒绝写', async () => {
    const deps = hostDeps();
    await expect(createHostMethods(deps)['host.mergeRuntimeSettings']({ patch: { a: 1 } })).rejects.toThrow('patch values must be strings');
    expect(deps.mergeRuntimeSettings).not.toHaveBeenCalled();
  });

  it('参数缺失时报清楚的错误', async () => {
    await expect(Promise.resolve().then(() => createHostMethods(hostDeps()))
      .then((methods) => methods['host.resolveWorkspace']({}))).rejects.toThrow('path must be a non-empty string');
  });
});

describe('createAgentPorts', () => {
  function ports() {
    const calls: Array<[AgentMethod, Record<string, unknown> | undefined]> = [];
    const request = vi.fn(async (method: AgentMethod, params?: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === 'pi.permissionProfile') return null;
      return { method };
    });
    return { agent: createAgentPorts(request as never), calls };
  }

  it('只调用 AGENT_METHODS 里登记过的方法', async () => {
    const { agent, calls } = ports();
    await Promise.all([
      agent.pi.openWorkspace('D:/p'),
      agent.pi.listRunningTurns(),
      agent.pi.warmWorkspace('D:/p'),
      agent.pi.closeWorkspace('D:/p'),
      agent.pi.respondUi('D:/p', { id: 'r' }),
      agent.pi.send('D:/p', 'agent_get_state', {}),
      agent.pi.permissionProfile('D:/p', 's1'),
      agent.pi.refreshModelRegistry(),
      agent.pi.enqueueTurn('D:/p', 'hi', 'workspace', { sessionId: 's1' }),
      agent.pi.releaseSessions(['a.jsonl']),
      agent.pi.ownsSession('D:/p', 's1'),
      agent.pi.activeModel('D:/p'),
      agent.subagent.list('D:/p'),
      agent.subagent.transcript('D:/p', 'id'),
      agent.subagent.sessionMessages('a.jsonl'),
      agent.subagent.catalog('p.jsonl'),
      agent.subagent.catalogRowSample('c.jsonl'),
      agent.subagent.promptChild('D:/p', 'p.jsonl', 'c.jsonl', 'hi', 'steer'),
      agent.subagent.interruptChild('D:/p', 'p.jsonl', 'c.jsonl'),
      agent.subagent.cancel('D:/p', 'id'),
      agent.jobs.snapshot('j', 1),
      agent.jobs.kill('j', 1),
      agent.mcp.hotReload('D:/p', '[]'),
      agent.mcp.reload('D:/p', 'a'),
      agent.mcp.probe('{}'),
      agent.mcp.workspaceForCwd('D:/p'),
      agent.controlPlane.release('D:/p'),
      agent.controlPlane.releaseChildForDelete('D:/p', null, 'c.jsonl'),
      agent.resources.reload(),
      agent.extensions.catalog(),
      agent.usage.report(),
      agent.usage.reconcile(),
    ]);
    const used = new Set(calls.map(([method]) => method));
    for (const method of used) expect(AGENT_METHODS).toContain(method);
    // 每个登记过的方法都有对应的端口，没有闲置的方法名
    expect([...used].sort()).toEqual([...AGENT_METHODS].sort());
  });

  it('命令参数原样转发给子进程', async () => {
    const { agent, calls } = ports();
    await agent.pi.send('D:/p', 'agent_prompt', { message: 'hi', targetSessionPath: 'x.jsonl' });
    expect(calls).toEqual([['pi.send', { workspace: 'D:/p', command: 'agent_prompt', args: { message: 'hi', targetSessionPath: 'x.jsonl' } }]]);
  });

  it('子进程没有记录权限档时退回 undefined', async () => {
    const { agent } = ports();
    await expect(agent.pi.permissionProfile('D:/p')).resolves.toBeUndefined();
  });

  it('发过运行时命令的工作区记进 tracker，关掉的移出', async () => {
    const tracker = new WorkspaceTracker();
    const agent = createAgentPorts((async () => null) as never, tracker);
    await agent.pi.openWorkspace('D:/a');
    await agent.pi.send('D:/b', 'agent_get_state', {});
    await agent.pi.warmWorkspace('D:/c');
    await agent.pi.closeWorkspace('D:/c');
    await agent.subagent.list('D:/d');
    expect(tracker.drain().sort()).toEqual(['D:/a', 'D:/b']);
    expect(tracker.drain()).toEqual([]);
  });

  it('子进程不在跑时，释放 / 查询类调用直接给兜底值，不发请求', async () => {
    const request = vi.fn(async () => { throw new Error('should not be called'); });
    const agent = createAgentPorts({ request: request as never, isRunning: () => false });
    await expect(agent.pi.closeWorkspace('D:/p')).resolves.toBeUndefined();
    await expect(agent.pi.releaseSessions(['a.jsonl'])).resolves.toBeUndefined();
    await expect(agent.pi.permissionProfile('D:/p', 's1')).resolves.toBeUndefined();
    await expect(agent.pi.ownsSession('D:/p', 's1')).resolves.toBe(false);
    await expect(agent.pi.activeModel('D:/p')).resolves.toBeNull();
    await expect(agent.pi.listRunningTurns()).resolves.toEqual([]);
    await expect(agent.pi.refreshModelRegistry()).resolves.toEqual({ refreshed: [], failed: [] });
    await expect(agent.jobs.snapshot('j', 1)).resolves.toBeNull();
    await expect(agent.jobs.kill('j', 1)).resolves.toBe('not-found');
    await expect(agent.mcp.hotReload('D:/p', '[]')).resolves.toBeUndefined();
    await expect(agent.mcp.workspaceForCwd('D:/cwd')).resolves.toBe('D:/cwd');
    await expect(agent.controlPlane.release('D:/p')).resolves.toBeUndefined();
    await expect(agent.controlPlane.releaseChildForDelete('D:/p', 'a1', 'c.jsonl')).resolves.toEqual({ quiescent: true });
    expect(request).not.toHaveBeenCalled();
  });

  it('子进程不在跑时，运行时命令照常转发（由它拉起子进程）', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const agent = createAgentPorts({ request: request as never, isRunning: () => false });
    await agent.pi.openWorkspace('D:/p');
    await agent.pi.send('D:/p', 'agent_prompt', { message: 'hi' });
    await agent.mcp.probe('{}');
    expect(request.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['pi.openWorkspace', 'pi.send', 'mcp.probe']);
  });

  it('子进程不可用时请求带着原因失败', async () => {
    const agent = createAgentPorts((async () => { throw new Error('AGENT_HOST_CRASH_LOOP'); }) as never);
    await expect(agent.pi.send('D:/p', 'agent_get_state', {})).rejects.toThrow('AGENT_HOST_CRASH_LOOP');
  });
});
