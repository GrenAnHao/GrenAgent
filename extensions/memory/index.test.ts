import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import memory from './index.js';
import { MemoryClient } from './client.js';
import { getConfig } from '../_shared/runtime-config.js';

vi.mock('../_shared/runtime-config.js', () => ({ getConfig: vi.fn() }));

describe('memory extension', () => {
  it('registers local search tools and recall hook', () => {
    const tools: string[] = []; const events: string[] = [];
    memory({ registerTool: (tool: { name: string }) => tools.push(tool.name), on: (name: string) => events.push(name) } as never);
    expect(tools).toEqual(expect.arrayContaining(['memory_search', 'conversation_search']));
    expect(events).toEqual(expect.arrayContaining(['before_agent_start', 'agent_end']));
  });
});

function setup() {
  const on = vi.fn();
  const registerTool = vi.fn();
  memory({ on, registerTool } as unknown as ExtensionAPI);
  const sessionManager = SessionManager.inMemory('/repo');
  const ctx = { cwd: '/repo', sessionManager } as unknown as ExtensionContext;
  const emit = (name: string, event: unknown) => on.mock.calls.find(([key]) => key === name)![1](event, ctx);
  return { emit, ctx, sessionManager, tool: (name: string) => registerTool.mock.calls.find(([tool]) => tool.name === name)![0] };
}

describe('memory extension integration', () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReset();
    vi.stubEnv('PI_IS_SUBAGENT', '');
    vi.stubEnv('PI_SYSTEM_WORKER', '');
    vi.spyOn(MemoryClient.prototype, 'request').mockImplementation(async (method) => method === 'memory.capture'
      ? { changed: true, delta: 'capture', taskId: 'task' }
      : [{ level: 1, content: 'remembered' }]);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(['PI_IS_SUBAGENT', 'PI_SYSTEM_WORKER'])('skips automatic memory inside %s', async (key) => {
    vi.stubEnv(key, '1');
    const { emit } = setup();
    await emit('before_agent_start', { prompt: 'remember this' });
    await emit('agent_end', { messages: [{ role: 'user', content: 'remember this' }] });
    expect(MemoryClient.prototype.request).not.toHaveBeenCalled();
  });

  it.each([
    ['MEMORY_AUTO_INJECT', 'before_agent_start', { prompt: 'remember this' }],
    ['MEMORY_AUTO_CAPTURE', 'agent_end', { messages: [{ role: 'user', content: 'remember this' }] }],
  ])('honors %s without disabling explicit tools', async (key, eventName, event) => {
    vi.mocked(getConfig).mockImplementation((name) => name === key ? '0' : undefined);
    const { emit, tool, ctx } = setup();
    await emit(eventName as string, event);
    expect(MemoryClient.prototype.request).not.toHaveBeenCalled();
    await tool('memory_search').execute('id', { query: 'remembered' }, undefined, undefined, ctx);
    expect(MemoryClient.prototype.request).toHaveBeenCalledWith('memory.search', expect.objectContaining({ query: 'remembered' }));
  });

  it('captures the accumulated active branch instead of only agent_end new messages', async () => {
    const { emit, sessionManager } = setup();
    const first = sessionManager.appendMessage({ role: 'user', content: 'first fact', timestamp: 1 });
    sessionManager.appendMessage({ role: 'user', content: 'discarded branch', timestamp: 2 });
    sessionManager.branch(first);
    sessionManager.appendMessage({ role: 'user', content: 'latest request', timestamp: 3 });
    await emit('agent_end', { messages: [{ role: 'user', content: 'latest request' }] });
    expect(MemoryClient.prototype.request).toHaveBeenCalledWith('memory.capture', expect.objectContaining({ transcript: 'user: first fact\nuser: latest request' }));
  });

  it('keeps capture enabled while MEMORY_EXTRACT disables background extraction', async () => {
    vi.mocked(getConfig).mockImplementation((name) => name === 'MEMORY_EXTRACT' ? '0' : undefined);
    const { emit, sessionManager } = setup();
    sessionManager.appendMessage({ role: 'user', content: 'keep raw text', timestamp: 1 });
    await emit('agent_end', { messages: [] });
    expect(MemoryClient.prototype.request).toHaveBeenCalledWith('memory.capture', expect.objectContaining({ transcript: 'user: keep raw text', extract: false }));
  });

  it('routes conversation search to captured conversations within the current project', async () => {
    const { tool, ctx, sessionManager } = setup();
    await tool('conversation_search').execute('id', { query: 'raw words' }, undefined, undefined, ctx);
    // 项目归属按会话头里的原始目录（切到 worktree 后也不变），不是 ctx.cwd。
    expect(MemoryClient.prototype.request).toHaveBeenCalledWith('memory.conversations.search', expect.objectContaining({ userId: 'local', projectId: sessionManager.getCwd(), query: 'raw words' }));
    expect(vi.mocked(MemoryClient.prototype.request).mock.calls[0][1]).not.toHaveProperty('includeOtherProjects');
  });
});
