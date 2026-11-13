import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApprovalPolicy, setApprovalPolicy, __resetApprovalForTest } from '../../../extensions/_shared/approval.js';
import { getAgentMode, hasAgentMode, setAgentMode, __resetAgentModeForTest } from '../../../extensions/agent-mode/modes.js';
import { setSessionPlan, __resetPlanStateForTest } from '../../../extensions/agent-mode/planState.js';
import { createPlan } from '../../../extensions/agent-mode/plan.js';
import { PiRuntimeService, type AgentHostPort } from './piRuntimeService';
import { AgentDataService } from './agentDataService';
import { AgentDataRuntime } from '../agentData/runtime';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import {
  readRequestedPreferences,
  readSessionPreferences,
} from '../../../extensions/_shared/session-preferences.js';

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
  it.each([
    { message: '普通文字消息' },
    { message: '', images: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] },
  ])('sends $message through the real turn RPC before reaching the model handle', async (args) => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-turn-rpc-'));
    const data = new AgentDataService({ runtime: new AgentDataRuntime({ dataPath: join(dir, 'data.db') }) });
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({ agentDir: dir, agentHost: host, modelRuntimeHost: noopModelHost, threadStore: data });
    try {
      await data.start();
      await service.send(dir, 'agent_prompt', args);
      expect(handle.prompt).toHaveBeenCalledWith(args.message, expect.objectContaining({ images: args.images }), 'main');
      const [thread] = await data.listThreads();
      expect((await data.readThread(thread.id))?.turns[0].input).toBe(args.message);
    } finally {
      await data.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

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
        fast: false,
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
      // 别的会话不跟；有 target 时项目默认也不动（草稿以外的入口不再隐式改默认）。
      __resetApprovalForTest();
      expect(getApprovalPolicy('C:/work', 'sid-b')).toBe('auto');
      expect(appendCustomEntry).toHaveBeenCalledWith('session-preferences', { approval: 'readonly', revision: 1 });
      expect(appendCustomEntry).toHaveBeenCalledWith('session-preferences', { mode: 'plan', revision: 1 });
      expect(setStatus).toHaveBeenCalledWith('agent-mode', 'plan');
      const written = JSON.parse(await readFile(runtimeConfigPath, 'utf8'));
      expect(written['AGENT_MODE:c:/work']).toBeUndefined();
      expect(written['APPROVAL_POLICY:c:/work']).toBeUndefined();
    } finally {
      __resetApprovalForTest();
      __resetAgentModeForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('未确认的计划在场时手切到 Agent 或 Ultra 被取消：不动内存、不落条目、不写盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-plan-guard-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetAgentModeForTest();
    __resetPlanStateForTest();
    const sm = SessionManager.create('C:/work', root);
    sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
    await writeFile(sm.getSessionFile()!, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    const appendCustomEntry = vi.fn((type: string, data?: unknown) => sm.appendCustomEntry(type, data));
    const handle = fakeHandle();
    handle.session.sessionId = 'sid-a';
    handle.session.sessionFile = sm.getSessionFile()!;
    handle.session.sessionManager = sm;
    handle.ui = { respond: vi.fn(), context: { setStatus: vi.fn() } };
    const { host } = fakeAgentHost(handle);
    await host.open('C:/work', 'C:/work');
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, runtimeConfigPath });
    try {
      setAgentMode('plan', 'C:/work', 'sid-a');
      setSessionPlan('sid-a', createPlan('plan-1', { title: 't', goal: '', steps: [{ text: 'a', done: false }], risks: [] }, 1));
      const targetPath = sm.getSessionFile()!;
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'agent', targetSessionPath: targetPath }))
        .resolves.toMatchObject({ ok: false, blocked: 'PLAN_UNCONFIRMED', mode: 'plan' });
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'ultra', targetSessionPath: targetPath }))
        .resolves.toMatchObject({ ok: false, blocked: 'PLAN_UNCONFIRMED', mode: 'plan' });
      expect(getAgentMode('C:/work', 'sid-a')).toBe('plan');
      expect(appendCustomEntry).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))).toEqual({});
      // 只读的 Ask 不受限；取消计划后 Agent 也放行
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'ask', targetSessionPath: targetPath }))
        .resolves.toEqual({ ok: true, mode: 'ask', preferences: { mode: 'ask', revision: 1 } });
      setSessionPlan('sid-a', undefined);
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'agent', targetSessionPath: targetPath }))
        .resolves.toEqual({ ok: true, mode: 'agent', preferences: { mode: 'agent', revision: 2 } });
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'ultra', targetSessionPath: targetPath }))
        .resolves.toEqual({ ok: true, mode: 'ultra', preferences: { mode: 'ultra', revision: 3 } });
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

  it.each(['nope', 'brainstorm'])('非法或已移除模式 %s 不写内存也不落盘', async (mode) => {
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
      await expect(service.send('C:/work', 'agent_set_mode', { mode })).rejects.toThrow('INVALID_AGENT_MODE');
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

  it('agent_abort 调 session.abort，按时收口时回报已停', async () => {
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await expect(service.send('C:/work', 'agent_abort', {})).resolves.toEqual({ stopped: true, aborted: true });
    expect(handle.session.abort).toHaveBeenCalledTimes(1);
  });

  it('abort 卡在 SDK 的 waitForIdle 上时，到点仍回报已停并标明 timeout', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => {});
      const { host, handle } = fakeAgentHost(fakeHandle({ abort: vi.fn(() => never), isStreaming: true }));
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
      const pending = service.send('C:/work', 'agent_abort', {});
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual({
        stopped: true, aborted: true, reason: 'timeout', isStreaming: true,
      });
      expect(handle.session.abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('agent_settled 到得比 agent_end 晚、或 agent_end 丢了，也把回合登记收掉', async () => {
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued' })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const { host, handle } = fakeAgentHost(fakeHandle({ sessionId: 'session-a', isStreaming: true }));
    host.get = vi.fn(() => handle);
    const service = new PiRuntimeService({
      agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as never,
    });
    await service.send('C:/work', 'agent_prompt', { message: 'hello', sessionId: 'session-a' });
    expect(service.listRunningTurns()).toEqual([expect.objectContaining({ sessionId: 'session-a' })]);

    // 只来 agent_settled（agent_end 丢了）：必须收口，否则 listRunningTurns 永远把这份会话算在跑。
    handle.session.isStreaming = false;
    await service.handlePiEvent('C:/work', { type: 'agent_settled', aborted: false }, 'session-a');
    expect(service.listRunningTurns()).toEqual([]);
    expect(thread.updateTurn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'completed' }));

    // 之后再来的 agent_end 不能重复收口。
    const calls = thread.updateTurn.mock.calls.length;
    await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, 'session-a');
    expect(thread.updateTurn.mock.calls.length).toBe(calls);
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

  it('refreshModelRegistry 在供应商消失后保留旧模型，不自动切到仍可用的第一项', async () => {
    const fallback = { provider: 'openai', id: 'gpt' };
    const gone = { provider: 'gone', id: 'flash' };
    const handle = fakeHandle({
      model: gone,
      modelRuntime: { getAvailableSnapshot: () => [fallback] },
    });
    const { host } = fakeAgentHost(handle);
    host.workspaces = vi.fn(() => ['C:/work']);
    host.get = vi.fn(() => handle);
    const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await expect(service.refreshModelRegistry()).resolves.toEqual({ refreshed: ['C:/work'], failed: [] });
    // 模型目录没了不能静默改写用户选择（T15）：由 unavailable / prompt guard 让用户重选。
    expect(handle.session.setModel).not.toHaveBeenCalled();
    expect(handle.session.model).toBe(gone);
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

    it('目标会话已不在任何 handle 上时 abort 不落到别的会话，并回一个「已停」回执', async () => {
      const { parked, front, host } = twoHandles();
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
      // 没有承载它的 handle 就没有在跑的回合：回执要说已停，界面才能把运行态收掉，
      // 而不是继续显示停止按钮、点了没反应。
      await expect(service.send('C:/work', 'agent_abort', { targetSessionPath: 'C:/sessions/gone.jsonl' }))
        .resolves.toEqual({ stopped: true, aborted: false });
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

describe('会话偏好（session-preferences）', () => {
  /** 两个会话各在一个 handle 上：a 停后台、b 在前景。 */
  function twoSessions() {
    const a = fakeHandle({ sessionId: 'sid-a', sessionFile: 'C:/work/a.jsonl' });
    const b = fakeHandle({ sessionId: 'sid-b', sessionFile: 'C:/work/b.jsonl' });
    const handles = [a, b];
    let foreground = b;
    const host = {
      open: vi.fn(async () => foreground),
      get: vi.fn(() => foreground),
      close: vi.fn(async () => {}),
      workspaces: vi.fn(() => ['C:/work']),
      list: vi.fn(() => [...handles]),
      focus: vi.fn((_w: string, handle: typeof a) => { foreground = handle; }),
      evict: vi.fn(async (_w: string, handle: typeof a) => {
        handles.splice(handles.indexOf(handle), 1);
        if (foreground === handle) foreground = handles[0];
      }),
    } as AgentHostPort & { evict: ReturnType<typeof vi.fn> };
    return { a, b, handles, host, foreground: () => foreground };
  }

  /** 真实 SessionManager：条目与 jsonl 都是真的，偏好条目按 SDK 的 appendCustomEntry 落盘。 */
  async function realManager(dir: string, cwd = 'C:/work') {
    const sm = SessionManager.create(cwd, dir);
    // SDK 只在有对话后才会建 jsonl：先放一条用户消息，让后续 appendCustomEntry 真的写文件。
    sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
    const file = sm.getSessionFile()!;
    const write = () => writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join('\n') + '\n');
    await write();
    return { sm, file, write };
  }

  it('agent_get_state 顶层带有效 model/thinkingLevel，preferences 带请求值与 sessionPath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-state-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', {
        model: { provider: 'anthropic', id: 'claude' },
        thinkingLevel: 'high',
        mode: 'ask',
        approval: 'readonly',
        revision: 2,
      });
      await write();
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const handle = fakeHandle({
        sessionId: 'sid-a',
        sessionFile: file,
        model: live,
        thinkingLevel: 'medium',
        sessionManager: sm,
        modelRuntime: { getAvailableSnapshot: () => [live] },
      });
      handle.getState = vi.fn(() => ({
        model: live,
        thinkingLevel: 'medium',
        sessionFile: file,
        sessionId: 'sid-a',
      }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const state = await service.send('C:/work', 'agent_get_state', {}) as Record<string, unknown>;
      expect(state).toMatchObject({
        model: expect.objectContaining({ provider: 'anthropic', id: 'claude' }),
        thinkingLevel: 'medium',
        sessionPath: file,
        sessionFile: file,
      });
      expect(state.preferences).toEqual({
        model: { provider: 'anthropic', id: 'claude' },
        thinkingLevel: 'high',
        mode: 'ask',
        approval: 'readonly',
        revision: 2,
      });
      expect(state.unavailable).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('agent_set_thinking_level 带 targetSessionPath 只按该会话合并字段，返回新快照与 path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-set-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', revision: 1 });
      await write();
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const a = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: live, sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      a.session.setThinkingLevel = vi.fn((level: string) => { a.session.thinkingLevel = level; });
      a.getState = vi.fn(() => ({ model: live, thinkingLevel: a.session.thinkingLevel, sessionFile: file, sessionId: 'sid-a' }));
      const b = fakeHandle({ sessionId: 'sid-b', sessionFile: 'C:/work/b.jsonl' });
      const handles = [a, b];
      let foreground = b;
      const host = {
        open: vi.fn(async () => foreground),
        get: vi.fn(() => foreground),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [...handles]),
        focus: vi.fn((_w: string, handle: typeof a) => { foreground = handle; }),
      } as AgentHostPort;
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      foreground = b;
      const result = await service.send('C:/work', 'agent_set_thinking_level', {
        level: 'low',
        targetSessionPath: file,
      }) as Record<string, unknown>;
      expect(result).toMatchObject({
        ok: true,
        sessionId: 'sid-a',
        sessionPath: file,
        applied: ['thinkingLevel'],
        unavailable: [],
        // 回执顺带有效值（与 getState 同形），UI 保存后不必再读一次
        thinkingLevel: 'low',
        model: expect.objectContaining({ provider: 'anthropic', id: 'claude' }),
      });
      expect(result.preferences).toEqual({ thinkingLevel: 'low', revision: 2 });
      expect(a.session.setThinkingLevel).toHaveBeenCalledWith('low');
      expect(b.session.setThinkingLevel).not.toHaveBeenCalled();
      expect(foreground).toBe(b);
      expect(host.focus).not.toHaveBeenCalled();
      const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      const canonical = lines.filter((e) => e.customType === 'session-preferences').at(-1);
      expect(canonical.data).toEqual({ thinkingLevel: 'low', revision: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('不可用模型：保留请求值、不改 live、prompt 被阻止，getState 报 unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-missing-model-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', {
        model: { provider: 'gone', id: 'flash' },
        thinkingLevel: 'high',
        revision: 1,
      });
      await write();
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const handle = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: live, sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'high', sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const state = await service.send('C:/work', 'agent_get_state', {}) as Record<string, unknown>;
      expect(state.unavailable).toContain('model');
      expect((state.preferences as { model?: unknown }).model).toEqual({ provider: 'gone', id: 'flash' });
      await expect(service.send('C:/work', 'agent_prompt', { message: 'hi' }))
        .rejects.toThrow('SESSION_MODEL_UNAVAILABLE');
      expect(handle.prompt).not.toHaveBeenCalled();
      // 用户明确点了新模型：换成有效的，随后可发送
      handle.session.setModel = vi.fn(async () => {});
      const { host: host2 } = fakeAgentHost(handle);
      const service2 = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host2, modelRuntimeHost: noopModelHost });
      await service2.send('C:/work', 'agent_set_model', { provider: 'anthropic', modelId: 'claude' });
      await expect(service2.send('C:/work', 'agent_prompt', { message: 'hi' })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('换模型不改写请求的 thinking 偏好（SDK 钳制只影响有效值）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-model-clamp-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', {
        model: { provider: 'anthropic', id: 'thinking-model' },
        thinkingLevel: 'high',
        revision: 1,
      });
      await write();
      const reasoning = { provider: 'anthropic', id: 'thinking-model', reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } };
      const plain = { provider: 'anthropic', id: 'plain-model', reasoning: false };
      const handle = fakeHandle({
        sessionId: 'sid-a',
        sessionFile: file,
        model: reasoning,
        sessionManager: sm,
        modelRuntime: { getAvailableSnapshot: () => [reasoning, plain] },
      });
      // 真 SDK 的 setThinkingLevel 会按模型能力钳制：非推理模型只能是 off。
      handle.session.setThinkingLevel = vi.fn((level: string) => {
        const clamped = level === 'high' && !handle.session.model.reasoning ? 'off' : level;
        handle.session.thinkingLevel = clamped;
        (sm as unknown as { appendThinkingLevelChange?: (level: string) => void }).appendThinkingLevelChange?.(clamped);
      });
      handle.session.setModel = vi.fn(async (model: typeof reasoning) => {
        handle.session.model = model;
        // 真 SDK：换模型时按能力重选档位并追一条 thinking_level_change（非推理 → off）
        handle.session.setThinkingLevel(model.reasoning ? 'high' : 'off');
      });
      handle.getState = vi.fn(() => ({
        model: handle.session.model,
        thinkingLevel: handle.session.thinkingLevel,
        sessionFile: file,
        sessionId: 'sid-a',
      }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const result = await service.send('C:/work', 'agent_set_model', { provider: 'anthropic', modelId: 'plain-model' }) as Record<string, unknown>;
      // high 在非推理模型上放不下：只应用 model，thinkingLevel 报 unavailable（请求值仍保留）。
      // 这不是失败：effective 值是 off，回执里带回去给 UI，不触发回滚。
      expect(result).toMatchObject({
        ok: true,
        applied: ['model'],
        unavailable: ['thinkingLevel'],
        thinkingLevel: 'off',
      });
      expect(result.preferences).toEqual({
        model: { provider: 'anthropic', id: 'plain-model' },
        thinkingLevel: 'high',
        revision: 2,
      });
      expect(handle.session.thinkingLevel).toBe('off');
      const state = await service.send('C:/work', 'agent_get_state', {}) as Record<string, unknown>;
      expect(state.thinkingLevel).toBe('off');
      expect((state.preferences as { thinkingLevel?: string }).thinkingLevel).toBe('high');
      expect(state.unavailable).toContain('thinkingLevel');
      // 只有档位被钳制：仍允许发送，用的是顶层 effective 值 off。
      await expect(service.send('C:/work', 'agent_prompt', { message: 'still allowed' })).resolves.toBeUndefined();
      expect(handle.prompt).toHaveBeenCalledWith('still allowed', { images: undefined }, 'main');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('模式/审查带 target 只钉该会话，不写项目默认', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-scope-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetAgentModeForTest();
    __resetApprovalForTest();
    try {
      const { sm, file } = await realManager(root);
      const a = fakeHandle({ sessionId: 'sid-a', sessionFile: file, sessionManager: sm });
      a.ui = { respond: vi.fn(), context: { setStatus: vi.fn() } };
      a.getState = vi.fn(() => ({ sessionFile: file, sessionId: 'sid-a' }));
      const b = fakeHandle({ sessionId: 'sid-b', sessionFile: 'C:/work/b.jsonl' });
      const handles = [a, b];
      const host = {
        open: vi.fn(async () => b),
        get: vi.fn(() => b),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [...handles]),
      } as AgentHostPort;
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, runtimeConfigPath });
      await service.send('C:/work', 'agent_set_mode', { mode: 'plan', targetSessionPath: file });
      await service.send('C:/work', 'agent_set_approval', { level: 'readonly', targetSessionPath: file });
      expect(getAgentMode('C:/work', 'sid-a')).toBe('plan');
      expect(getApprovalPolicy('C:/work', 'sid-a')).toBe('readonly');
      expect(getAgentMode('C:/work', 'sid-b')).toBe('agent');
      expect(getApprovalPolicy('C:/work', 'sid-b')).toBe('auto');
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))['AGENT_MODE:c:/work']).toBeUndefined();
      const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      // 每次写的是“合并后的完整快照”，所以第二条也带着已有的 mode。
      expect(lines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([
        { mode: 'plan', revision: 1 },
        { mode: 'plan', approval: 'readonly', revision: 2 },
      ]);
    } finally {
      __resetAgentModeForTest();
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('目标会话已释放：写入拒绝 SESSION_NOT_LOADED，不落到前景也不改默认', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-detached-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', { thinkingLevel: 'low', revision: 1 });
      await write();
      const front = fakeHandle({ sessionId: 'sid-front', sessionFile: 'C:/work/front.jsonl' });
      const { host } = fakeAgentHost(front);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await expect(service.send('C:/work', 'agent_set_thinking_level', { level: 'high', targetSessionPath: file }))
        .rejects.toThrow('SESSION_NOT_LOADED');
      expect(front.session.setThinkingLevel).not.toHaveBeenCalled();
      await expect(service.send('C:/work', 'agent_set_model', { provider: 'x', modelId: 'y', targetSessionPath: file }))
        .rejects.toThrow('SESSION_NOT_LOADED');
      expect(front.session.setModel).not.toHaveBeenCalled();
      const state = await service.send('C:/work', 'agent_get_state', { targetSessionPath: file }) as Record<string, unknown>;
      expect(state).toMatchObject({ sessionPath: file, detached: true });
      expect((state.preferences as { thinkingLevel?: string }).thinkingLevel).toBe('low');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('日志写失败：拒绝，且 live 还原成写之前（apply-then-rollback）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-persist-fail-'));
    try {
      const { sm, file } = await realManager(root);
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const handle = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: live, thinkingLevel: 'medium', sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handle.session.setThinkingLevel = vi.fn();
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'medium', sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      sm.appendCustomEntry = () => { throw new Error('disk full'); };
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await expect(service.send('C:/work', 'agent_set_thinking_level', { level: 'high' }))
        .rejects.toThrow('PREFERENCES_PERSIST_FAILED');
      // canonical 先写：写盘失败时 live 根本还没动，不会留下 high
      expect(handle.session.thinkingLevel).toBe('medium');
      expect(handle.session.setThinkingLevel).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('同一会话的写入按收到顺序串行合并，revision 递增', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-serial-'));
    try {
      const { sm, file } = await realManager(root);
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const handle = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: live, sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handle.session.setThinkingLevel = vi.fn();
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: handle.session.thinkingLevel, sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      host.list = vi.fn(() => [handle]);

      // 第一条写卡的 setThinkingLevel 上：第二条在这期间入队，必须排在它后面而不是并发读旧快照。
      let releaseFirst: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let calls = 0;
      handle.session.setThinkingLevel = vi.fn(async () => {
        calls += 1;
        if (calls === 1) await firstGate;
      });

      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const first = service.send('C:/work', 'agent_set_thinking_level', { level: 'high', targetSessionPath: file });
      // 等第一条真正进到执行中（已读过快照、卡在 setThinkingLevel）
      await vi.waitFor(() => expect(calls).toBe(1));
      const second = service.send('C:/work', 'agent_set_approval', { level: 'full', targetSessionPath: file });
      releaseFirst();

      const [firstAck, secondAck] = await Promise.all([first, second]) as Array<Record<string, unknown>>;
      expect(firstAck.preferences).toEqual({ thinkingLevel: 'high', revision: 1 });
      expect(secondAck.preferences).toEqual({ thinkingLevel: 'high', approval: 'full', revision: 2 });
      const lines = (await readFile(file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(lines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([
        { thinkingLevel: 'high', revision: 1 },
        { thinkingLevel: 'high', approval: 'full', revision: 2 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('新会话按 initialPreferences 初始化（含新建会话的路径回执）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-new-'));
    try {
      const { sm, file } = await realManager(root);
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const handle = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: live, sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handle.session.setModel = vi.fn(async () => {});
      handle.session.setThinkingLevel = vi.fn();
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'medium', sessionFile: file, sessionId: 'sid-a' }));
      let currentFile = file;
      let currentManager = sm;
      handle.newSession = vi.fn(async () => {
        const fresh = SessionManager.create('C:/work', root);
        fresh.appendMessage({ role: 'user', content: 'fresh', timestamp: 1 } as never);
        await writeFile(fresh.getSessionFile()!, [fresh.getHeader(), ...fresh.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
        currentFile = fresh.getSessionFile()!;
        currentManager = fresh;
        handle.session.sessionId = fresh.getSessionId();
        handle.session.sessionFile = currentFile;
        handle.session.sessionManager = fresh;
        return { cancelled: false };
      });
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'medium', sessionFile: currentFile, sessionId: handle.session.sessionId }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const result = await service.send('C:/work', 'agent_new_session', {
        initialPreferences: { model: { provider: 'anthropic', id: 'claude' }, thinkingLevel: 'high', mode: 'ask', approval: 'readonly' },
      }) as Record<string, unknown>;
      expect(result).toMatchObject({ cancelled: false, sessionPath: currentFile, sessionFile: currentFile });
      expect(result.preferences).toEqual({
        model: { provider: 'anthropic', id: 'claude' },
        thinkingLevel: 'high',
        mode: 'ask',
        approval: 'readonly',
        revision: 1,
      });
      expect(handle.session.setModel).toHaveBeenCalled();
      expect(handle.session.setThinkingLevel).toHaveBeenCalledWith('high');
      const newSessionId = handle.session.sessionId;
      expect(getAgentMode('C:/work', newSessionId)).toBe('ask');
      expect(getApprovalPolicy('C:/work', newSessionId)).toBe('readonly');
    } finally {
      __resetAgentModeForTest();
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clone 后的新会话继承截至锚点的偏好快照，之后两边独立', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-fork-'));
    try {
      const source = await realManager(root);
      source.sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', mode: 'plan', revision: 1 });
      await source.write();
      const target = await realManager(root);
      const sourceFile = source.file;
      const targetFile = target.file;
      // 模拟 SDK createBranchedSession：把 source 的分支条目复制到新文件
      await writeFile(targetFile, [target.sm.getHeader(), ...source.sm.getEntries()].map((e) => JSON.stringify(e)).join('\n') + '\n');
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const handle = fakeHandle({ sessionId: 'sid-source', sessionFile: sourceFile, model: live, sessionManager: source.sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handle.fork = vi.fn(async () => {
        const branched = SessionManager.open(targetFile);
        handle.session.sessionId = branched.getSessionId();
        handle.session.sessionFile = targetFile;
        handle.session.sessionManager = branched;
        return { cancelled: false };
      });
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'high', sessionFile: targetFile, sessionId: handle.session.sessionId }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.send('C:/work', 'agent_clone', {});
      const state = await service.send('C:/work', 'agent_get_state', {}) as Record<string, unknown>;
      expect(state.preferences).toEqual({ thinkingLevel: 'high', mode: 'plan', revision: 1 });
      await service.send('C:/work', 'agent_set_thinking_level', { level: 'low' });
      const sourceLines = (await readFile(sourceFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(sourceLines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([
        { thinkingLevel: 'high', mode: 'plan', revision: 1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('agent_get_session_defaults / agent_set_session_defaults 读写 workspace 默认，不动现有会话', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-defaults-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetAgentModeForTest();
    __resetApprovalForTest();
    try {
      const handle = fakeHandle({ sessionId: 'sid-a', sessionFile: 'C:/work/a.jsonl' });
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({
        agentDir: 'C:/agent',
        agentHost: host,
        modelRuntimeHost: noopModelHost,
        runtimeConfigPath,
        resolveWorkspace: async () => 'D:/Resolved/',
      });
      await expect(service.send('C:/work', 'agent_get_session_defaults', {})).resolves.toEqual({
        mode: 'agent',
        approval: 'auto',
        revision: 0,
      });
      const set = await service.send('C:/work', 'agent_set_session_defaults', {
        preferences: {
          model: { provider: 'anthropic', id: 'claude' },
          thinkingLevel: 'high',
          mode: 'plan',
          approval: 'workspace',
        },
      }) as Record<string, unknown>;
      expect(set).toMatchObject({
        model: { provider: 'anthropic', id: 'claude' },
        thinkingLevel: 'high',
        mode: 'plan',
        approval: 'workspace',
        revision: 0,
      });
      const written = JSON.parse(await readFile(runtimeConfigPath, 'utf8'));
      expect(written['AGENT_MODE:c:/work']).toBe('plan');
      expect(written['APPROVAL_POLICY:c:/work']).toBe('workspace');
      expect(written['AGENT_MODE:d:/resolved']).toBe('plan');
      expect(JSON.parse(written['SESSION_DEFAULTS:c:/work'])).toEqual({
        model: { provider: 'anthropic', id: 'claude' },
        thinkingLevel: 'high',
      });
      // 已打开的会话没被写入任何自己值（项目默认改了，会话不跟）
      expect(hasAgentMode('C:/work', 'sid-a')).toBe(false);
      expect(getAgentMode('C:/work')).toBe('plan');
      await expect(service.send('C:/work', 'agent_get_session_defaults', {})).resolves.toMatchObject({
        mode: 'plan',
        approval: 'workspace',
      });
    } finally {
      __resetAgentModeForTest();
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('旧 Brainstorm 项目默认回退 Agent，保留模型/思考/审查/Fast', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-retired-mode-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, JSON.stringify({
      'AGENT_MODE:c:/work': 'brainstorm',
      'APPROVAL_POLICY:c:/work': 'ask',
      'SESSION_DEFAULTS:c:/work': JSON.stringify({ model: { provider: 'relay', id: 'model' }, thinkingLevel: 'high', fastMode: true }),
    }));
    __resetAgentModeForTest();
    setAgentMode('ask', 'C:/work');
    const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, runtimeConfigPath });
    try {
      await expect(service.send('C:/work', 'agent_get_session_defaults', {})).resolves.toEqual({
        mode: 'agent', approval: 'ask', model: { provider: 'relay', id: 'model' }, thinkingLevel: 'high', fastMode: true, revision: 0,
      });
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))['AGENT_MODE:c:/work']).toBe('brainstorm');
    } finally {
      __resetAgentModeForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('无 target 的模式/审查写入仍改项目默认（草稿兼容路径）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-legacy-default-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetAgentModeForTest();
    __resetApprovalForTest();
    try {
      const service = new PiRuntimeService({
        agentDir: 'C:/agent',
        agentHost: fakeAgentHost().host,
        modelRuntimeHost: noopModelHost,
        runtimeConfigPath,
      });
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'plan' })).resolves.toEqual({ ok: true, mode: 'plan' });
      expect(getAgentMode('C:/work', 'anything')).toBe('plan');
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))['AGENT_MODE:c:/work']).toBe('plan');
    } finally {
      __resetAgentModeForTest();
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('同一窗口切会话：两个会话各自的偏好互不覆盖（A→B→A）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-ab-'));
    try {
      const a = await realManager(root);
      a.sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', mode: 'ask', revision: 1 });
      await a.write();
      const b = await realManager(root);
      b.sm.appendCustomEntry('session-preferences', { thinkingLevel: 'low', approval: 'full', revision: 1 });
      await b.write();
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const handleA = fakeHandle({ sessionId: a.sm.getSessionId(), sessionFile: a.file, model: live, sessionManager: a.sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      const handleB = fakeHandle({ sessionId: b.sm.getSessionId(), sessionFile: b.file, model: live, sessionManager: b.sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handleA.getState = vi.fn(() => ({ model: live, thinkingLevel: 'high', sessionFile: a.file, sessionId: handleA.session.sessionId }));
      handleB.getState = vi.fn(() => ({ model: live, thinkingLevel: 'low', sessionFile: b.file, sessionId: handleB.session.sessionId }));
      const handles = [handleA, handleB];
      const host = {
        open: vi.fn(async () => handleA),
        get: vi.fn(() => handleA),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [...handles]),
        focus: vi.fn(() => {}),
      } as AgentHostPort;
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const readA = await service.send('C:/work', 'agent_get_state', { targetSessionPath: a.file }) as Record<string, unknown>;
      const readB = await service.send('C:/work', 'agent_get_state', { targetSessionPath: b.file }) as Record<string, unknown>;
      const readA2 = await service.send('C:/work', 'agent_get_state', { targetSessionPath: a.file }) as Record<string, unknown>;
      expect(readA.preferences).toEqual({ thinkingLevel: 'high', mode: 'ask', revision: 1 });
      expect(readB.preferences).toEqual({ thinkingLevel: 'low', approval: 'full', revision: 1 });
      expect(readA2.preferences).toEqual(readA.preferences);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：目标已释放的另一视图仍可编辑（T11）', () => {
  async function realManager(dir: string) {
    const sm = SessionManager.create('C:/work', dir);
    sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
    const file = sm.getSessionFile()!;
    const write = () => writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    await write();
    return { sm, file, write };
  }

  it('idle A 被 evict 后：窗口 A 改偏好时另开非前景 handle，B 仍在前景且不被改', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-t11-'));
    try {
      const a = await realManager(root);
      a.sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', revision: 1 });
      await a.write();
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      // 窗口 B 的前景 handle，停在 b.jsonl
      const bFile = join(root, 'b.jsonl');
      await writeFile(bFile, JSON.stringify({ type: 'session', id: 'sid-b', cwd: 'C:/work' }) + String.fromCharCode(10));
      const front = fakeHandle({ sessionId: 'sid-b', sessionFile: bFile });
      const handles = [front];
      let foreground = front;
      let openedForA: ReturnType<typeof fakeHandle> | undefined;
      const host = {
        open: vi.fn(async () => foreground),
        get: vi.fn(() => foreground),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [...handles]),
        focus: vi.fn((_w: string, handle: typeof front) => { foreground = handle; }),
        // 为 A 重建非前景 handle：switchSession 到 a.jsonl，sessionManager 直接换成 A 的真实 manager
        openAdditional: vi.fn(async () => {
          const extra = fakeHandle({ sessionId: 'sid-a', sessionFile: a.file, model: live, sessionManager: a.sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
          extra.session.setThinkingLevel = vi.fn();
          extra.getState = vi.fn(() => ({ model: live, thinkingLevel: extra.session.thinkingLevel, sessionFile: a.file, sessionId: 'sid-a' }));
          extra.switchSession = vi.fn(async (sessionPath: string) => {
            extra.session.sessionFile = sessionPath;
            extra.session.sessionId = 'sid-a';
            return { cancelled: false };
          });
          openedForA = extra;
          handles.push(extra);
          return extra;
        }),
        evict: vi.fn(async (_w: string, handle: typeof front) => { handles.splice(handles.indexOf(handle), 1); }),
      } as AgentHostPort & { openAdditional: ReturnType<typeof vi.fn> };
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
      const result = await service.send('C:/work', 'agent_set_thinking_level', {
        level: 'low',
        targetSessionPath: a.file,
      }) as Record<string, unknown>;
      expect(result).toMatchObject({ ok: true, sessionId: 'sid-a', sessionPath: a.file, applied: ['thinkingLevel'] });
      expect(host.openAdditional).toHaveBeenCalledTimes(1);
      expect(host.focus).not.toHaveBeenCalled();
      expect(foreground).toBe(front);
      expect(front.session.setThinkingLevel).not.toHaveBeenCalled();
      expect(openedForA?.session.setThinkingLevel).toHaveBeenCalledWith('low');
      // 恢复出来的 handle 留在池里：第二次写直接命中，不再另开
      await service.send('C:/work', 'agent_set_thinking_level', { level: 'medium', targetSessionPath: a.file });
      expect(host.openAdditional).toHaveBeenCalledTimes(1);
      const lines = (await readFile(a.file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(lines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([
        { thinkingLevel: 'high', revision: 1 },
        { thinkingLevel: 'low', revision: 2 },
        { thinkingLevel: 'medium', revision: 3 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('目标文件已删除：即使 host 支持 openAdditional 也拒绝，绝不复活', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-deleted-'));
    try {
      const gone = join(root, 'gone.jsonl');
      const front = fakeHandle({ sessionId: 'sid-front', sessionFile: join(root, 'front.jsonl') });
      const host = {
        open: vi.fn(async () => front),
        get: vi.fn(() => front),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [front]),
        openAdditional: vi.fn(async () => { throw new Error('should not open'); }),
      } as AgentHostPort & { openAdditional: ReturnType<typeof vi.fn> };
      const service = new PiRuntimeService({ agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
      await expect(service.send('C:/work', 'agent_set_thinking_level', { level: 'low', targetSessionPath: gone }))
        .rejects.toThrow('SESSION_NOT_LOADED');
      expect(host.openAdditional).not.toHaveBeenCalled();
      expect(front.session.setThinkingLevel).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：cycle 命令也写 canonical', () => {
  async function realManager(dir: string) {
    const sm = SessionManager.create('C:/work', dir);
    sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
    const file = sm.getSessionFile()!;
    const write = () => writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    await write();
    return { sm, file, write };
  }

  it('agent_cycle_thinking_level 后 canonical 跟上有效值，冷恢复不会回旧档', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-cycle-thinking-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', revision: 1 });
      await write();
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const handle = fakeHandle({
        sessionId: 'sid-a', sessionFile: file, model: live, thinkingLevel: 'high',
        sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] },
      });
      handle.session.cycleThinkingLevel = vi.fn(() => { handle.session.thinkingLevel = 'low'; return 'low'; });
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: handle.session.thinkingLevel, sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await expect(service.send('C:/work', 'agent_cycle_thinking_level', {}))
        .resolves.toMatchObject({ level: 'low', preferences: { thinkingLevel: 'low', revision: 2 } });
      const lines = (await readFile(file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(lines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([
        { thinkingLevel: 'high', revision: 1 },
        { thinkingLevel: 'low', revision: 2 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('agent_cycle_model 后 canonical 记下新模型，并把 SDK 钳制后的档位一并写成请求值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-cycle-model-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', { model: { provider: 'anthropic', id: 'think' }, thinkingLevel: 'high', revision: 1 });
      await write();
      const think = { provider: 'anthropic', id: 'think', reasoning: true };
      const plain = { provider: 'anthropic', id: 'plain', reasoning: false };
      const handle = fakeHandle({
        sessionId: 'sid-a', sessionFile: file, model: think, thinkingLevel: 'high',
        sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [think, plain] },
      });
      handle.session.cycleModel = vi.fn(async () => {
        handle.session.model = plain;
        handle.session.thinkingLevel = 'off';
        return { model: plain, thinkingLevel: 'off' };
      });
      handle.getState = vi.fn(() => ({ model: handle.session.model, thinkingLevel: handle.session.thinkingLevel, sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const result = await service.send('C:/work', 'agent_cycle_model', {}) as Record<string, unknown>;
      // 回执是快照后的模型字段 + 新的 preferences
      expect(result).toMatchObject({
        id: 'plain',
        provider: 'anthropic',
        preferences: { model: { provider: 'anthropic', id: 'plain' }, revision: 2 },
      });
      // 换模型本身没有显式给 thinkingLevel：已保存的请求值 high 原样保留（不是被 effective off 覆写）
      expect((result.preferences as { thinkingLevel?: string }).thinkingLevel).toBe('high');
      expect(result).toMatchObject({ unavailable: ['thinkingLevel'] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('agent_cycle_thinking_level 带 targetSessionPath 只改那份会话', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-cycle-target-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', revision: 1 });
      await write();
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const a = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: live, thinkingLevel: 'high', sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      a.session.cycleThinkingLevel = vi.fn(() => { a.session.thinkingLevel = 'low'; return 'low'; });
      a.getState = vi.fn(() => ({ model: live, thinkingLevel: a.session.thinkingLevel, sessionFile: file, sessionId: 'sid-a' }));
      const b = fakeHandle({ sessionId: 'sid-b', sessionFile: join(root, 'b.jsonl'), thinkingLevel: 'medium' });
      const handles = [a, b];
      const host = {
        open: vi.fn(async () => b),
        get: vi.fn(() => b),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [...handles]),
      } as AgentHostPort;
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const result = await service.send('C:/work', 'agent_cycle_thinking_level', { targetSessionPath: file }) as Record<string, unknown>;
      expect(result).toMatchObject({ level: 'low', sessionPath: file, preferences: { thinkingLevel: 'low', revision: 2 } });
      expect(a.session.cycleThinkingLevel).toHaveBeenCalledTimes(1);
      expect(b.session.cycleThinkingLevel).not.toHaveBeenCalled();
      // 目标在前景以外的 handle 上时不切前景
      expect(host.focus).toBeUndefined();
      expect(b.session.thinkingLevel).toBe('medium');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：保存的模型重新出现在目录后要对齐 effective', () => {
  async function realManager(dir: string) {
    const sm = SessionManager.create('C:/work', dir);
    sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
    const file = sm.getSessionFile()!;
    await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    return { sm, file };
  }

  it('live 是 SDK fallback M2、保存请求 M1，目录刷新回 M1 后 prompt 前先切回 M1 并重套 thinking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-reconcile-'));
    try {
      const { sm, file } = await realManager(root);
      const savingM1 = { provider: 'relay', id: 'm1', reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } };
      const fallbackM2 = { provider: 'relay', id: 'm2', reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } };
      sm.appendCustomEntry('session-preferences', {
        model: { provider: 'relay', id: 'm1' },
        thinkingLevel: 'high',
        revision: 1,
      });
      // 模型目录当前只有 M2 → SDK 冷恢复落到 fallback
      let catalog = [fallbackM2];
      const handle = fakeHandle({
        sessionId: 'sid-a', sessionFile: file, model: fallbackM2, thinkingLevel: 'high',
        sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => catalog },
      });
      handle.session.setModel = vi.fn(async (model: typeof fallbackM2) => { handle.session.model = model; });
      handle.session.setThinkingLevel = vi.fn();
      handle.getState = vi.fn(() => ({ model: handle.session.model, thinkingLevel: handle.session.thinkingLevel, sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      // 之前缺失时不允许发
      await expect(service.send('C:/work', 'agent_prompt', { message: 'blocked' })).rejects.toThrow('SESSION_MODEL_UNAVAILABLE');
      // M1 回到目录：刷新后应把 effective 切回请求的 M1，并重套请求档位
      catalog = [savingM1, fallbackM2];
      await expect(service.send('C:/work', 'agent_prompt', { message: 'go' })).resolves.toBeUndefined();
      expect(handle.session.setModel).toHaveBeenCalledWith(savingM1);
      expect(handle.session.setThinkingLevel).toHaveBeenCalledWith('high');
      expect(handle.session.model.id).toBe('m1');
      expect(handle.prompt).toHaveBeenCalledWith('go', { images: undefined }, 'main');
      // 不改 canonical 请求值
      const lines = (await readFile(file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(lines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([
        { model: { provider: 'relay', id: 'm1' }, thinkingLevel: 'high', revision: 1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('live 已与保存请求一致时不重复 setModel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-reconcile-same-'));
    try {
      const { sm, file } = await realManager(root);
      const m1 = { provider: 'relay', id: 'm1', reasoning: true };
      sm.appendCustomEntry('session-preferences', { model: { provider: 'relay', id: 'm1' }, revision: 1 });
      const handle = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: m1, sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [m1] } });
      handle.session.setModel = vi.fn();
      handle.getState = vi.fn(() => ({ model: m1, thinkingLevel: 'medium', sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      await expect(service.send('C:/work', 'agent_prompt', { message: 'go' })).resolves.toBeUndefined();
      expect(handle.session.setModel).not.toHaveBeenCalled();
      expect(handle.session.setThinkingLevel).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：模型切换后总按请求值重算 effective 档位', () => {
  async function realManager(dir: string) {
    const sm = SessionManager.create('C:/work', dir);
    sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
    const file = sm.getSessionFile()!;
    await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    return { sm, file };
  }

  it('patch 只有 model 时，也用已保存的 thinkingLevel 重算 effective（不是让 SDK 自选）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-reapply-'));
    try {
      const { sm, file } = await realManager(root);
      const reasoning = { provider: 'relay', id: 'think', reasoning: true, thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' } };
      sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', revision: 1 });
      const handle = fakeHandle({
        sessionId: 'sid-a', sessionFile: file, model: { provider: 'relay', id: 'other', reasoning: true },
        sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [reasoning] },
      });
      // SDK 的 setModel 会按自己的默认重选档位（medium），这里如实模拟
      handle.session.setModel = vi.fn(async (model: typeof reasoning) => {
        handle.session.model = model;
        handle.session.thinkingLevel = 'medium';
      });
      handle.session.setThinkingLevel = vi.fn((level: string) => { handle.session.thinkingLevel = level; });
      handle.getState = vi.fn(() => ({ model: handle.session.model, thinkingLevel: handle.session.thinkingLevel, sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.send('C:/work', 'agent_set_model', { provider: 'relay', modelId: 'think' });
      // 请求值 high 必须被重新套上
      expect(handle.session.setThinkingLevel).toHaveBeenCalledWith('high');
      expect(handle.session.thinkingLevel).toBe('high');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('请求的 thinkingLevel 当前模型放不下：仍交给 SDK 钳制（effective 变 off），不是留着旧的 high', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-clamp-call-'));
    try {
      const { sm, file } = await realManager(root);
      const plain = { provider: 'relay', id: 'plain', reasoning: false };
      // 带上 model，才算得出“这个模型的档位列表放不下 high”
      sm.appendCustomEntry('session-preferences', {
        model: { provider: 'relay', id: 'plain' },
        thinkingLevel: 'high',
        revision: 1,
      });
      const handle = fakeHandle({
        sessionId: 'sid-a', sessionFile: file, model: plain, thinkingLevel: 'high',
        sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [plain] },
      });
      // 真 SDK：setThinkingLevel('high') 在非推理模型上变成 off
      handle.session.setThinkingLevel = vi.fn((level: string) => {
        handle.session.thinkingLevel = level === 'high' ? 'off' : level;
      });
      handle.getState = vi.fn(() => ({ model: plain, thinkingLevel: handle.session.thinkingLevel, sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const ack = await service.send('C:/work', 'agent_set_thinking_level', { level: 'high' }) as Record<string, unknown>;
      // 请求值保留 high，但必须真的调用 SDK 去钳制
      expect(ack.unavailable).toContain('thinkingLevel');
      expect(ack.thinkingLevel).toBe('off');
      expect(handle.session.setThinkingLevel).toHaveBeenCalledWith('high');
      expect(handle.session.thinkingLevel).toBe('off');
      expect((ack.preferences as { thinkingLevel?: string }).thinkingLevel).toBe('high');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('setModel 抛错（auth 预校验）时不留下一份磁盘新请求值（canonical 与 live 一致）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-setmodel-fail-'));
    try {
      const { sm, file } = await realManager(root);
      const failing = { provider: 'relay', id: 'noauth', reasoning: true };
      const handle = fakeHandle({
        sessionId: 'sid-a', sessionFile: file, model: { provider: 'relay', id: 'ok', reasoning: true },
        sessionManager: sm,
        // 真 SDK 的 ModelRuntime.checkAuth 会在 setModel 之前失败
        modelRuntime: {
          getAvailableSnapshot: () => [failing],
          checkAuth: async (provider: string) => (provider === 'relay' ? undefined : { ok: true }),
        },
      });
      handle.session.setModel = vi.fn(async () => { throw new Error('No API key for relay/noauth'); });
      handle.getState = vi.fn(() => ({ model: handle.session.model, thinkingLevel: 'high', sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await expect(service.send('C:/work', 'agent_set_model', { provider: 'relay', modelId: 'noauth' }))
        .rejects.toThrow(/No API key/);
      // auth 预校验在写 canonical 之前就拦下：磁盘上不要留下新请求值
      const lines = (await readFile(file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(lines.filter((e) => e.customType === 'session-preferences')).toEqual([]);
      expect(handle.session.setModel).not.toHaveBeenCalled();
      expect(handle.session.model.id).not.toBe('noauth');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：排队期间 handle 换过会话，写入不能串到别的会话', () => {
  async function seed(dir: string, text: string) {
    const sm = SessionManager.create('C:/work', dir);
    sm.appendMessage({ role: 'user', content: text, timestamp: 1 } as never);
    const file = sm.getSessionFile()!;
    await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    return { sm, file };
  }

  function deferred() {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('排队期间同一 handle 换成 B：A 的 patch 绝不写进 B（host 无法重载 A 时明确拒绝）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-race-'));
    try {
      const a = await seed(root, 'a');
      const b = await seed(root, 'b');
      const live = { provider: 'relay', id: 'm', reasoning: true };
      const handle = fakeHandle({ sessionId: a.sm.getSessionId(), sessionFile: a.file, model: live, sessionManager: a.sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      const gate = deferred();
      handle.session.setThinkingLevel = vi.fn(async () => { await gate.promise; });

      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const first = service.send('C:/work', 'agent_set_thinking_level', { level: 'high', targetSessionPath: a.file });

      // 排队期间换会话：同一个 handle 变成 B
      handle.session.sessionId = b.sm.getSessionId();
      handle.session.sessionFile = b.file;
      handle.session.sessionManager = b.sm;

      const second = service.send('C:/work', 'agent_set_thinking_level', { level: 'low', targetSessionPath: a.file });
      gate.resolve();
      await first.catch(() => {});
      await second.catch(() => {});

      // B 的 jsonl 里不能出现 A 的偏好条目
      const bLines = (await readFile(b.file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(bLines.filter((e) => e.customType === 'session-preferences')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('host 支持 openAdditional 时，排队期间换走后按原 path 在非前景 handle 上写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-race-reload-'));
    try {
      const a = await seed(root, 'a');
      const b = await seed(root, 'b');
      const live = { provider: 'relay', id: 'm', reasoning: true };
      const handle = fakeHandle({ sessionId: a.sm.getSessionId(), sessionFile: a.file, model: live, sessionManager: a.sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      const gate = deferred();
      handle.session.setThinkingLevel = vi.fn(async () => { await gate.promise; });

      const reopened: Array<ReturnType<typeof fakeHandle>> = [];
      const handles = [handle];
      const host = {
        open: vi.fn(async () => handle),
        get: vi.fn(() => handle),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [...handles]),
        focus: vi.fn(),
        openAdditional: vi.fn(async () => {
          const extra = fakeHandle({ sessionId: a.sm.getSessionId(), sessionFile: a.file, model: live, sessionManager: a.sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
          extra.session.setThinkingLevel = vi.fn();
          reopened.push(extra);
          handles.push(extra);
          return extra;
        }),
        evict: vi.fn(async () => {}),
      } as AgentHostPort & { openAdditional: ReturnType<typeof vi.fn> };
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const first = service.send('C:/work', 'agent_set_thinking_level', { level: 'high', targetSessionPath: a.file });

      handle.session.sessionId = b.sm.getSessionId();
      handle.session.sessionFile = b.file;
      handle.session.sessionManager = b.sm;

      gate.resolve();
      await first;
      // 第一条已经为 A 建了非前景 handle：第二条直接命中它，不再另开
      await service.send('C:/work', 'agent_set_thinking_level', { level: 'low', targetSessionPath: a.file });

      // 两条都落到 A 自己的文件；B 干净
      const aLines = (await readFile(a.file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(aLines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([
        { thinkingLevel: 'high', revision: 1 },
        { thinkingLevel: 'low', revision: 2 },
      ]);
      const bLines = (await readFile(b.file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(bLines.filter((e) => e.customType === 'session-preferences')).toEqual([]);
      expect(host.openAdditional).toHaveBeenCalledTimes(1);
      expect(host.focus).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('agent_get_session_defaults 只读项目默认，不继承当前会话', () => {
  it('无 runtime 文件时：ALS 里会话的 mode/approval 与项目默认不同，默认仍回退项目默认', async () => {
    const { runInWorkspace } = await import('../../../extensions/_shared/workspace-context.js');
    __resetAgentModeForTest();
    __resetApprovalForTest();
    try {
      const service = new PiRuntimeService({
        agentDir: 'C:/agent',
        agentHost: fakeAgentHost().host,
        modelRuntimeHost: noopModelHost,
      });
      const ctx = {
        origin: 'main' as const,
        workspace: 'C:/work',
        cwd: 'C:/work',
        config: {},
        sessionId: () => 'sid-a',
      };
      const defaults = await runInWorkspace(ctx, async () => {
        // 当前会话自己钉了 plan / readonly，项目默认没被改过
        setAgentMode('plan', 'C:/work', 'sid-a');
        setApprovalPolicy('readonly', 'C:/work', 'sid-a');
        expect(getAgentMode('C:/work')).toBe('plan');
        return service.send('C:/work', 'agent_get_session_defaults', {});
      });
      // 新对话不能继承“最近会话”的选择
      expect(defaults).toMatchObject({ mode: 'agent', approval: 'auto', revision: 0 });
    } finally {
      __resetAgentModeForTest();
      __resetApprovalForTest();
    }
  });
});

describe('会话偏好：不可用模型时不误改当前会话的档位', () => {
  it('请求一个目录里没有的模型时，请求值保留但不套档位、不改 live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-missing-model-noop-'));
    try {
      const sm = SessionManager.create('C:/work', root);
      sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
      const file = sm.getSessionFile()!;
      await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
      const live = { provider: 'relay', id: 'live', reasoning: true };
      const handle = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: live, thinkingLevel: 'medium', sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handle.session.setModel = vi.fn();
      handle.session.setThinkingLevel = vi.fn();
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'medium', sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const ack = await service.send('C:/work', 'agent_set_model', { provider: 'relay', modelId: 'missing' }) as Record<string, unknown>;
      expect(ack).toMatchObject({ ok: true, applied: [], unavailable: ['model'] });
      expect((ack.preferences as { model?: unknown }).model).toEqual({ provider: 'relay', id: 'missing' });
      expect(handle.session.setModel).not.toHaveBeenCalled();
      expect(handle.session.setThinkingLevel).not.toHaveBeenCalled();
      expect(handle.session.model.id).toBe('live');
      await expect(service.send('C:/work', 'agent_prompt', { message: 'x' })).rejects.toThrow('SESSION_MODEL_UNAVAILABLE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：每次成功提交都推完整快照给 UI（T12 跨视图同步）', () => {
  it('setter 成功后经 handle.ui.context.setStatus 推 session-preferences（完整快照 JSON）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-status-'));
    try {
      const sm = SessionManager.create('C:/work', root);
      sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
      const file = sm.getSessionFile()!;
      await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const setStatus = vi.fn();
      const handle = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: live, sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handle.session.setThinkingLevel = vi.fn();
      handle.ui = { respond: vi.fn(), context: { setStatus } };
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'high', sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      await service.send('C:/work', 'agent_set_thinking_level', { level: 'high', targetSessionPath: file });
      await service.send('C:/work', 'agent_set_approval', { level: 'readonly', targetSessionPath: file });

      const pushed = setStatus.mock.calls.filter(([key]) => key === 'session-preferences');
      expect(pushed).toHaveLength(2);
      expect(JSON.parse(pushed[0][1])).toEqual({ thinkingLevel: 'high', revision: 1 });
      expect(JSON.parse(pushed[1][1])).toEqual({ thinkingLevel: 'high', approval: 'readonly', revision: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('写盘失败不推 status（不能广播没持久化的值）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-status-fail-'));
    try {
      const sm = SessionManager.create('C:/work', root);
      sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
      const file = sm.getSessionFile()!;
      await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
      const live = { provider: 'anthropic', id: 'claude', reasoning: true };
      const setStatus = vi.fn();
      const handle = fakeHandle({ sessionId: 'sid-a', sessionFile: file, model: live, thinkingLevel: 'medium', sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handle.session.setThinkingLevel = vi.fn((level: string) => { handle.session.thinkingLevel = level; });
      handle.ui = { respond: vi.fn(), context: { setStatus } };
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: handle.session.thinkingLevel, sessionFile: file, sessionId: 'sid-a' }));
      const { host } = fakeAgentHost(handle);
      sm.appendCustomEntry = () => { throw new Error('disk full'); };
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      await expect(service.send('C:/work', 'agent_set_thinking_level', { level: 'high', targetSessionPath: file }))
        .rejects.toThrow('PREFERENCES_PERSIST_FAILED');
      expect(setStatus.mock.calls.filter(([key]) => key === 'session-preferences')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：目标已释放时 prompt 也不能用不可用模型', () => {
  async function seedFile(dir: string, model: { provider: string; id: string }) {
    const sm = SessionManager.create('C:/work', dir);
    sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
    sm.appendCustomEntry('session-preferences', { model, revision: 1 });
    const file = sm.getSessionFile()!;
    await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    return file;
  }

  it('请求的模型不在目录：即使目标已释放也在切过去之前拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-detached-gate-'));
    try {
      const gone = await seedFile(root, { provider: 'relay', id: 'gone' });
      const live = { provider: 'relay', id: 'live', reasoning: true };
      const front = fakeHandle({ sessionId: 'sid-front', sessionFile: join(root, 'front.jsonl'), model: live, modelRuntime: { getAvailableSnapshot: () => [live] } });
      const { host } = fakeAgentHost(front);
      const switchSpy = vi.fn(async () => ({ cancelled: false }));
      front.switchSession = switchSpy;
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      await expect(service.send('C:/work', 'agent_prompt', { message: 'x', targetSessionPath: gone }))
        .rejects.toThrow('SESSION_MODEL_UNAVAILABLE');
      // 没有先把前景切过去再失败
      expect(switchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：setModel 在途时切换会话', () => {
  async function seed(dir: string, text: string) {
    const sm = SessionManager.create('C:/work', dir);
    sm.appendMessage({ role: 'user', content: text, timestamp: 1 } as never);
    const file = sm.getSessionFile()!;
    await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    return { sm, file };
  }

  it('setModel 的 auth 在途时同 handle 换到 B：A 的 canonical / thinking 不能写进 B', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-inflight-switch-'));
    try {
      const a = await seed(root, 'a');
      const b = await seed(root, 'b');
      const live = { provider: 'relay', id: 'm1', reasoning: true };
      const other = { provider: 'relay', id: 'm2', reasoning: true };
      const handle = fakeHandle({
        sessionId: a.sm.getSessionId(), sessionFile: a.file, model: live,
        sessionManager: a.sm, modelRuntime: { getAvailableSnapshot: () => [live, other] },
      });
      let releaseAuth: () => void = () => {};
      const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
      let setModelStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => { setModelStarted = resolve; });
      handle.session.setModel = vi.fn(async (model: typeof live) => {
        setModelStarted();
        await authGate;
        handle.session.model = model;
      });
      handle.session.setThinkingLevel = vi.fn((level: string) => { handle.session.thinkingLevel = level; });
      handle.getState = vi.fn(() => ({ model: handle.session.model, thinkingLevel: handle.session.thinkingLevel, sessionFile: handle.session.sessionFile, sessionId: handle.session.sessionId }));

      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');

      const setModel = service.send('C:/work', 'agent_set_model', { provider: 'relay', modelId: 'm2', targetSessionPath: a.file });
      await started;

      // 同 handle 被换成 B（idle switch / new 的等价替换）：整份 session 对象换掉
      const bSession = {
        sessionId: b.sm.getSessionId(),
        sessionFile: b.file,
        sessionManager: b.sm,
        model: live,
        thinkingLevel: 'medium',
        isStreaming: false,
        setModel: vi.fn(async () => {}),
        setThinkingLevel: vi.fn(),
      };
      handle.session = bSession as never;
      releaseAuth();
      await setModel.catch(() => {});

      // B 的日志里不能出现 m2 或 A 的 thinking 记录
      const bLines = (await readFile(b.file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(bLines.filter((e) => e.customType === 'session-preferences')).toEqual([]);
      // A 的 live / 状态也没串到 B 的 session 对象上
      expect(bSession.setModel).not.toHaveBeenCalled();
      expect(bSession.setThinkingLevel).not.toHaveBeenCalled();
      // A 的日志里要么写了 m2（成功），要么没写；但绝不能写到 B
      const aLines = (await readFile(a.file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(aLines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([
        { model: { provider: 'relay', id: 'm2' }, revision: 1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('agent_new_session 要等在途偏好写结束才替换会话', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-inflight-new-'));
    try {
      const a = await seed(root, 'a');
      const fresh = await seed(root, 'fresh');
      const live = { provider: 'relay', id: 'm1', reasoning: true };
      const other = { provider: 'relay', id: 'm2', reasoning: true };
      const handle = fakeHandle({
        sessionId: a.sm.getSessionId(), sessionFile: a.file, model: live,
        sessionManager: a.sm, modelRuntime: { getAvailableSnapshot: () => [live, other] },
      });
      let releaseAuth: () => void = () => {};
      const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
      let started: () => void = () => {};
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      handle.session.setModel = vi.fn(async (model: typeof live) => {
        started();
        await authGate;
        handle.session.model = model;
      });
      handle.session.setThinkingLevel = vi.fn();
      handle.newSession = vi.fn(async () => {
        // 真 SDK 的 newSession 会整份替换 runtime.session
        handle.session = {
          sessionId: fresh.sm.getSessionId(),
          sessionFile: fresh.file,
          sessionManager: fresh.sm,
          model: live,
          thinkingLevel: 'medium',
          isStreaming: false,
          setModel: vi.fn(async () => {}),
          setThinkingLevel: vi.fn(),
        } as never;
        return { cancelled: false };
      });
      handle.getState = vi.fn(() => ({ model: handle.session.model, thinkingLevel: handle.session.thinkingLevel, sessionFile: handle.session.sessionFile, sessionId: handle.session.sessionId }));

      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');

      const setModel = service.send('C:/work', 'agent_set_model', { provider: 'relay', modelId: 'm2', targetSessionPath: a.file });
      await startedPromise;
      const newSession = service.send('C:/work', 'agent_new_session', {});
      // newSession 不能在还有在途偏好写时就替换会话
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handle.newSession).not.toHaveBeenCalled();
      releaseAuth();
      await setModel;
      await newSession;
      expect(handle.newSession).toHaveBeenCalledTimes(1);
      const aLines = (await readFile(a.file, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(aLines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([
        { model: { provider: 'relay', id: 'm2' }, revision: 1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：真实 SessionManager 的落盘失败（内存已被 _appendEntry 改过）', () => {
  it('_persist 抛错时把内存条目也回滚，getState 与重新打开都仍是旧请求值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-persist-memory-'));
    try {
      const sm = SessionManager.create('C:/work', root);
      sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
      sm.appendCustomEntry('session-preferences', { thinkingLevel: 'medium', revision: 1 });
      const file = sm.getSessionFile()!;
      await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
      const beforeBytes = await readFile(file, 'utf8');

      const live = { provider: 'relay', id: 'think', reasoning: true };
      const handle = fakeHandle({ sessionId: sm.getSessionId(), sessionFile: file, model: live, thinkingLevel: 'medium', sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
      handle.session.setThinkingLevel = vi.fn((level: string) => { handle.session.thinkingLevel = level; });
      handle.ui = { respond: vi.fn(), context: { setStatus: vi.fn() } };
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');

      // 只卡住真正的落盘：_appendEntry 的内存副作用照常发生（与 SDK 一致）。
      const persistCalls: number[] = [];
      const originalPersist = (sm as unknown as { _persist: (entry: unknown) => void })._persist.bind(sm);
      (sm as unknown as { _persist: (entry: unknown) => void })._persist = () => {
        persistCalls.push(1);
        throw new Error('disk full');
      };

      await expect(service.send('C:/work', 'agent_set_thinking_level', { level: 'high', targetSessionPath: file }))
        .rejects.toThrow('PREFERENCES_PERSIST_FAILED');
      expect(persistCalls.length).toBeGreaterThan(0);
      // 内存里不能留着失败的那条
      expect(readSessionPreferences(sm.getEntries() as never).thinkingLevel).toBe('medium');
      const state = await service.send('C:/work', 'agent_get_state', { targetSessionPath: file }) as Record<string, unknown>;
      expect((state.preferences as { thinkingLevel?: string }).thinkingLevel).toBe('medium');
      // 恢复真实落盘后重新打开：磁盘上也还是旧值
      (sm as unknown as { _persist: (entry: unknown) => void })._persist = originalPersist as never;
      expect(await readFile(file, 'utf8')).toBe(beforeBytes);
      const reopened = SessionManager.open(file);
      expect(readSessionPreferences(reopened.getEntries() as never).thinkingLevel).toBe('medium');
      // live 也回滚
      expect(handle.session.thinkingLevel).toBe('medium');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：模型 patch 落盘失败（原生 model_change 已写）', () => {
  it('setModel 写入原生 model_change 之后 canonical 落盘失败：老 canonical 全字段仍主导，且不丢并发消息', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-model-persist-fail-'));
    try {
      const sm = SessionManager.create('C:/work', root);
      sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
      sm.appendCustomEntry('session-preferences', {
        model: { provider: 'relay', id: 'think' },
        thinkingLevel: 'high',
        mode: 'plan',
        approval: 'readonly',
        revision: 4,
      });
      const file = sm.getSessionFile()!;
      await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
      const beforeBytes = await readFile(file, 'utf8');

      const think = { provider: 'relay', id: 'think', reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } };
      const other = { provider: 'relay', id: 'other', reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } };
      const handle = fakeHandle({ sessionId: sm.getSessionId(), sessionFile: file, model: think, thinkingLevel: 'high', sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [think, other] } });
      // 真 SDK：setModel 先 appendModelChange 再 setThinkingLevel（各写一条原生条目）
      handle.session.setModel = vi.fn(async (model: typeof think) => {
        sm.appendModelChange(model.provider, model.id);
        handle.session.model = model;
        sm.appendThinkingLevelChange('high');
        handle.session.thinkingLevel = 'high';
      });
      handle.session.setThinkingLevel = vi.fn((level: string) => {
        handle.session.thinkingLevel = level;
        sm.appendThinkingLevelChange(level);
      });
      handle.ui = { respond: vi.fn(), context: { setStatus: vi.fn() } };
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');

      // canonical 落盘失败（原生条目已经在内存里）
      // 只让 canonical 条目的落盘失败：原生 model_change / thinking_level_change 照常写盘，
      // 这正是最容易出现“原生已写、canonical 没写”的组合。
      const internals = sm as unknown as { _persist: (entry: { customType?: string }) => void };
      const originalPersist = internals._persist.bind(sm);
      internals._persist = (entry) => {
        if (entry?.customType === 'session-preferences') throw new Error('disk full');
        originalPersist(entry);
      };
      await expect(service.send('C:/work', 'agent_set_model', { provider: 'relay', modelId: 'other' }))
        .rejects.toThrow('PREFERENCES_PERSIST_FAILED');
      internals._persist = originalPersist as never;

      // 老 canonical 的四个字段必须还在
      const state = await service.send('C:/work', 'agent_get_state', { targetSessionPath: file }) as Record<string, unknown>;
      expect(state.preferences).toMatchObject({
        model: { provider: 'relay', id: 'think' },
        thinkingLevel: 'high',
        mode: 'plan',
        approval: 'readonly',
        revision: 4,
      });
      // 磁盘字节未变（老 canonical 四条原生条目都在，没丢并发消息）
      expect(await readFile(file, 'utf8')).toBe(beforeBytes);
      const reopened = SessionManager.open(file);
      expect(readRequestedPreferences(reopened.getEntries() as never)).toMatchObject({
        model: { provider: 'relay', id: 'think' },
        thinkingLevel: 'high',
        revision: 4,
      });
      // live 也回到旧模型
      expect(handle.session.model.id).toBe('think');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：扩展直接调 pi.setModel 不被冷恢复回旧值', () => {
  it('canonical 之后原生 model_change 是显式选择：冷恢复按它起来', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-extension-setmodel-'));
    try {
      const sm = SessionManager.create('C:/work', root);
      sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
      sm.appendCustomEntry('session-preferences', { model: { provider: 'relay', id: 'think' }, revision: 1 });
      // 扩展用 pi.setModel 直接换模型：只写原生 model_change
      sm.appendModelChange('relay', 'other');
      const file = sm.getSessionFile()!;
      await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
      expect(readSessionPreferences(sm.getEntries() as never).model).toEqual({ provider: 'relay', id: 'other' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：并发打开同一目标只建一个 handle', () => {
  it('两条并发写同一个已释放目标时 openAdditional 只调用一次', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-open-once-'));
    try {
      const sm = SessionManager.create('C:/work', root);
      sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
      const file = sm.getSessionFile()!;
      await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
      const live = { provider: 'relay', id: 'm', reasoning: true };
      const front = fakeHandle({ sessionId: 'sid-front', sessionFile: join(root, 'front.jsonl') });
      let opens = 0;
      const host = {
        open: vi.fn(async () => front),
        get: vi.fn(() => front),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [front]),
        openAdditional: vi.fn(async () => {
          opens += 1;
          const extra = fakeHandle({ sessionId: sm.getSessionId(), sessionFile: file, model: live, sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] } });
          extra.session.setThinkingLevel = vi.fn();
          extra.switchSession = vi.fn(async () => ({ cancelled: false }));
          // 打开要慢一点，制造真正的并发窗口
          await new Promise((resolve) => setTimeout(resolve, 10));
          return extra;
        }),
      } as AgentHostPort & { openAdditional: ReturnType<typeof vi.fn> };
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      const results = await Promise.all([
        service.send('C:/work', 'agent_set_thinking_level', { level: 'low', targetSessionPath: file }),
        service.send('C:/work', 'agent_set_model', { provider: 'relay', modelId: 'm', targetSessionPath: file }),
      ]);
      expect(opens).toBe(1);
      expect(host.openAdditional).toHaveBeenCalledTimes(1);
      expect(results.every((r) => (r as Record<string, unknown>).ok === true)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('目录移除模型：refreshModelRegistry 不得静默改用第一项（T15）', () => {
  it('当前模型从目录消失后刷新：preferences.model 仍是原模型，live 保留旧引用并可提示重选', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-refresh-keep-'));
    try {
      const sm = SessionManager.create('C:/work', root);
      sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
      sm.appendCustomEntry('session-preferences', {
        model: { provider: 'relay', id: 'gone' },
        thinkingLevel: 'high',
        revision: 3,
      });
      const file = sm.getSessionFile()!;
      await writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));

      const gone = { provider: 'relay', id: 'gone', reasoning: true };
      const fallback = { provider: 'relay', id: 'other', reasoning: true };
      // 模型目录里已经没有 gone 了
      let catalog = [fallback];
      const handle = fakeHandle({ sessionId: sm.getSessionId(), sessionFile: file, model: gone, thinkingLevel: 'high', sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => catalog } });
      handle.session.setModel = vi.fn(async (model: typeof fallback) => {
        sm.appendModelChange(model.provider, model.id);
        handle.session.model = model;
      });
      handle.getState = vi.fn(() => ({ model: handle.session.model, thinkingLevel: handle.session.thinkingLevel, sessionFile: file, sessionId: sm.getSessionId() }));
      const { host } = fakeAgentHost(handle);
      host.workspaces = vi.fn(() => ['C:/work']);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');

      await service.refreshModelRegistry();

      // 不能自动切到目录第一项
      expect(handle.session.setModel).not.toHaveBeenCalled();
      expect(handle.session.model.id).toBe('gone');
      // 请求值仍是原模型（不是被“目录第一项”顶替）
      const state = await service.send('C:/work', 'agent_get_state', {}) as Record<string, unknown>;
      expect((state.preferences as { model?: unknown }).model).toEqual({ provider: 'relay', id: 'gone' });
      expect(state.unavailable).toContain('model');
      // 目录里没有它：prompt 被拦住，要求用户重选
      await expect(service.send('C:/work', 'agent_prompt', { message: 'x' })).rejects.toThrow('SESSION_MODEL_UNAVAILABLE');

      // 模型回到目录后恢复正常
      catalog = [gone, fallback];
      await service.refreshModelRegistry();
      expect(handle.session.model.id).toBe('gone');
      await expect(service.send('C:/work', 'agent_prompt', { message: 'ok' })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('会话偏好：Fast 作为第五项按会话独立保存', () => {
  async function realManager(dir: string) {
    const sm = SessionManager.create('C:/work', dir);
    sm.appendMessage({ role: 'user', content: 'seed', timestamp: 1 } as never);
    const file = sm.getSessionFile()!;
    const write = () => writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    await write();
    return { sm, file, write };
  }

  function liveModel() {
    return { provider: 'anthropic', id: 'claude', reasoning: true };
  }

  function fastHandle(file: string, sm: SessionManager, live = liveModel()) {
    const handle = fakeHandle({
      sessionId: sm.getSessionId(), sessionFile: file, model: live, thinkingLevel: 'medium',
      sessionManager: sm, modelRuntime: { getAvailableSnapshot: () => [live] },
    });
    handle.session.setThinkingLevel = vi.fn();
    handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'medium', sessionFile: file, sessionId: sm.getSessionId() }));
    return handle;
  }

  function canonicalOf(file: string) {
    return readFile(file, 'utf8').then((raw) => raw.trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l))
      .filter((e) => e.customType === 'session-preferences').map((e) => e.data));
  }

  it('agent_set_fast_mode 带 targetSessionPath 落 canonical、applied 含 fastMode、广播完整快照', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-fast-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', mode: 'ask', approval: 'readonly', revision: 1 });
      await write();
      const handle = fastHandle(file, sm);
      const setStatus = vi.fn();
      handle.ui = { respond: vi.fn(), context: { setStatus } };
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      const on = await service.send('C:/work', 'agent_set_fast_mode', { enabled: true, targetSessionPath: file }) as Record<string, unknown>;
      expect(on).toMatchObject({ ok: true, sessionPath: file, applied: ['fastMode'], unavailable: [] });
      expect(on.preferences).toEqual({ thinkingLevel: 'high', mode: 'ask', approval: 'readonly', fastMode: true, revision: 2 });
      const off = await service.send('C:/work', 'agent_set_fast_mode', { enabled: false, targetSessionPath: file }) as Record<string, unknown>;
      expect(off).toMatchObject({ ok: true, applied: ['fastMode'], unavailable: [] });
      expect(off.preferences).toEqual({ thinkingLevel: 'high', mode: 'ask', approval: 'readonly', fastMode: false, revision: 3 });
      // false 真的写进日志（不能用 truthy 判断丢字段）
      expect(await canonicalOf(file)).toEqual([
        { thinkingLevel: 'high', mode: 'ask', approval: 'readonly', revision: 1 },
        { thinkingLevel: 'high', mode: 'ask', approval: 'readonly', fastMode: true, revision: 2 },
        { thinkingLevel: 'high', mode: 'ask', approval: 'readonly', fastMode: false, revision: 3 },
      ]);
      // Fast 没有额外的 live setter：不动模型 / 档位
      expect(handle.session.setModel).not.toHaveBeenCalled();
      expect(handle.session.setThinkingLevel).not.toHaveBeenCalled();
      const pushed = setStatus.mock.calls.filter(([key]) => key === 'session-preferences').map(([, value]) => JSON.parse(value as string));
      expect(pushed).toEqual([
        { thinkingLevel: 'high', mode: 'ask', approval: 'readonly', fastMode: true, revision: 2 },
        { thinkingLevel: 'high', mode: 'ask', approval: 'readonly', fastMode: false, revision: 3 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enabled 不是 boolean（含缺省、字符串）就拒绝，不落条目也不广播', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-fast-invalid-'));
    try {
      const { sm, file, write } = await realManager(root);
      sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', revision: 1 });
      await write();
      const handle = fastHandle(file, sm);
      const setStatus = vi.fn();
      handle.ui = { respond: vi.fn(), context: { setStatus } };
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      await expect(service.send('C:/work', 'agent_set_fast_mode', { enabled: 'true', targetSessionPath: file }))
        .rejects.toThrow('INVALID_FAST_MODE');
      await expect(service.send('C:/work', 'agent_set_fast_mode', { targetSessionPath: file }))
        .rejects.toThrow('INVALID_FAST_MODE');
      expect(await canonicalOf(file)).toEqual([{ thinkingLevel: 'high', revision: 1 }]);
      expect(setStatus.mock.calls.filter(([key]) => key === 'session-preferences')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('同项目 A 开 B 关：按各自原 path 读写互不影响，missing 保持缺省', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-fast-ab-'));
    try {
      const a = await realManager(root);
      const b = await realManager(root);
      const live = liveModel();
      const handleA = fastHandle(a.file, a.sm, live);
      const handleB = fastHandle(b.file, b.sm, live);
      const handles = [handleA, handleB];
      const host = {
        open: vi.fn(async () => handleA),
        get: vi.fn(() => handleA),
        close: vi.fn(async () => {}),
        workspaces: vi.fn(() => ['C:/work']),
        list: vi.fn(() => [...handles]),
        focus: vi.fn(() => {}),
      } as AgentHostPort;
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.send('C:/work', 'agent_set_fast_mode', { enabled: true, targetSessionPath: a.file });
      await service.send('C:/work', 'agent_set_fast_mode', { enabled: false, targetSessionPath: b.file });
      const stateA = await service.send('C:/work', 'agent_get_state', { targetSessionPath: a.file }) as Record<string, unknown>;
      const stateB = await service.send('C:/work', 'agent_get_state', { targetSessionPath: b.file }) as Record<string, unknown>;
      expect((stateA.preferences as { fastMode?: boolean }).fastMode).toBe(true);
      expect((stateB.preferences as { fastMode?: boolean }).fastMode).toBe(false);
      // 旧会话没有该字段：保持缺省（不硬塞 false），由渲染层 / hook 按关闭展示
      const legacy = await realManager(root);
      legacy.sm.appendCustomEntry('session-preferences', { thinkingLevel: 'high', revision: 1 });
      await legacy.write();
      const handleC = fastHandle(legacy.file, legacy.sm, live);
      handles.push(handleC);
      const legacyState = await service.send('C:/work', 'agent_get_state', { targetSessionPath: legacy.file }) as Record<string, unknown>;
      expect(legacyState.preferences).toEqual({ thinkingLevel: 'high', revision: 1 });
      expect(legacyState.preferences as Record<string, unknown>).not.toHaveProperty('fastMode');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('派生会话补初值时不会把 fastMode false 丢掉（seed 用 boolean 判定）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-fast-seed-'));
    try {
      const source = await realManager(root);
      const target = await realManager(root);
      const targetFile = target.file;
      // 分支带来的 canonical revision 为 0：seedForkedPreferences 会按快照补一条新条目
      target.sm.appendCustomEntry('session-preferences', { fastMode: false, revision: 0 });
      await target.write();
      const live = liveModel();
      const handle = fastHandle(source.file, source.sm, live);
      let currentFile = source.file;
      handle.fork = vi.fn(async () => {
        const branched = SessionManager.open(targetFile);
        currentFile = targetFile;
        handle.session.sessionId = branched.getSessionId();
        handle.session.sessionFile = targetFile;
        handle.session.sessionManager = branched;
        return { cancelled: false };
      });
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'medium', sessionFile: currentFile, sessionId: handle.session.sessionId }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      await service.openWorkspace('C:/work');
      await service.send('C:/work', 'agent_clone', {});
      const state = await service.send('C:/work', 'agent_get_state', {}) as Record<string, unknown>;
      expect(state.preferences).toEqual({ fastMode: false, revision: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('agent_new_session 的 initialPreferences 保留 fastMode false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-fast-new-'));
    try {
      const { sm, file } = await realManager(root);
      const live = liveModel();
      const handle = fastHandle(file, sm, live);
      let currentFile = file;
      handle.newSession = vi.fn(async () => {
        const fresh = SessionManager.create('C:/work', root);
        fresh.appendMessage({ role: 'user', content: 'fresh', timestamp: 1 } as never);
        await writeFile(fresh.getSessionFile()!, [fresh.getHeader(), ...fresh.getEntries()].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
        currentFile = fresh.getSessionFile()!;
        handle.session.sessionId = fresh.getSessionId();
        handle.session.sessionFile = currentFile;
        handle.session.sessionManager = fresh;
        return { cancelled: false };
      });
      handle.getState = vi.fn(() => ({ model: live, thinkingLevel: 'medium', sessionFile: currentFile, sessionId: handle.session.sessionId }));
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({ agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });
      const result = await service.send('C:/work', 'agent_new_session', { initialPreferences: { fastMode: false } }) as Record<string, unknown>;
      expect(result).toMatchObject({ cancelled: false, applied: ['fastMode'], unavailable: [] });
      expect(result.preferences).toEqual({ fastMode: false, revision: 1 });
      const lines = (await readFile(currentFile, 'utf8')).trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
      expect(lines.filter((e) => e.customType === 'session-preferences').map((e) => e.data)).toEqual([{ fastMode: false, revision: 1 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('项目默认可含 fastMode（false 也保留），普通 setter 不改项目默认', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-prefs-fast-defaults-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetAgentModeForTest();
    __resetApprovalForTest();
    try {
      const { sm, file } = await realManager(root);
      const handle = fastHandle(file, sm);
      const { host } = fakeAgentHost(handle);
      const service = new PiRuntimeService({
        agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, runtimeConfigPath,
        resolveWorkspace: async () => 'D:/Resolved/',
      });
      await service.openWorkspace('C:/work');
      const set = await service.send('C:/work', 'agent_set_session_defaults', { preferences: { fastMode: false } }) as Record<string, unknown>;
      expect(set).toEqual({ mode: 'agent', approval: 'auto', fastMode: false, revision: 0 });
      const written = JSON.parse(await readFile(runtimeConfigPath, 'utf8'));
      expect(JSON.parse(written['SESSION_DEFAULTS:c:/work'])).toEqual({ fastMode: false });
      // 普通 setter 只碰会话，不动项目默认
      await service.send('C:/work', 'agent_set_fast_mode', { enabled: true, targetSessionPath: file });
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))).toEqual(written);
      const defaults = await service.send('C:/work', 'agent_get_session_defaults', {}) as Record<string, unknown>;
      expect(defaults.fastMode).toBe(false);
    } finally {
      __resetAgentModeForTest();
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });
});
