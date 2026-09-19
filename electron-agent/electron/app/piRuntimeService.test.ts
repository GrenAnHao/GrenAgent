import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { getApprovalPolicy, __resetApprovalForTest } from '../../../extensions/_shared/approval.js';
import { getAgentMode, hasAgentMode, __resetAgentModeForTest } from '../../../extensions/agent-mode/modes.js';
import { PiRuntimeService, type AgentHostPort } from './piRuntimeService';

function fakeHandle(session: Record<string, unknown> = {}) {
  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : 'session-a';
  const sessionFile = typeof session.sessionFile === 'string' ? session.sessionFile : 'C:/sessions/a.jsonl';
  return {
    session: {
      sessionId,
      sessionFile,
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(async () => {}),
      isStreaming: false,
      getFollowUpMessages: vi.fn(() => []),
      clearQueue: vi.fn(() => ({ steering: [] as string[], followUp: [] as string[] })),
      waitForIdle: vi.fn(async () => {}),
      setModel: vi.fn(),
      cycleModel: vi.fn(),
      setThinkingLevel: vi.fn(),
      cycleThinkingLevel: vi.fn(),
      compact: vi.fn(),
      setAutoCompactionEnabled: vi.fn(),
      abortRetry: vi.fn(),
      getSessionStats: vi.fn(() => ({})),
      getUserMessagesForForking: vi.fn(() => []),
      setSessionName: vi.fn(),
      messages: [],
      modelRuntime: { getAvailableSnapshot: () => [] },
      sessionManager: { getLeafId: () => 'leaf' },
      ...session,
    },
    prompt: vi.fn(async () => {}),
    getState: vi.fn(() => ({ sessionFile, sessionId })),
    getCommands: vi.fn(() => ({ commands: [] })),
    newSession: vi.fn(async () => ({ cancelled: false })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false })),
    ui: { respond: vi.fn() },
    currentTurnOrigin: 'main' as const,
    dispose: vi.fn(async () => {}),
  } as any;
}

function fakeAgentHost(handle = fakeHandle()) {
  let opened = false;
  return {
    host: {
      open: vi.fn(async () => { opened = true; return handle; }),
      get: vi.fn(() => (opened ? handle : undefined)),
      close: vi.fn(async () => {}),
      workspaces: vi.fn(() => []),
    } as AgentHostPort,
    handle,
  };
}
const noopModelHost = { refresh: vi.fn(async () => {}), workspaces: () => [] };

function hostSwitchingSession(sourceFile: string, targetFile: string) {
  let activeFile = sourceFile;
  const handle = fakeHandle();
  handle.getState = vi.fn(() => ({ sessionFile: activeFile }));
  handle.fork = vi.fn(async () => {
    activeFile = targetFile;
    return { cancelled: false };
  });
  handle.switchSession = vi.fn(async (sessionPath: string) => {
    activeFile = sessionPath;
    return { cancelled: false };
  });
  return fakeAgentHost(handle);
}

