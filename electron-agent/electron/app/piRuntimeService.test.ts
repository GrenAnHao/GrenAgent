import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApprovalPolicy, __resetApprovalForTest } from '../../../extensions/_shared/approval.js';
import { getAgentMode, hasAgentMode, setAgentMode, __resetAgentModeForTest } from '../../../extensions/agent-mode/modes.js';
import { setSessionPlan, __resetPlanStateForTest } from '../../../extensions/agent-mode/planState.js';
import { createPlan } from '../../../extensions/agent-mode/plan.js';
import { PiRuntimeService, type AgentHostPort } from './piRuntimeService';
import { SessionManager } from '../../../cli/src/pi-sdk.js';

const fsRenameControl = vi.hoisted(() => ({ failNext: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsRenameControl.failNext) {
        fsRenameControl.failNext = false;
        throw new Error('rename blocked');
      }
      return actual.rename(...args);
    },
  };
});

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
      sessionManager: { getLeafId: () => 'leaf', setSessionFile: vi.fn() },
      agent: { state: { messages: [] as unknown[] } },
      _refreshFinalizedContext: vi.fn(),
      ...session,
    },
    prompt: vi.fn(async () => {}),
    getState: vi.fn(() => ({ sessionFile, sessionId })),
    getCommands: vi.fn(() => ({ commands: [] })),
    newSession: vi.fn(async () => ({ cancelled: false })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false })),
    reload: vi.fn(async () => {}),
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

  it('带 targetSessionPath 切模式 / 审批档只钉那份会话，并写会话条目', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-controls-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetApprovalForTest();
    __resetAgentModeForTest();
    const appendCustomEntry = vi.fn();
    const setStatus = vi.fn();
    const handle = fakeHandle();
    handle.session.sessionId = 'sid-a';
    handle.session.sessionFile = 'C:/work/a.jsonl';
    handle.session.sessionManager = { getLeafId: () => 'leaf', appendCustomEntry };
    handle.ui = { respond: vi.fn(), context: { setStatus } };
    const { host } = fakeAgentHost(handle);
    await host.open('C:/work', 'C:/work');
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, runtimeConfigPath });
    try {
      await service.send('C:/work', 'agent_set_approval', { level: 'readonly', targetSessionPath: 'C:/work/a.jsonl' });
      await service.send('C:/work', 'agent_set_mode', { mode: 'plan', targetSessionPath: 'C:/work/a.jsonl' });
      expect(getApprovalPolicy('C:/work', 'sid-a')).toBe('readonly');
      expect(getAgentMode('C:/work', 'sid-a')).toBe('plan');
      // 别的会话只继承项目默认（最近一次选择），不受 a 已钉住的值约束。
      __resetApprovalForTest();
      expect(getApprovalPolicy('C:/work', 'sid-b')).toBe('auto');
      expect(appendCustomEntry).toHaveBeenCalledWith('session-controls', { approval: 'readonly' });
      expect(appendCustomEntry).toHaveBeenCalledWith('session-controls', { mode: 'plan' });
      expect(setStatus).toHaveBeenCalledWith('agent-mode', 'plan');
    } finally {
      __resetApprovalForTest();
      __resetAgentModeForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('未确认的计划在场时手切到 Agent 被取消：不动内存、不落条目、不写盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-plan-guard-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetAgentModeForTest();
    __resetPlanStateForTest();
    const appendCustomEntry = vi.fn();
    const handle = fakeHandle();
    handle.session.sessionId = 'sid-a';
    handle.session.sessionFile = 'C:/work/a.jsonl';
    handle.session.sessionManager = { getLeafId: () => 'leaf', appendCustomEntry };
    handle.ui = { respond: vi.fn(), context: { setStatus: vi.fn() } };
    const { host } = fakeAgentHost(handle);
    await host.open('C:/work', 'C:/work');
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, runtimeConfigPath });
    try {
      setAgentMode('plan', 'C:/work', 'sid-a');
      setSessionPlan('sid-a', createPlan('plan-1', { title: 't', goal: '', steps: [{ text: 'a', done: false }], risks: [] }, 1));
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'agent', targetSessionPath: 'C:/work/a.jsonl' }))
        .resolves.toMatchObject({ ok: false, blocked: 'PLAN_UNCONFIRMED', mode: 'plan' });
      expect(getAgentMode('C:/work', 'sid-a')).toBe('plan');
      expect(appendCustomEntry).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))).toEqual({});
      // 只读的 Ask 不受限；取消计划后 Agent 也放行
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'ask', targetSessionPath: 'C:/work/a.jsonl' })).resolves.toEqual({ ok: true, mode: 'ask' });
      setSessionPlan('sid-a', undefined);
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'agent', targetSessionPath: 'C:/work/a.jsonl' })).resolves.toEqual({ ok: true, mode: 'agent' });
    } finally {
      __resetAgentModeForTest();
      __resetPlanStateForTest();
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

  it('truncates a linear session file in place and reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-truncate-'));
    const sessionFile = join(root, 'session.jsonl');
    const header = JSON.stringify({ type: 'session', id: 's', version: 1 });
    const user = (id: string, parentId: string | null) =>
      JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: id, timestamp: 1 } });
    const assistant = (id: string, parentId: string) =>
      JSON.stringify({ type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text: id }], timestamp: 2 } });
    await writeFile(sessionFile, [header, user('u1', null), assistant('a1', 'u1'), user('u2', 'a1')].join('\n'), 'utf8');
    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile }));
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
    });

    try {
      await expect(service.send('C:/work', 'agent_truncate_to', { entryId: 'u2', mode: 'drop-target' }))
        .resolves.toMatchObject({ ok: true });
      const remaining = (await readFile(sessionFile, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line).id);
      expect(remaining).toEqual(['s', 'u1', 'a1']);
      expect(handle.reload).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('回退到此截断后，内存里的会话按新文件重读：下一轮模型读不到被删掉的回复', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-truncate-memory-'));
    try {
      const sm = SessionManager.create('C:/work', dir);
      const u1 = sm.appendMessage({ role: 'user', content: '第一问', timestamp: 1 } as never);
      sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '第一答' }], timestamp: 2 } as never);
      const u2 = sm.appendMessage({ role: 'user', content: '第二问', timestamp: 3 } as never);
      sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '被回退掉的回复' }], timestamp: 4 } as never);
      const sessionFile = sm.getSessionFile()!;
      await writeFile(sessionFile, [sm.getHeader(), ...sm.getEntries()].map((item) => JSON.stringify(item)).join('\n') + '\n');
      const { host, handle } = fakeAgentHost(fakeHandle({ sessionManager: sm, agent: { state: { messages: sm.buildSessionProjection().messages } }, _refreshFinalizedContext: undefined }));
      handle.getState = vi.fn(() => ({ sessionFile }));
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });

      await expect(service.send('C:/work', 'agent_truncate_to', { entryId: u2, mode: 'drop-target' })).resolves.toMatchObject({ ok: true });

      const contents = (handle.session.agent.state.messages as Array<{ content: unknown }>).map((m) => JSON.stringify(m.content));
      expect(contents.join('|')).not.toContain('被回退掉的回复');
      expect(contents.join('|')).not.toContain('第二问');
      expect(contents).toHaveLength(2);
      expect(sm.getEntries().map((entry) => entry.id)).not.toContain(u2);
      expect(sm.getEntries()[0]!.id).toBe(u1);
      expect(handle.reload).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('agent_get_messages 用 buildSessionProjection 的 entry id，且该 id 可作 truncateTo 目标', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-get-messages-entry-'));
    const sessionFile = join(root, 'session.jsonl');
    const header = JSON.stringify({ type: 'session', id: 's', version: 1 });
    const user = (id: string, parentId: string | null) =>
      JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: id, timestamp: 1 } });
    const assistant = (id: string, parentId: string) =>
      JSON.stringify({ type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text: id }], timestamp: 2 } });
    await writeFile(sessionFile, [header, user('u1', null), assistant('a1', 'u1'), user('u2', 'a1')].join('\n'), 'utf8');

    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile }));
    handle.session.sessionManager = {
      getLeafId: () => 'u2',
      setSessionFile: vi.fn(),
      buildSessionProjection: () => ({
        entries: [
          { sourceEntry: { id: 'u1' }, messages: [{ role: 'user', content: 'u1', timestamp: 1 }] },
          {
            sourceEntry: { id: 'a1' },
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a1' }], timestamp: 2 }],
          },
          { sourceEntry: { id: 'u2' }, messages: [{ role: 'user', content: 'u2', timestamp: 3 }] },
        ],
        messages: [],
      }),
    };
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
    });

    try {
      const result = (await service.send('C:/work', 'agent_get_messages', {})) as {
        messages: Array<{ role: string; content: unknown; entryId?: string }>;
      };
      const users = result.messages.filter((m) => m.role === 'user');
      expect(users.map((m) => m.entryId)).toEqual(['u1', 'u2']);

      const target = users[users.length - 1]!;
      await expect(
        service.send('C:/work', 'agent_truncate_to', { entryId: target.entryId, mode: 'drop-target' }),
      ).resolves.toMatchObject({ ok: true });

      const remaining = (await readFile(sessionFile, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line).id);
      expect(remaining).toEqual(['s', 'u1', 'a1']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects branched truncate without changing session file bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-truncate-branch-'));
    const sessionFile = join(root, 'session.jsonl');
    const header = JSON.stringify({ type: 'session', id: 's', version: 1 });
    const user = (id: string, parentId: string | null) =>
      JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: id, timestamp: 1 } });
    await writeFile(sessionFile, [header, user('u1', null), user('other', null)].join('\n'), 'utf8');
    const before = await readFile(sessionFile);
    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile }));
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
    });

    try {
      await expect(service.send('C:/work', 'agent_truncate_to', { entryId: 'u1', mode: 'drop-target' }))
        .resolves.toEqual({ ok: false, reason: 'branched' });
      expect(Buffer.compare(await readFile(sessionFile), before)).toBe(0);
      expect(handle.reload).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing truncate target without changing session file bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-truncate-missing-'));
    const sessionFile = join(root, 'session.jsonl');
    const header = JSON.stringify({ type: 'session', id: 's', version: 1 });
    const user = (id: string, parentId: string | null) =>
      JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: id, timestamp: 1 } });
    await writeFile(sessionFile, [header, user('u1', null)].join('\n'), 'utf8');
    const before = await readFile(sessionFile);
    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile }));
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
    });

    try {
      await expect(service.send('C:/work', 'agent_truncate_to', { entryId: 'nope', mode: 'drop-target' }))
        .resolves.toEqual({ ok: false, reason: 'missing' });
      expect(Buffer.compare(await readFile(sessionFile), before)).toBe(0);
      expect(handle.reload).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes truncate temporary file when rename fails and leaves the session file unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-truncate-rename-'));
    const sessionFile = join(root, 'session.jsonl');
    const header = JSON.stringify({ type: 'session', id: 's', version: 1 });
    const user = (id: string, parentId: string | null) =>
      JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: id, timestamp: 1 } });
    await writeFile(sessionFile, [header, user('u1', null), user('u2', 'u1')].join('\n'), 'utf8');
    const before = await readFile(sessionFile);
    fsRenameControl.failNext = true;
    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile }));
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
    });

    try {
      await expect(service.send('C:/work', 'agent_truncate_to', { entryId: 'u2', mode: 'drop-target' }))
        .rejects.toThrow('rename blocked');
      expect(Buffer.compare(await readFile(sessionFile), before)).toBe(0);
      expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(handle.reload).not.toHaveBeenCalled();
    } finally {
      fsRenameControl.failNext = false;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries reload after truncate and reports disk truncated when reload still fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-truncate-reload-'));
    const sessionFile = join(root, 'session.jsonl');
    const header = JSON.stringify({ type: 'session', id: 's', version: 1 });
    const user = (id: string, parentId: string | null) =>
      JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: id, timestamp: 1 } });
    await writeFile(sessionFile, [header, user('u1', null), user('u2', 'u1')].join('\n'), 'utf8');
    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile }));
    handle.reload = vi.fn()
      .mockRejectedValueOnce(new Error('reload busy'))
      .mockRejectedValueOnce(new Error('reload still busy'));
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
    });

    try {
      await expect(service.send('C:/work', 'agent_truncate_to', { entryId: 'u2', mode: 'drop-target' }))
        .rejects.toThrow(/truncated on disk.*in-memory session reload failed/i);
      const remaining = (await readFile(sessionFile, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line).id);
      expect(remaining).toEqual(['s', 'u1']);
      expect(handle.reload).toHaveBeenCalledTimes(2);
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
    expect(handle.newSession).not.toHaveBeenCalled();
  });

  it('agent_prompt 活跃时切到另一会话会停靠忙 handle，而不是只改 id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-park-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    await writeFile(targetFile, JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }) + '\n');
    const busy = fakeHandle({
      sessionId: 'source-session',
      sessionFile: sourceFile,
      messages: [{ role: 'user', content: 'from-a' }],
    });
    busy.getState = vi.fn(() => ({ sessionFile: sourceFile, sessionId: 'source-session' }));
    const handles = [busy];
    let foreground = busy;
    const host = {
      open: vi.fn(async () => { foreground = busy; return busy; }),
      get: vi.fn(() => foreground),
      close: vi.fn(async () => {}),
      workspaces: vi.fn(() => ['C:/work']),
      list: vi.fn(() => handles),
      focus: vi.fn((_workspace: string, handle: typeof busy) => { foreground = handle; }),
      openAdditional: vi.fn(async () => {
        const extra = fakeHandle({
          sessionId: 'fresh',
          sessionFile: join(root, 'fresh.jsonl'),
          messages: [{ role: 'user', content: 'from-b' }],
        });
        extra.switchSession = vi.fn(async (sessionPath: string) => {
          extra.session.sessionFile = sessionPath;
          extra.session.sessionId = sessionPath === targetFile ? 'target-session' : extra.session.sessionId;
          extra.getState = vi.fn(() => ({ sessionFile: sessionPath, sessionId: extra.session.sessionId }));
          return { cancelled: false };
        });
        handles.push(extra);
        return extra;
      }),
    } as AgentHostPort;
    const service = new PiRuntimeService({
      agentDir: 'C:/a',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
      threadStore: { createThread: async (i: never) => i, createTurn: async (i: never) => i, updateTurn: async (i: never) => i } as never,
    });
    try {
      await service.openWorkspace('C:/work');
      await service.send('C:/work', 'agent_prompt', { message: 'still running' });
      await expect(service.send('C:/work', 'agent_switch_session', { sessionPath: targetFile })).resolves.toEqual({ cancelled: false });
      expect(busy.switchSession).not.toHaveBeenCalled();
      expect(host.openAdditional).toHaveBeenCalledTimes(1);
      const extra = handles[1];
      expect(extra.switchSession).toHaveBeenCalledWith(targetFile);
      await expect(service.send('C:/work', 'agent_get_messages', {})).resolves.toEqual({
        messages: [{ role: 'user', content: 'from-b' }],
      });
      await expect(service.send('C:/work', 'agent_switch_session', { sessionPath: sourceFile })).resolves.toEqual({ cancelled: false });
      expect(host.openAdditional).toHaveBeenCalledTimes(1);
      await expect(service.send('C:/work', 'agent_get_messages', {})).resolves.toEqual({
        messages: [{ role: 'user', content: 'from-a' }],
      });
      expect(service.listRunningTurns()).toEqual([
        expect.objectContaining({ workspace: 'C:/work', sessionId: 'source-session', sessionPath: sourceFile }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe('后台任务跟着会话走', () => {
    const roots: string[] = [];
    afterEach(async () => {
      for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    });

    /** 前景会话空闲（没在流式、没有进行中的回合），但它名下有后台任务。 */
    async function idleForegroundHost() {
      const root = await mkdtemp(join(tmpdir(), 'pi-session-jobs-'));
      roots.push(root);
      const ownerFile = join(root, 'owner.jsonl');
      const otherFile = join(root, 'other.jsonl');
      await writeFile(ownerFile, JSON.stringify({ type: 'session', id: 'owner-session', cwd: 'C:/work' }) + '\n');
      await writeFile(otherFile, JSON.stringify({ type: 'session', id: 'other-session', cwd: 'C:/work' }) + '\n');
      const original = fakeHandle({ sessionId: 'owner-session', sessionFile: ownerFile });
      const handles = [original];
      let foreground = original;
      const host = {
        open: vi.fn(async () => original),
        get: vi.fn(() => foreground),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => handles),
        focus: vi.fn((_workspace: string, handle: typeof original) => { foreground = handle; }),
        evict: vi.fn(async (_workspace: string, handle: typeof original) => {
          handles.splice(handles.indexOf(handle), 1);
        }),
        openAdditional: vi.fn(async () => {
          const extra = fakeHandle({ sessionId: 'fresh', sessionFile: join(root, 'fresh.jsonl') });
          handles.push(extra);
          return extra;
        }),
      } as AgentHostPort;
      return { host, original, handles, ownerFile, otherFile };
    }

    const base = { agentDir: 'C:/a', modelRuntimeHost: noopModelHost };

    it('回合已结束、名下有存活后台任务的会话，切到另一个会话时停靠，不原地替换', async () => {
      const { host, original, handles, otherFile } = await idleForegroundHost();
      const hasLiveJobs = vi.fn((sessionId: string) => sessionId === 'owner-session');
      const service = new PiRuntimeService({ ...base, agentHost: host, hasLiveJobs });
      await service.openWorkspace('C:/work');
      await service.send('C:/work', 'agent_switch_session', { sessionPath: otherFile });
      // 原地 switchSession 会触发 session_shutdown，把这个会话的后台任务一并取消。
      expect(original.switchSession).not.toHaveBeenCalled();
      expect(host.openAdditional).toHaveBeenCalledTimes(1);
      expect(handles[1].switchSession).toHaveBeenCalledWith(otherFile);
      expect(hasLiveJobs).toHaveBeenCalledWith('owner-session');
    });

    it('新建会话同样停靠有存活后台任务的会话', async () => {
      const { host, original } = await idleForegroundHost();
      const service = new PiRuntimeService({ ...base, agentHost: host, hasLiveJobs: () => true });
      await service.openWorkspace('C:/work');
      await service.send('C:/work', 'agent_new_session', {});
      expect(original.newSession).not.toHaveBeenCalled();
      expect(host.openAdditional).toHaveBeenCalledTimes(1);
    });

    it('没有存活后台任务时行为不变：空闲会话原地切换', async () => {
      const { host, original, otherFile } = await idleForegroundHost();
      const service = new PiRuntimeService({ ...base, agentHost: host, hasLiveJobs: () => false });
      await service.openWorkspace('C:/work');
      await service.send('C:/work', 'agent_switch_session', { sessionPath: otherFile });
      expect(original.switchSession).toHaveBeenCalledWith(otherFile);
      expect(host.openAdditional).not.toHaveBeenCalled();
    });

    it('宿主不支持停靠时退回原地切换，不对空闲会话报 SESSION_BUSY', async () => {
      const { host, original, otherFile } = await idleForegroundHost();
      delete (host as { openAdditional?: unknown }).openAdditional;
      const service = new PiRuntimeService({ ...base, agentHost: host, hasLiveJobs: () => true });
      await service.openWorkspace('C:/work');
      await expect(service.send('C:/work', 'agent_switch_session', { sessionPath: otherFile })).resolves.toBeDefined();
      expect(original.switchSession).toHaveBeenCalledWith(otherFile);
    });

    it('停靠的会话回合结束后，有存活后台任务就不释放，任务结束后再释放', async () => {
      const { host, original, handles, otherFile, ownerFile } = await idleForegroundHost();
      const live = { value: true };
      const service = new PiRuntimeService({
        ...base,
        agentHost: host,
        hasLiveJobs: (sessionId) => sessionId === 'owner-session' && live.value,
      });
      await service.openWorkspace('C:/work');
      await service.send('C:/work', 'agent_switch_session', { sessionPath: otherFile });
      expect(handles).toHaveLength(2);

      const turnEnd = { type: 'agent_end', messages: [] };
      const meta = { sessionId: 'owner-session', sessionPath: ownerFile };
      await service.handlePiEvent('C:/work', turnEnd, meta);
      await vi.waitFor(() => expect(original.session.waitForIdle).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(host.evict).not.toHaveBeenCalled();

      live.value = false;
      await service.handlePiEvent('C:/work', turnEnd, meta);
      await vi.waitFor(() => expect(host.evict).toHaveBeenCalledWith('C:/work', original));
    });
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

  it('暂停后取走引导队列，并把跟进按原样放回', async () => {
    const { host, handle } = fakeAgentHost();
    handle.session.clearQueue.mockReturnValue({ steering: ['第一条', '第二条'], followUp: ['稍后'] });
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await expect(service.send('C:/work', 'agent_take_steering', {})).resolves.toEqual({
      steering: ['第一条', '第二条'],
    });
    expect(handle.session.clearQueue).toHaveBeenCalledTimes(1);
    expect(handle.session.followUp).toHaveBeenCalledWith('稍后');
  });

  it('agent_cancel_steer 只撤那一条引导，其余引导和跟进排回去', async () => {
    const { host, handle } = fakeAgentHost(fakeHandle({ getSteeringMessages: () => ['第一条', '第二条'] }));
    handle.session.clearQueue.mockReturnValue({ steering: ['第一条', '第二条'], followUp: ['稍后'] });
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await expect(service.send('C:/work', 'agent_cancel_steer', { message: '第一条' })).resolves.toEqual({ cancelled: true });
    expect(handle.session.steer).toHaveBeenCalledTimes(1);
    expect(handle.session.steer).toHaveBeenCalledWith('第二条');
    expect(handle.session.followUp).toHaveBeenCalledWith('稍后');
  });

  it('refreshModelRegistry 同一模型仍在时换上新快照，不记一次模型切换', async () => {
    const stale = { provider: 'custom', id: 'claude-opus-5.5', thinkingLevelMap: { low: 'low' } };
    const live = { provider: 'custom', id: 'claude-opus-5.5', thinkingLevelMap: { off: '', low: 'low' } };
    const state = { model: stale as unknown };
    const handle = fakeHandle({
      model: stale,
      state,
      modelRuntime: { getAvailableSnapshot: () => [live] },
    });
    const { host } = fakeAgentHost(handle);
    host.workspaces = vi.fn(() => ['C:/work']);
    host.get = vi.fn(() => handle);
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await service.refreshModelRegistry();
    expect(state.model).toBe(live);
    expect(handle.session.setModel).not.toHaveBeenCalled();
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

  it('listRunningTurns 回报仍在流式的会话，空闲会话不在列', () => {
    const streaming = fakeHandle({ isStreaming: true, sessionId: 'live', sessionFile: 'C:/sessions/live.jsonl' });
    const { host } = fakeAgentHost(streaming);
    host.workspaces = vi.fn(() => ['C:/work']);
    host.get = vi.fn(() => streaming);
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    expect(service.listRunningTurns()).toEqual([
      { workspace: 'C:/work', sessionId: 'live', sessionPath: 'C:/sessions/live.jsonl' },
    ]);

    streaming.session.isStreaming = false;
    expect(service.listRunningTurns()).toEqual([]);
  });

  describe('同项目多份会话的路由', () => {
    const threadStore = () => ({
      createThread: vi.fn(async (i: never) => i),
      createTurn: vi.fn(async (i: never) => i),
      updateTurn: vi.fn(async (i: never) => i),
    });
    function twoHandles() {
      const parked = fakeHandle({ sessionId: 'parked', sessionFile: 'C:/sessions/parked.jsonl', isStreaming: true });
      const front = fakeHandle({ sessionId: 'front', sessionFile: 'C:/sessions/front.jsonl' });
      const handles = [parked, front];
      let foreground = front;
      const host = {
        open: vi.fn(async () => foreground),
        get: vi.fn(() => foreground),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [...handles]),
        focus: vi.fn((_w: string, handle: typeof front) => { foreground = handle; }),
        evict: vi.fn(async (_w: string, handle: typeof front) => {
          handles.splice(handles.indexOf(handle), 1);
          if (foreground === handle) foreground = handles[0];
        }),
      } as AgentHostPort & { evict: ReturnType<typeof vi.fn> };
      return { parked, front, handles, host, foreground: () => foreground };
    }

    it('带 targetSessionPath 的 prompt / abort 打到停在后台的 handle，前景不变', async () => {
      const { parked, front, host, foreground } = twoHandles();
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: threadStore() as never });
      await service.send('C:/work', 'agent_prompt', { message: 'to parked', targetSessionPath: 'C:\\sessions\\parked.jsonl' });
      expect(parked.prompt).toHaveBeenCalledWith('to parked', expect.anything(), 'main');
      expect(front.prompt).not.toHaveBeenCalled();
      await service.send('C:/work', 'agent_abort', { targetSessionPath: 'C:/sessions/parked.jsonl' });
      expect(parked.session.abort).toHaveBeenCalledTimes(1);
      expect(front.session.abort).not.toHaveBeenCalled();
      expect(foreground()).toBe(front);
      expect(host.focus).not.toHaveBeenCalled();
      await service.send('C:/work', 'agent_prompt', { message: 'to front' });
      expect(front.prompt).toHaveBeenCalledWith('to front', expect.anything(), 'main');
    });

    it('目标会话已不在任何 handle 上时 abort 不落到别的会话', async () => {
      const { parked, front, host } = twoHandles();
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
      await expect(service.send('C:/work', 'agent_abort', { targetSessionPath: 'C:/sessions/gone.jsonl' })).resolves.toBeUndefined();
      expect(parked.session.abort).not.toHaveBeenCalled();
      expect(front.session.abort).not.toHaveBeenCalled();
    });

    it('要快照的会话不在任何 handle 上时读它自己的文件，不拿前景顶替', async () => {
      const { front, host } = twoHandles();
      front.session.messages = [{ role: 'user', content: 'front only' }];
      const dir = await mkdtemp(join(tmpdir(), 'pi-detached-'));
      try {
        const sm = SessionManager.create('C:/work', dir);
        sm.appendMessage({ role: 'user', content: 'from disk', timestamp: 1 } as never);
        const path = sm.getSessionFile()!;
        await writeFile(path, [sm.getHeader(), ...sm.getEntries()].map((item) => JSON.stringify(item)).join('\n') + '\n');
        const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
        const result = await service.send('C:/work', 'agent_get_messages', { targetSessionPath: path }) as { messages: Array<Record<string, unknown>> };
        expect(result.messages).toEqual([expect.objectContaining({ role: 'user', content: 'from disk', entryId: expect.any(String) })]);
        await expect(service.send('C:/other', 'agent_get_messages', { targetSessionPath: path })).rejects.toThrow('SESSION_WORKSPACE_MISMATCH');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    const goalEntry = (kind: string, revision: number, payload: Record<string, unknown> = {}) => ({
      type: 'custom', customType: 'goal',
      data: { kind, goalId: 'g1', revision, at: `2026-10-18T00:00:0${revision}.000Z`, payload },
    });

    it('agent_get_goal 会话在 handle 上时读内存条目，跑着也立刻返回，不发 prompt', async () => {
      const { parked, front, host } = twoHandles();
      parked.session.sessionManager = { getEntries: () => [goalEntry('create', 1, { condition: '写完' })] };
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
      const result = await service.send('C:/work', 'agent_get_goal', { targetSessionPath: 'C:\\sessions\\parked.jsonl' }) as Record<string, any>;
      expect(result).toMatchObject({ schemaVersion: 1, sessionId: 'parked', snapshot: { goalId: 'g1', status: 'active', condition: '写完', activation: 'disarmed' } });
      expect(parked.prompt).not.toHaveBeenCalled();
      expect(front.prompt).not.toHaveBeenCalled();
      expect(host.focus).not.toHaveBeenCalled();
    });

    it('agent_get_goal 会话不在任何 handle 上时读它自己的文件（重启后首次打开）', async () => {
      const { front, host } = twoHandles();
      const dir = await mkdtemp(join(tmpdir(), 'pi-goal-detached-'));
      try {
        const sm = SessionManager.create('C:/work', dir);
        sm.appendMessage({ role: 'user', content: 'go', timestamp: 1 } as never);
        sm.appendCustomEntry('goal', goalEntry('create', 1, { condition: '重启后还在' }).data);
        const path = sm.getSessionFile()!;
        await writeFile(path, [sm.getHeader(), ...sm.getEntries()].map((item) => JSON.stringify(item)).join('\n') + '\n');
        const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
        const result = await service.send('C:/work', 'agent_get_goal', { targetSessionPath: path }) as Record<string, any>;
        expect(result).toMatchObject({ sessionId: sm.getSessionId(), snapshot: { condition: '重启后还在', status: 'active', activation: 'disarmed' } });
        expect(result.history).toHaveLength(1);
        expect(front.prompt).not.toHaveBeenCalled();
        await expect(service.send('C:/other', 'agent_get_goal', { targetSessionPath: path })).rejects.toThrow('SESSION_WORKSPACE_MISMATCH');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('agent_get_goal 没有会话路径时返回 null', async () => {
      const { host } = twoHandles();
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
      await expect(service.send('C:/work', 'agent_get_goal', {})).resolves.toBeNull();
    });

    it('respondUi 按挂起的请求 id 回到对应 handle', async () => {
      const { parked, front, host } = twoHandles();
      parked.ui = { respond: vi.fn(), hasPending: vi.fn((id: string) => id === 'req-parked') };
      front.ui = { respond: vi.fn(), hasPending: vi.fn(() => false) };
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.respondUi('C:/work', { id: 'req-parked', confirmed: true });
      expect(parked.ui.respond).toHaveBeenCalledWith('req-parked', { id: 'req-parked', confirmed: true });
      expect(front.ui.respond).not.toHaveBeenCalled();
      await service.rejectUiRequest('C:/work', undefined, 'req-parked');
      expect(parked.ui.respond).toHaveBeenLastCalledWith('req-parked', { cancelled: true });
    });

    it('后台会话回合结束且空闲后拆掉它，前景保留', async () => {
      const { parked, front, host } = twoHandles();
      parked.session.isStreaming = false;
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: threadStore() as never });
      await service.send('C:/work', 'agent_prompt', { message: 'run', targetSessionPath: 'C:/sessions/parked.jsonl' });
      await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, { sessionId: 'parked', sessionPath: 'C:/sessions/parked.jsonl', source: 'interactive' });
      expect(host.evict).toHaveBeenCalledWith('C:/work', parked);
      expect(host.evict).not.toHaveBeenCalledWith('C:/work', front);
    });

    it('后台会话还挂着询问时不拆', async () => {
      const { parked, host } = twoHandles();
      parked.session.isStreaming = false;
      parked.ui = { respond: vi.fn(), hasPending: vi.fn(() => true), hasAnyPending: vi.fn(() => true) };
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: threadStore() as never });
      await service.send('C:/work', 'agent_prompt', { message: 'run', targetSessionPath: 'C:/sessions/parked.jsonl' });
      await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, { sessionId: 'parked', source: 'interactive' });
      expect(host.evict).not.toHaveBeenCalled();
    });

    it('refreshModelRegistry 也刷新停在后台的 handle', async () => {
      const live = { provider: 'custom', id: 'm' };
      const { parked, front, host } = twoHandles();
      for (const handle of [parked, front]) {
        handle.session.model = { provider: 'custom', id: 'm' };
        handle.session.state = { model: handle.session.model };
        handle.session.modelRuntime = { getAvailableSnapshot: () => [live] };
      }
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.refreshModelRegistry();
      expect(parked.session.state.model).toBe(live);
      expect(front.session.state.model).toBe(live);
    });
  });

  describe('删会话前把它从运行时摘下', () => {
    const roots: string[] = [];
    afterEach(async () => {
      for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    });

    /** 前景 front 空闲、后台 parked 正在跑；会话文件按 SDK 的目录 / 文件名写法落盘。 */
    async function project() {
      const root = await mkdtemp(join(tmpdir(), 'pi-release-session-'));
      roots.push(root);
      const dir = join(root, '--C--work--');
      await mkdir(dir);
      const files = {
        front: join(dir, '2026-10-07T00-00-00-000Z_front.jsonl'),
        parked: join(dir, '2026-10-07T00-00-01-000Z_parked.jsonl'),
        fresh: join(dir, '2026-10-07T00-00-02-000Z_fresh.jsonl'),
      };
      await writeFile(files.front, JSON.stringify({ type: 'session', id: 'front', cwd: 'C:/work' }) + '\n');
      await writeFile(files.parked, JSON.stringify({ type: 'session', id: 'parked', cwd: 'C:/work' }) + '\n');
      const parked = fakeHandle({ sessionId: 'parked', sessionFile: files.parked, isStreaming: true });
      const front = fakeHandle({ sessionId: 'front', sessionFile: files.front });
      front.getState = vi.fn(() => ({ sessionFile: front.session.sessionFile, sessionId: front.session.sessionId }));
      // 新会话在第一条助手消息前不落盘，fresh 文件不存在。
      front.newSession = vi.fn(async () => {
        front.session.sessionFile = files.fresh;
        front.session.sessionId = 'fresh';
        front.session.isStreaming = false;
        return { cancelled: false };
      });
      const handles = [parked, front];
      let foreground = front;
      const host = {
        open: vi.fn(async () => foreground),
        get: vi.fn(() => foreground),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [...handles]),
        focus: vi.fn((_w: string, handle: typeof front) => { foreground = handle; }),
        evict: vi.fn(async (_w: string, handle: typeof front) => {
          handles.splice(handles.indexOf(handle), 1);
          if (foreground === handle) foreground = handles[0];
        }),
      } as AgentHostPort & { evict: ReturnType<typeof vi.fn> };
      const store = {
        createThread: vi.fn(async (i: never) => i),
        createTurn: vi.fn(async (i: never) => i),
        updateTurn: vi.fn(async (i: never) => i),
      };
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: store as never });
      await service.openWorkspace('C:/work');
      return { files, parked, front, host, store, service, foreground: () => foreground };
    }

    it('停在后台、正在跑的会话：拆掉它的 handle，回合记成取消，排队的跟进不再发回去', async () => {
      const { files, parked, front, host, store, service, foreground } = await project();
      await service.send('C:/work', 'agent_prompt', { message: 'run', targetSessionPath: files.parked });
      await service.send('C:/work', 'agent_prompt', { message: 'later', streamingBehavior: 'followUp', targetSessionPath: files.parked });
      expect(service.listRunningTurns()).toEqual([expect.objectContaining({ sessionId: 'parked' })]);

      // 渲染层传来的拼法（分隔符 / 大小写）可以和 SDK 的不同。
      await service.releaseSessions([files.parked.replace(/\\/g, '/').toUpperCase()]);

      expect(host.evict).toHaveBeenCalledWith('C:/work', parked);
      expect(front.newSession).not.toHaveBeenCalled();
      expect(foreground()).toBe(front);
      expect(service.listRunningTurns()).toEqual([]);
      expect(store.updateTurn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'cancelled' }));
      // 拆除时迟到的回合结束事件：排队那条不能再发回已删的会话。
      await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, { sessionId: 'parked', sessionPath: files.parked, source: 'interactive' });
      expect(parked.session.followUp).not.toHaveBeenCalled();
      expect(parked.prompt).toHaveBeenCalledTimes(1);
    });

    it('前景正在跑的会话：同一个 handle 换成新的空会话，getState 拿到新会话', async () => {
      const { files, front, host, store, service, foreground } = await project();
      front.session.isStreaming = true;
      await service.send('C:/work', 'agent_prompt', { message: 'run' });

      await service.releaseSessions([files.front]);

      expect(front.newSession).toHaveBeenCalledTimes(1);
      expect(host.evict).not.toHaveBeenCalled();
      expect(foreground()).toBe(front);
      expect(store.updateTurn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'cancelled' }));
      expect(service.listRunningTurns()).toEqual([expect.objectContaining({ sessionId: 'parked' })]);
      await expect(service.send('C:/work', 'agent_get_state', {})).resolves.toMatchObject({ sessionFile: files.fresh, sessionId: 'fresh' });
    });

    it('不在任何 handle 上的会话什么都不动', async () => {
      const { parked, front, host, service } = await project();
      await service.releaseSessions(['C:/elsewhere/gone.jsonl']);
      expect(host.evict).not.toHaveBeenCalled();
      expect(front.newSession).not.toHaveBeenCalled();
      expect(parked.session.abort).not.toHaveBeenCalled();
    });

    it('前景换新会话被扩展取消时报错，调用方不能删掉还挂在 handle 上的文件', async () => {
      const { files, front, service } = await project();
      front.newSession = vi.fn(async () => ({ cancelled: true }));
      await expect(service.releaseSessions([files.front])).rejects.toThrow('SESSION_RELEASE_CANCELLED');
    });
  });
});