describe('PiRuntimeService', () => {
  it('keeps turns and late lifecycle events isolated for two sessions in one workspace', async () => {
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { message: 'A', sessionId: 'session-a' });
    await service.send('C:/work', 'agent_prompt', { message: 'B', sessionId: 'session-b' });
    const turns = thread.createTurn.mock.calls.map(([input]) => input);
    expect(turns).toEqual([
      expect.objectContaining({ input: 'A', sessionId: 'session-a' }),
      expect.objectContaining({ input: 'B', sessionId: 'session-b' }),
    ]);

    await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, 'session-a');
    expect(thread.updateTurn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'completed' }));
    const completedTurnId = thread.updateTurn.mock.calls.at(-1)?.[0];
    expect(completedTurnId).toBe(turns[0].id);

    await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, 'session-a');
    expect(thread.updateTurn).toHaveBeenCalledTimes(1);
    await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, 'session-b');
    expect(thread.updateTurn).toHaveBeenCalledWith(turns[1].id, expect.objectContaining({ status: 'completed' }));
  });

  it('turnConfig exposes the Agent Data endpoint without process-level keys', async () => {
    const { host } = fakeAgentHost();
    const endpoint = vi.fn(() => 'project-endpoint');
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
      runtimeConfigPath: 'C:/runtime.json',
      allowedPluginIds: () => ['approval'],
      agentDataEndpoint: endpoint,
      resolveWorkspace: async () => 'D:/resolved-project',
    });
    const env = await service.turnConfig('alias', 'D:/resolved-project', 'main');
    expect(endpoint).toHaveBeenCalledWith('D:/resolved-project');
    expect(env).toEqual(expect.objectContaining({
      AGENT_DATA_ENDPOINT: 'project-endpoint',
      PI_PERMISSION_PROFILE: 'workspace',
      PI_HUMAN_ORIGIN_TOKEN: '1',
    }));
    expect(env).not.toHaveProperty('PI_PACKAGE_DIR');
    expect(env).not.toHaveProperty('PI_RUNTIME_CONFIG');
    expect(env).not.toHaveProperty('PI_GOAL_WORKER');
    expect(env).not.toHaveProperty('PI_ALLOWED_EXTENSIONS');
    await service.openWorkspace('alias');
    expect(host.open).toHaveBeenCalledWith('alias', 'D:/resolved-project');
  });

  it('does not bind a foreign last_session onto a draft workspace; newSession still works', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-foreign-session-'));
    const foreign = join(root, 'foreign.jsonl');
    await writeFile(foreign, `${JSON.stringify({ type: 'session', id: 'foreign-session', cwd: 'C:/other-project' })}\n`);
    const handle = fakeHandle({ sessionId: 'foreign-session', sessionFile: foreign });
    handle.getState = vi.fn(() => ({ sessionFile: foreign, sessionId: 'foreign-session' }));
    const { host } = fakeAgentHost(handle);
    const draft = 'C:/Users/me/.pi/agent/works/3778c198-1830-4aa9-a0eb-78549e8c4456';
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
    try {
      await expect(service.openWorkspace(draft)).resolves.toMatchObject({ sessionFile: null });
      await expect(service.send(draft, 'agent_get_state', {})).resolves.toMatchObject({ sessionFile: null });
      await expect(service.send(draft, 'agent_new_session', {})).resolves.toEqual({ cancelled: false });
      expect(handle.newSession).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('opens a workspace and forwards agent commands to its Pi client', async () => {
    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile: 'C:/sessions/a.jsonl' }));
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });

    await expect(service.openWorkspace('C:/work')).resolves.toMatchObject({ restoredSession: null, sessionFile: 'C:/sessions/a.jsonl' });
    await expect(service.send('C:/work', 'agent_get_state', {})).resolves.toMatchObject({ sessionFile: 'C:/sessions/a.jsonl' });
    expect(host.open).toHaveBeenCalledWith('C:/work', 'C:/work');
    expect(handle.getState).toHaveBeenCalled();
  });

  it('get_available_models 把 thinkingLevelMap getter 拍成可 IPC 的纯对象', async () => {
    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile: 'C:/sessions/a.jsonl' }));
    handle.session.modelRuntime = {
      getAvailableSnapshot: () => [{
        get id() { return 'flash'; },
        get provider() { return 'deepseek'; },
        get api() { return 'openai-completions'; },
        get reasoning() { return true; },
        get thinkingLevelMap() { return { low: 'low', high: 'high' }; },
        think() { return 'side-effect'; },
      }],
    };
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
    await service.openWorkspace('C:/work');
    await expect(service.send('C:/work', 'agent_get_available_models', {})).resolves.toEqual({
      models: [{
        id: 'flash',
        provider: 'deepseek',
        api: 'openai-completions',
        reasoning: true,
        thinkingLevelMap: { low: 'low', high: 'high' },
      }],
    });
  });

  it.each(['agent_fork', 'agent_clone'] as const)('notifies session fork handling for %s', async (command) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-fork-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    await writeFile(targetFile, JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }) + '\n');
    const { host, handle } = hostSwitchingSession(sourceFile, targetFile);
    const onSessionForked = vi.fn(async () => {});
    const service = new PiRuntimeService({
      agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost,
      onSessionForked,
    });
    try {
      await expect(service.send('C:/work', command, { sessionId: 'source-session', sessionPath: sourceFile })).resolves.toEqual({ cancelled: false });
      expect(onSessionForked).toHaveBeenCalledWith(expect.objectContaining({
        workspace: 'C:/work', sourceSessionId: 'source-session', targetSessionId: 'target-session',
      }));
      expect(handle.fork).toHaveBeenCalled();
      expect(handle.getState).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['agent_fork', 'agent_clone'] as const)('does not notify a cancelled session fork for %s', async (command) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-fork-cancelled-'));
    const sourceFile = join(root, 'source.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    const handle = fakeHandle();
    handle.getState = vi.fn(() => ({ sessionFile: sourceFile }));
    handle.fork = vi.fn(async () => ({ cancelled: true }));
    const { host } = fakeAgentHost(handle);
    const onSessionForked = vi.fn();
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, onSessionForked });
    try {
      await expect(service.send('C:/work', command, { sessionId: 'source-session', sessionPath: sourceFile })).resolves.toEqual({ cancelled: true });
      expect(onSessionForked).not.toHaveBeenCalled();
      expect(handle.fork).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries failed session fork synchronization on the next state refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-fork-retry-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    await writeFile(targetFile, JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }) + '\n');
    const { host } = hostSwitchingSession(sourceFile, targetFile);
    let forkAttempts = 0;
    const onSessionForked = vi.fn(async () => {
      forkAttempts += 1;
      if (forkAttempts === 1) throw new Error('temporary AgentData outage');
    });
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, onSessionForked });
    try {
      await expect(service.send('C:/work', 'agent_fork', { sessionId: 'source-session', sessionPath: sourceFile })).resolves.toEqual({ cancelled: false });
      expect(onSessionForked).toHaveBeenCalledOnce();

      await service.send('C:/work', 'agent_get_state', {});
      expect(onSessionForked).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tracks a switched session only after Pi accepts the switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-switch-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    await writeFile(targetFile, JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }) + '\n');
    const { host, handle } = hostSwitchingSession(sourceFile, targetFile);
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
    try {
      await service.openWorkspace('C:/work');
      await service.send('C:/work', 'agent_switch_session', { sessionPath: targetFile });
      expect(handle.switchSession).toHaveBeenCalledWith(targetFile);
      await expect(service.ownsSession('C:/work', 'target-session')).resolves.toBe(true);
      await expect(service.ownsSession('C:/work', 'source-session')).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the current session when Pi cancels a session switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-switch-cancelled-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    await writeFile(targetFile, JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }) + '\n');
    const handle = fakeHandle();
    handle.getState = vi.fn(() => ({ sessionFile: sourceFile }));
    handle.switchSession = vi.fn(async () => ({ cancelled: true }));
    const { host } = fakeAgentHost(handle);
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
    try {
      await service.openWorkspace('C:/work');
      await expect(service.send('C:/work', 'agent_switch_session', { sessionPath: targetFile })).resolves.toEqual({ cancelled: true });
      expect(handle.switchSession).toHaveBeenCalledTimes(1);
      await expect(service.ownsSession('C:/work', 'source-session')).resolves.toBe(true);
      await expect(service.ownsSession('C:/work', 'target-session')).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects commands that do not map to a Pi RPC operation', async () => {
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost });

    await expect(service.send('C:/work', 'agent_not_real', {})).rejects.toThrow('Unsupported Pi command');
  });

  it('opens a workspace on the first agent command when warm_workspace has not run yet', async () => {
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });

    await expect(service.send('C:/work', 'agent_get_state', {})).resolves.toMatchObject({ sessionFile: 'C:/sessions/a.jsonl' });
    expect(host.open).toHaveBeenCalledWith('C:/work', 'C:/work');
    expect(handle.getState).toHaveBeenCalled();
  });

  it('keeps a prompt queued until Pi lifecycle events persist its items and complete it', async () => {
    const thread = { createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })), createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })), updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })), upsertItem: vi.fn(async (item) => item) };
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { prompt: 'hello' });

    expect(thread.createThread).toHaveBeenCalledOnce();
    expect(thread.createTurn).toHaveBeenCalledWith(expect.objectContaining({ input: 'hello' }));
    expect(thread.updateTurn).not.toHaveBeenCalled();

    await service.handlePiEvent('C:/work', { type: 'agent_start' });
    await service.handlePiEvent('C:/work', { type: 'message_start', message: { role: 'assistant', content: [] } });
    await service.handlePiEvent('C:/work', { type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', delta: 'hi' } });
    await service.handlePiEvent('C:/work', { type: 'message_end', message: { role: 'assistant', content: [] } });
    await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] });

    expect(thread.updateTurn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ status: 'completed' }));
    // 流式中间态（message_update → item.delta）不落盘：逐条写走 node:sqlite 的同步 API，会阻塞
    // 主进程事件循环、把 webContents.send 排到后面，表现为思考/正文「卡在第一个字直到整段返回」。
    // 只有 created（message_start）与 updated（message_end）落盘，items 表终态语义不变。
    expect(thread.upsertItem).toHaveBeenCalledTimes(2);
    // start / end 两条必须落到同一个 item：withStableItemId 为未带 id 的 assistant
    // 消息补一个稳定 id，否则每条生命周期事件会各建一条 item。
    const itemIds = thread.upsertItem.mock.calls.map(([item]) => item.id);
    expect(itemIds).toHaveLength(2);
    expect(new Set(itemIds).size).toBe(1);
    expect(thread.upsertItem).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'assistant_message', status: 'completed' }));
  });

  it('does not create a turn for extension slash commands', async () => {
    const { host, handle } = fakeAgentHost();
    const thread = { createThread: vi.fn(), createTurn: vi.fn(), updateTurn: vi.fn() };
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { message: '/goal write tests' });

    expect(handle.prompt).toHaveBeenCalledWith('/goal write tests', { images: undefined }, 'main');
    expect(thread.createThread).not.toHaveBeenCalled();
    expect(thread.createTurn).not.toHaveBeenCalled();
  });

  it('steers the active Turn and queues follow-up prompts without replacing it', async () => {
    const { host, handle } = fakeAgentHost();
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { message: 'first' });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'steer now', streamingBehavior: 'steer' })).resolves.toBeUndefined();
    await expect(service.send('C:/work', 'agent_prompt', { message: 'after this', streamingBehavior: 'followUp' })).resolves.toMatchObject({ status: 'queued', position: 1 });

    expect(thread.createTurn).toHaveBeenCalledOnce();
    expect(handle.prompt).toHaveBeenCalledTimes(2);
    expect(handle.prompt).toHaveBeenNthCalledWith(2, 'steer now', { images: undefined, streamingBehavior: 'steer' }, 'main');
  });

  it('does not let a later prompt jump a queued follow-up', async () => {
    const { host, handle } = fakeAgentHost();
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { message: 'first' });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'queued first', streamingBehavior: 'followUp' }))
      .resolves.toMatchObject({ status: 'queued', position: 1 });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'jumper' }))
      .resolves.toMatchObject({ status: 'queued', position: 2 });

    expect(handle.prompt).toHaveBeenCalledTimes(1);
    expect(handle.session.followUp).not.toHaveBeenCalled();
  });

  it('drains a queued follow-up when the terminal callback rejects', async () => {
    const { host, handle } = fakeAgentHost();
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const onTurnSettled = vi.fn(async () => { throw new Error('settled hook failed'); });
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as any, onTurnSettled });

    await service.send('C:/work', 'agent_prompt', { message: 'first', sessionId: 'session-a' });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'after this', streamingBehavior: 'followUp', sessionId: 'session-a' }))
      .resolves.toMatchObject({ status: 'queued', position: 1 });

    await expect(service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, 'session-a')).rejects.toThrow('settled hook failed');
    expect(handle.session.followUp).toHaveBeenCalledWith('after this', undefined);
    expect(thread.createTurn).toHaveBeenCalledOnce();
    expect(onTurnSettled).toHaveBeenCalledOnce();
  });

  it('idle empty followUp prompt starts the first queued follow-up as a real turn', async () => {
    const handle = fakeHandle({
      isStreaming: false,
      getFollowUpMessages: vi.fn(() => ['改用 chrome 跑自动化']),
      clearQueue: vi.fn(() => ({ steering: [], followUp: ['改用 chrome 跑自动化'] })),
    });
    const { host } = fakeAgentHost(handle);
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });

    await service.send('C:/work', 'agent_prompt', { message: '', streamingBehavior: 'followUp' });

    expect(handle.session.clearQueue).toHaveBeenCalledTimes(1);
    expect(handle.prompt).toHaveBeenCalledWith('改用 chrome 跑自动化', { images: undefined }, 'main');
  });

  it('follow-up after abort does not occupy the active turn and block a later prompt', async () => {
    const { host, handle } = fakeAgentHost();
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { message: 'first', sessionId: 'session-a' });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'after this', streamingBehavior: 'followUp', sessionId: 'session-a' }))
      .resolves.toMatchObject({ status: 'queued', position: 1 });
    await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, 'session-a');

    await service.send('C:/work', 'agent_prompt', { message: 'next typed', sessionId: 'session-a' });
    expect(handle.prompt).toHaveBeenCalledWith('next typed', { images: undefined }, 'main');
  });

  it('writes mode/approval/exclusion to runtime settings without slash prompts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-settings-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
      runtimeConfigPath,
    });

    try {
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'plan' })).resolves.toEqual({ ok: true, mode: 'plan' });
      await expect(service.send('C:/work', 'agent_set_approval', { level: 'full' })).resolves.toEqual({ ok: true, level: 'full' });
      await expect(service.send('C:/work', 'agent_exclude_entry', { timestamp: 101 })).resolves.toEqual({ ok: true, op: 'add', timestamp: 101 });
      await expect(service.send('C:/work', 'agent_restore_entry', { timestamp: 101 })).resolves.toEqual({ ok: true, op: 'remove', timestamp: 101 });
      expect(handle.prompt).not.toHaveBeenCalled();

      const written = JSON.parse(await readFile(runtimeConfigPath, 'utf8')) as Record<string, string>;
      expect(written['AGENT_MODE:c:/work']).toBe('plan');
      expect(written['APPROVAL_POLICY:c:/work']).toBe('full');
      expect(JSON.parse(written['CONTEXT_EXCLUSION_OP:c:/work'])).toMatchObject({ op: 'remove', ts: 101 });
      expect(getApprovalPolicy('C:/work')).toBe('full');
    } finally {
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('对话中切审批档立刻打进内存，不跟盘上旧值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-approval-live-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, JSON.stringify({ 'APPROVAL_POLICY:c:/work': 'ask' }));
    __resetApprovalForTest();
    const { host } = fakeAgentHost();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
      runtimeConfigPath,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_approval', { level: 'full' })).resolves.toEqual({ ok: true, level: 'full' });
      await writeFile(runtimeConfigPath, JSON.stringify({ 'APPROVAL_POLICY:c:/work': 'ask' }));
      expect(getApprovalPolicy('C:/work')).toBe('full');
    } finally {
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts readonly and workspace approval levels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-approval-five-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetApprovalForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      runtimeConfigPath,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_approval', { level: 'readonly' }))
        .resolves.toEqual({ ok: true, level: 'readonly' });
      await expect(service.send('C:/work', 'agent_set_approval', { level: 'workspace' }))
        .resolves.toEqual({ ok: true, level: 'workspace' });
    } finally {
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('非法审批档不写内存也不落盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-approval-invalid-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, JSON.stringify({ 'APPROVAL_POLICY:c:/work': 'ask' }));
    __resetApprovalForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      runtimeConfigPath,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_approval', { level: 'nope' })).rejects.toThrow('INVALID_APPROVAL_POLICY');
      expect(getApprovalPolicy('C:/work')).toBe('auto');
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))['APPROVAL_POLICY:c:/work']).toBe('ask');
    } finally {
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('无 runtimeConfigPath 时审批内存已改再抛', async () => {
    __resetApprovalForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_approval', { level: 'full' })).rejects.toThrow('RUNTIME_CONFIG_UNAVAILABLE');
      expect(getApprovalPolicy('C:/work')).toBe('full');
    } finally {
      __resetApprovalForTest();
    }
  });

  it('对话中切模式立刻打进内存，不跟盘上旧值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-mode-live-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, JSON.stringify({ 'AGENT_MODE:c:/work': 'agent' }));
    __resetAgentModeForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      runtimeConfigPath,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'ask' })).resolves.toEqual({ ok: true, mode: 'ask' });
      await writeFile(runtimeConfigPath, JSON.stringify({ 'AGENT_MODE:c:/work': 'agent' }));
      expect(getAgentMode('C:/work')).toBe('ask');
    } finally {
      __resetAgentModeForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writeAgentMode 同时写入 resolved 键', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-mode-resolved-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetAgentModeForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      runtimeConfigPath,
      resolveWorkspace: async () => 'D:/resolved-project',
    });
    try {
      await expect(service.send('alias', 'agent_set_mode', { mode: 'debug' })).resolves.toEqual({ ok: true, mode: 'debug' });
      expect(getAgentMode('alias')).toBe('debug');
      expect(getAgentMode('D:/resolved-project')).toBe('debug');
      const written = JSON.parse(await readFile(runtimeConfigPath, 'utf8')) as Record<string, string>;
      expect(written['AGENT_MODE:alias']).toBe('debug');
      expect(written['AGENT_MODE:d:/resolved-project']).toBe('debug');
    } finally {
      __resetAgentModeForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('非法模式不写内存也不落盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-mode-invalid-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, JSON.stringify({ 'AGENT_MODE:c:/work': 'agent' }));
    __resetAgentModeForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      runtimeConfigPath,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'nope' })).rejects.toThrow('INVALID_AGENT_MODE');
      expect(getAgentMode('C:/work')).toBe('agent');
      expect(hasAgentMode('C:/work')).toBe(false);
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))['AGENT_MODE:c:/work']).toBe('agent');
    } finally {
      __resetAgentModeForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('无 runtimeConfigPath 时模式内存已改再抛', async () => {
    __resetAgentModeForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'plan' })).rejects.toThrow('RUNTIME_CONFIG_UNAVAILABLE');
      expect(getAgentMode('C:/work')).toBe('plan');
    } finally {
      __resetAgentModeForTest();
    }
  });

  it('rewinds by resolving the message timestamp to an entry id before forking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-'));
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'root' }),
      JSON.stringify({ type: 'message', id: 'entry-1', message: { role: 'user', timestamp: 100 } }),
      JSON.stringify({ type: 'message', id: 'entry-2', message: { role: 'user', timestamp: 200 } }),
    ].join('\n'));
    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile }));
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
    });

    try {
      await expect(service.send('C:/work', 'agent_rewind_to', { timestamp: 200 })).resolves.toEqual({ cancelled: false });
      expect(handle.fork).toHaveBeenCalledWith('entry-2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('进程内宿主交互路径', () => {
  it('agent_prompt 在 preflight 后立即返回', async () => {
    const { host, handle } = fakeAgentHost();
    handle.prompt = vi.fn(async () => {});
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await expect(service.send('C:/work', 'agent_prompt', { message: '你好' })).resolves.toBeUndefined();
    expect(handle.prompt).toHaveBeenCalledTimes(1);
  });

  it('agent_prompt 活跃时 session 替换命令抛 SESSION_BUSY', async () => {
    const { host, handle } = fakeAgentHost();
    handle.prompt = vi.fn(async () => {});
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: { createThread: async (i: never) => i, createTurn: async (i: never) => i, updateTurn: async (i: never) => i } as never });
    await service.send('C:/work', 'agent_prompt', { message: 'x' });
    await expect(service.send('C:/work', 'agent_new_session', {})).rejects.toThrow('SESSION_BUSY');
  });

  it('agent_set_mode 写 runtime config，不发斜杠 prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-set-mode-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({
      agentDir: 'C:/a',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
      runtimeConfigPath,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'plan' })).resolves.toEqual({ ok: true, mode: 'plan' });
      expect(handle.prompt).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('agent_abort 调 session.abort', async () => {
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await service.send('C:/work', 'agent_abort', {});
    expect(handle.session.abort).toHaveBeenCalledTimes(1);
  });

  it('refreshModelRegistry 在供应商消失后把会话模型切到仍可用的第一项', async () => {
    const fallback = { provider: 'openai', id: 'gpt' };
    const handle = fakeHandle({
      model: { provider: 'gone', id: 'flash' },
      modelRuntime: { getAvailableSnapshot: () => [fallback] },
    });
    const { host } = fakeAgentHost(handle);
    host.workspaces = vi.fn(() => ['C:/work']);
    host.get = vi.fn(() => handle);
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await expect(service.refreshModelRegistry()).resolves.toEqual({ refreshed: ['C:/work'], failed: [] });
    expect(handle.session.setModel).toHaveBeenCalledWith(fallback);
  });
});
