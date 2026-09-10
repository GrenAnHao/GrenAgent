import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { PiRuntimeService, type AgentHostPort } from './piRuntimeService';
import { AgentDataStorage } from '../agentData/storage';
import { GoalStore } from '../agentData/goalStore';

function fakeHandle(session: Record<string, unknown> = {}) {
  return {
    session: { steer: vi.fn(), followUp: vi.fn(), abort: vi.fn(), setModel: vi.fn(), cycleModel: vi.fn(), setThinkingLevel: vi.fn(), cycleThinkingLevel: vi.fn(), compact: vi.fn(), setAutoCompactionEnabled: vi.fn(), abortRetry: vi.fn(), getSessionStats: vi.fn(() => ({})), getUserMessagesForForking: vi.fn(() => []), setSessionName: vi.fn(), messages: [], modelRuntime: { getAvailableSnapshot: () => [] }, sessionManager: { getLeafId: () => 'leaf' }, ...session },
    prompt: vi.fn(async () => {}),
    getState: vi.fn(() => ({ sessionFile: 'C:/sessions/a.jsonl', sessionId: 'session-a' })),
    getCommands: vi.fn(() => ({ commands: [] })),
    newSession: vi.fn(async () => ({ cancelled: false })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false })),
    ui: { respond: vi.fn() },
  } as any;
}
function fakeAgentHost(handle = fakeHandle()) {
  return { host: { open: vi.fn(async () => handle), get: vi.fn(() => handle), close: vi.fn(async () => {}) } as AgentHostPort, handle };
}
const noopModelHost = { refresh: vi.fn(async () => {}), workspaces: () => [] };

function hostForSession(sessionFile: string) {
  const handle = fakeHandle();
  handle.getState = vi.fn(() => ({ sessionFile }));
  return fakeAgentHost(handle);
}

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
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

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

  it('emits accepted runtime events with session identity and source', async () => {
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const thread = { createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })), createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })), updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })) };
    const onEvent = vi.fn();
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, threadStore: thread as any, onEvent });

    await service.send('C:/work', 'agent_prompt', {
      message: 'hello', sessionId: 'session-a', source: 'goal', goalId: 'goal-a', revision: 1,
      nextRound: 1, idempotencyKey: 'goal-a:1:1', turnId: 'turn-a',
    });
    await service.handlePiEvent('C:/work', { type: 'agent_start' }, 'session-a', 'goal');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'C:/work', sessionId: 'session-a', source: 'goal', event: { type: 'agent_start' } }));
  });

  it('rejects a Goal turn without its revision and idempotency metadata', async () => {
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'goal turn', source: 'goal', sessionId: 'session-a' })).rejects.toThrow('INVALID_GOAL_TURN');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('turnConfig exposes the Agent Data endpoint without process-level keys', async () => {
    const { host } = fakeAgentHost();
    const endpoint = vi.fn(() => 'project-endpoint');
    const service = new PiRuntimeService({
      manager: { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any,
      processCommand: { command: 'pi', args: [] },
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

  it('opens a workspace and forwards agent commands to its Pi client', async () => {
    const { host, handle } = fakeAgentHost();
    handle.getState = vi.fn(() => ({ sessionFile: 'C:/sessions/a.jsonl' }));
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: ['--mode', 'rpc'] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });

    await expect(service.openWorkspace('C:/work')).resolves.toMatchObject({ restoredSession: null, sessionFile: 'C:/sessions/a.jsonl' });
    await expect(service.send('C:/work', 'agent_get_state', {})).resolves.toMatchObject({ sessionFile: 'C:/sessions/a.jsonl' });
    expect(host.open).toHaveBeenCalledWith('C:/work', 'C:/work');
    expect(handle.getState).toHaveBeenCalled();
  });

  it('migrates the latest legacy Goal entry once when opening a session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-legacy-goal-'));
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'legacy-session', cwd: 'C:/work' }),
      JSON.stringify({ type: 'custom', id: 'goal-1', parentId: 'root', customType: 'goal', timestamp: '2026-09-07T00:00:00.000Z', data: { condition: 'finish migration', react: 2, paused: true } }),
    ].join('\n'));
    const { host } = hostForSession(sessionFile);
    const manager = { get: vi.fn(() => undefined), open: vi.fn(), close: vi.fn() } as any;
    const migrateLegacyGoal = vi.fn(async () => {});
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, migrateLegacyGoal });
    try {
      await service.openWorkspace('C:/work');
      await service.openWorkspace('C:/work');
      expect(migrateLegacyGoal).toHaveBeenCalledOnce();
      expect(migrateLegacyGoal).toHaveBeenCalledWith(expect.objectContaining({
        workspace: 'C:/work', sessionId: 'legacy-session', sessionPath: sessionFile,
        condition: 'finish migration', react: 2, paused: true, legacyEntryTimestamp: '2026-09-07T00:00:00.000Z',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deduplicates concurrent legacy migration requests for one session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-legacy-goal-concurrent-'));
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'legacy-session', cwd: 'C:/work' }),
      JSON.stringify({ type: 'custom', id: 'goal-1', parentId: 'legacy-session', customType: 'goal', data: { condition: 'finish migration' } }),
    ].join('\n'));
    let release!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const migrateLegacyGoal = vi.fn(async () => {
      signalStarted();
      await gate;
    });
    const service = new PiRuntimeService({ manager: {} as any, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, migrateLegacyGoal });
    const identity = { sessionId: 'legacy-session', sessionPath: sessionFile, source: 'interactive' as const };
    try {
      const first = (service as any).migrateLegacyGoal('C:/work', identity) as Promise<void>;
      await started;
      const second = (service as any).migrateLegacyGoal('C:/work', identity) as Promise<void>;
      expect(migrateLegacyGoal).toHaveBeenCalledOnce();
      release();
      await Promise.all([first, second]);
      expect(migrateLegacyGoal).toHaveBeenCalledOnce();
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries legacy migration after a partially written final JSONL entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-legacy-goal-partial-'));
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'legacy-session', cwd: 'C:/work' }),
      '{"type":"custom","customType":"goal"',
    ].join('\n'));
    const { host } = hostForSession(sessionFile);
    const manager = { get: vi.fn(() => undefined), open: vi.fn(), close: vi.fn() } as any;
    const migrateLegacyGoal = vi.fn(async () => {});
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, migrateLegacyGoal });
    try {
      await service.openWorkspace('C:/work');
      expect(migrateLegacyGoal).not.toHaveBeenCalled();
      await writeFile(sessionFile, [
        JSON.stringify({ type: 'session', id: 'legacy-session', cwd: 'C:/work' }),
        JSON.stringify({ type: 'custom', id: 'goal-1', parentId: 'legacy-session', customType: 'goal', data: { condition: 'finish partial recovery' } }),
      ].join('\n'));
      await service.openWorkspace('C:/work');
      expect(migrateLegacyGoal).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['agent_fork', 'agent_clone'] as const)('orders session fork handling before legacy migration for %s', async (command) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-fork-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    await writeFile(targetFile, [
      JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }),
      JSON.stringify({ type: 'custom', id: 'goal-1', parentId: 'target-session', customType: 'goal', data: { condition: 'restore this goal', react: 1 } }),
    ].join('\n'));
    const { host, handle } = hostSwitchingSession(sourceFile, targetFile);
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    const order: string[] = [];
    const service = new PiRuntimeService({
      manager,
      processCommand: { command: 'pi', args: [] },
      agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost,
      onSessionForked: vi.fn(async () => { order.push('forked'); }),
      migrateLegacyGoal: vi.fn(async () => { order.push('migrated'); }),
    });
    try {
      await expect(service.send('C:/work', command, { sessionId: 'source-session', sessionPath: sourceFile })).resolves.toEqual({ cancelled: false });
      expect(order).toEqual(['forked', 'migrated']);
      expect(handle.fork).toHaveBeenCalled();
      expect(handle.getState).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['agent_fork', 'agent_clone'] as const)('does not migrate a cancelled session fork for %s', async (command) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-fork-cancelled-'));
    const sourceFile = join(root, 'source.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    const handle = fakeHandle();
    handle.getState = vi.fn(() => ({ sessionFile: sourceFile }));
    handle.fork = vi.fn(async () => ({ cancelled: true }));
    const { host } = fakeAgentHost(handle);
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    const onSessionForked = vi.fn();
    const migrateLegacyGoal = vi.fn();
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, onSessionForked, migrateLegacyGoal });
    try {
      await expect(service.send('C:/work', command, { sessionId: 'source-session', sessionPath: sourceFile })).resolves.toEqual({ cancelled: true });
      expect(onSessionForked).not.toHaveBeenCalled();
      expect(migrateLegacyGoal).not.toHaveBeenCalled();
      expect(handle.fork).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries failed Goal fork synchronization before migrating the target legacy entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-fork-retry-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    await writeFile(targetFile, [
      JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }),
      JSON.stringify({ type: 'custom', id: 'goal-1', parentId: 'target-session', customType: 'goal', data: { condition: 'legacy target goal' } }),
    ].join('\n'));
    const { host } = hostSwitchingSession(sourceFile, targetFile);
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    let forkAttempts = 0;
    const onSessionForked = vi.fn(async () => {
      forkAttempts += 1;
      if (forkAttempts === 1) throw new Error('temporary AgentData outage');
    });
    const migrateLegacyGoal = vi.fn(async () => {});
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, onSessionForked, migrateLegacyGoal });
    try {
      await expect(service.send('C:/work', 'agent_fork', { sessionId: 'source-session', sessionPath: sourceFile })).resolves.toEqual({ cancelled: false });
      expect(onSessionForked).toHaveBeenCalledOnce();
      expect(migrateLegacyGoal).not.toHaveBeenCalled();

      await service.send('C:/work', 'agent_get_state', {});
      expect(onSessionForked).toHaveBeenCalledTimes(2);
      expect(migrateLegacyGoal).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds and migrates a switched session only after Pi accepts the switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-switch-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    await writeFile(targetFile, JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }) + '\n');
    const { host, handle } = hostSwitchingSession(sourceFile, targetFile);
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    const bindGoalSession = vi.fn();
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, bindGoalSession });
    try {
      await service.openWorkspace('C:/work');
      bindGoalSession.mockClear();
      await service.send('C:/work', 'agent_switch_session', { sessionPath: targetFile });
      expect(handle.switchSession).toHaveBeenCalledWith(targetFile);
      expect(bindGoalSession).toHaveBeenCalledWith('C:/work', 'target-session', 'interactive');
      expect(bindGoalSession).not.toHaveBeenCalledWith('C:/work', 'source-session', 'interactive');
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
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    const bindGoalSession = vi.fn();
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, bindGoalSession });
    try {
      await service.openWorkspace('C:/work');
      bindGoalSession.mockClear();
      await expect(service.send('C:/work', 'agent_switch_session', { sessionPath: targetFile })).resolves.toEqual({ cancelled: true });
      expect(handle.switchSession).toHaveBeenCalledTimes(1);
      expect(bindGoalSession).not.toHaveBeenCalled();
      await expect(service.ownsSession('C:/work', 'source-session')).resolves.toBe(true);
      await expect(service.ownsSession('C:/work', 'target-session')).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the source mapping when binding the switched session fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-switch-bind-failure-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    await writeFile(sourceFile, JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }) + '\n');
    await writeFile(targetFile, JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }) + '\n');
    const { host } = hostSwitchingSession(sourceFile, targetFile);
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    const unbindGoalSession = vi.fn();
    const bindGoalSession = vi.fn((_workspace: string, sessionId: string) => {
      if (sessionId === 'target-session') throw new Error('target binding failed');
    });
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, bindGoalSession, unbindGoalSession });
    try {
      await service.openWorkspace('C:/work');
      await expect(service.send('C:/work', 'agent_switch_session', { sessionPath: targetFile })).rejects.toThrow('target binding failed');
      await expect(service.ownsSession('C:/work', 'source-session')).resolves.toBe(true);
      await expect(service.ownsSession('C:/work', 'target-session')).resolves.toBe(false);
      expect(unbindGoalSession).not.toHaveBeenCalledWith('C:/work', 'source-session');
      expect(unbindGoalSession).toHaveBeenCalledWith('C:/work', 'target-session');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not migrate a cleared legacy Goal or a new AgentData snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-legacy-goal-clear-'));
    const makeService = async (name: string, entries: Record<string, unknown>[]) => {
      const sessionFile = join(root, name);
      await writeFile(sessionFile, [JSON.stringify({ type: 'session', id: name, cwd: 'C:/work' }), ...entries.map((entry) => JSON.stringify(entry))].join('\n'));
      const { host } = hostForSession(sessionFile);
      const manager = { get: vi.fn(() => undefined), open: vi.fn(), close: vi.fn() } as any;
      const migrateLegacyGoal = vi.fn(async () => {});
      const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, migrateLegacyGoal });
      await service.openWorkspace('C:/work');
      return migrateLegacyGoal;
    };
    try {
      const cleared = await makeService('cleared.jsonl', [
        { type: 'custom', id: 'old', customType: 'goal', data: { condition: 'old', react: 1 } },
        { type: 'custom', id: 'clear', customType: 'goal', data: null },
      ]);
      const current = await makeService('current.jsonl', [
        { type: 'custom', id: 'new', customType: 'goal', data: { goalId: 'g', condition: 'new', status: 'active' } },
      ]);
      expect(cleared).not.toHaveBeenCalled();
      expect(current).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('only considers the current JSONL branch when migrating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-legacy-goal-branch-'));
    const sessionFile = join(root, 'branch.jsonl');
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'branch-session', cwd: 'C:/work' }),
      JSON.stringify({ type: 'custom', id: 'goal-a', parentId: 'root', customType: 'goal', data: { condition: 'abandoned', react: 1 } }),
      JSON.stringify({ type: 'message', id: 'branch-b', parentId: 'root', message: { role: 'user', content: 'new branch' } }),
    ].join('\n'));
    const { host } = hostForSession(sessionFile);
    const manager = { get: vi.fn(() => undefined), open: vi.fn(), close: vi.fn() } as any;
    const migrateLegacyGoal = vi.fn(async () => {});
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, migrateLegacyGoal });
    try {
      await service.openWorkspace('C:/work');
      expect(migrateLegacyGoal).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates a legacy Goal inherited by the current JSONL branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-legacy-goal-ancestor-'));
    const sessionFile = join(root, 'ancestor.jsonl');
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'ancestor-session', cwd: 'C:/work' }),
      JSON.stringify({ type: 'custom', id: 'goal-a', parentId: 'ancestor-session', customType: 'goal', data: { condition: 'inherited goal', react: 2 } }),
      JSON.stringify({ type: 'message', id: 'active-child', parentId: 'goal-a', message: { role: 'user', content: 'continue' } }),
    ].join('\n'));
    const { host } = hostForSession(sessionFile);
    const manager = { get: vi.fn(() => undefined), open: vi.fn(), close: vi.fn() } as any;
    const migrateLegacyGoal = vi.fn(async () => {});
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, migrateLegacyGoal });
    try {
      await service.openWorkspace('C:/work');
      expect(migrateLegacyGoal).toHaveBeenCalledWith(expect.objectContaining({ condition: 'inherited goal', react: 2 }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects commands that do not map to a Pi RPC operation', async () => {
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost });

    await expect(service.send('C:/work', 'agent_not_real', {})).rejects.toThrow('Unsupported Pi command');
  });

  it('opens a workspace on the first agent command when warm_workspace has not run yet', async () => {
    const { host, handle } = fakeAgentHost();
    const manager = { get: vi.fn(() => undefined), open: vi.fn(), close: vi.fn() } as any;
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost });

    await expect(service.send('C:/work', 'agent_get_state', {})).resolves.toMatchObject({ sessionFile: 'C:/sessions/a.jsonl' });
    expect(host.open).toHaveBeenCalledWith('C:/work', 'C:/work');
    expect(handle.getState).toHaveBeenCalled();
  });

  it('keeps a prompt queued until Pi lifecycle events persist its items and complete it', async () => {
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const thread = { createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })), createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })), updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })), upsertItem: vi.fn(async (item) => item) };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

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
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    const thread = { createThread: vi.fn(), createTurn: vi.fn(), updateTurn: vi.fn() };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { message: '/goal write tests' });

    expect(handle.prompt).toHaveBeenCalledWith('/goal write tests', { images: undefined }, 'main');
    expect(thread.createThread).not.toHaveBeenCalled();
    expect(thread.createTurn).not.toHaveBeenCalled();
  });

  it('steers the active Turn and queues follow-up prompts without replacing it', async () => {
    const { host, handle } = fakeAgentHost();
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { message: 'first' });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'steer now', streamingBehavior: 'steer' })).resolves.toBeUndefined();
    await expect(service.send('C:/work', 'agent_prompt', { message: 'after this', streamingBehavior: 'followUp' })).resolves.toMatchObject({ status: 'queued', position: 1 });

    expect(thread.createTurn).toHaveBeenCalledOnce();
    expect(handle.prompt).toHaveBeenCalledTimes(2);
    expect(handle.prompt).toHaveBeenNthCalledWith(2, 'steer now', { images: undefined, streamingBehavior: 'steer' }, 'main');
  });

  it('drains a queued follow-up when the terminal callback rejects', async () => {
    const { host, handle } = fakeAgentHost();
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any;
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const onTurnSettled = vi.fn(async () => { throw new Error('settled hook failed'); });
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as any, onTurnSettled });

    await service.send('C:/work', 'agent_prompt', { message: 'first', sessionId: 'session-a' });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'after this', streamingBehavior: 'followUp', sessionId: 'session-a' }))
      .resolves.toMatchObject({ status: 'queued', position: 1 });

    await expect(service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] }, 'session-a')).rejects.toThrow('settled hook failed');
    expect(handle.session.followUp).toHaveBeenCalledWith('after this', undefined);
    expect(thread.createTurn).toHaveBeenCalledTimes(2);
    expect(onTurnSettled).toHaveBeenCalledOnce();
  });

  it('keeps Goal worker paths scoped and releases them when close fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-goal-worker-'));
    const pathOne = join(root, 'one.jsonl');
    const pathTwo = join(root, 'two.jsonl');
    await writeFile(pathOne, `${JSON.stringify({ type: 'session', id: 'same-session', cwd: 'C:/one' })}\n`);
    await writeFile(pathTwo, `${JSON.stringify({ type: 'session', id: 'same-session', cwd: 'C:/two' })}\n`);
    const clientOne = { send: vi.fn(async () => ({ sessionId: 'same-session', sessionFile: pathOne })), respondUi: vi.fn() };
    const clientTwo = { send: vi.fn(async () => ({ sessionId: 'same-session', sessionFile: pathTwo })), respondUi: vi.fn() };
    const clients = new Map<string, typeof clientOne>([
      [`__goal__:C:/one\0same-session`, clientOne],
      [`__goal__:C:/two\0same-session`, clientTwo],
    ]);
    const manager = {
      get: vi.fn((key: string) => clients.get(key)),
      open: vi.fn((options: { key: string }) => {
        const client = clients.get(options.key);
        if (!client) throw new Error(`unexpected worker key: ${options.key}`);
        return client;
      }),
      close: vi.fn(async (key: string) => {
        if (key === `__goal__:C:/one\0same-session`) throw new Error('worker already exited');
      }),
    } as any;
    const bindGoalSession = vi.fn();
    const unbindGoalSession = vi.fn();
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, bindGoalSession, unbindGoalSession });

    try {
      await service.openGoalWorker('same-session', 'C:/one', pathOne);
      await service.openGoalWorker('same-session', 'C:/two', pathTwo);
      expect(manager.open).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: `__goal__:C:/one\0same-session` }));
      expect(manager.open).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: `__goal__:C:/two\0same-session` }));

      await expect(service.closeGoalWorker('same-session', 'C:/one')).rejects.toThrow('worker already exited');
      expect(unbindGoalSession).toHaveBeenCalledWith('C:/one', 'same-session');
      await expect(service.enqueueGoalTurn({
        workspace: 'C:/one', sessionId: 'same-session', turnId: 'turn-after-close',
        goal: { goalId: 'goal', revision: 1, nextRound: 1, idempotencyKey: 'goal:1:1', condition: 'condition' },
      })).rejects.toThrow('INVALID_GOAL_TURN');
      expect(manager.get(`__goal__:C:/two\0same-session`)).toBe(clientTwo);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('settles active Goal turns as cancelled before closing a workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-goal-close-turn-'));
    const sessionPath = join(root, 'session.jsonl');
    await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: 'session-a', cwd: 'C:/work' })}\n`);
    const client = { send: vi.fn(async (rpc: Record<string, unknown>) => rpc.type === 'get_state' ? { sessionId: 'session-a', sessionFile: sessionPath } : { ok: true }), respondUi: vi.fn() };
    const manager = {
      get: vi.fn(() => undefined),
      open: vi.fn(() => client),
      openGoalWorker: vi.fn(() => client),
      closeGoalWorker: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as any;
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'goal', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const onTurnSettled = vi.fn(async () => {});
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, threadStore: thread as any, onTurnSettled });
    try {
      await service.send('C:/work', 'agent_prompt', {
        message: 'continue goal', source: 'goal', sessionId: 'session-a', sessionPath,
        goalId: 'goal-a', revision: 1, nextRound: 1, idempotencyKey: 'goal-a:1:1', turnId: 'turn-a',
      });
      await service.closeWorkspace('C:/work');
      expect(onTurnSettled).toHaveBeenCalledWith(expect.objectContaining({
        workspace: 'C:/work', sessionId: 'session-a', turnId: 'turn-a', status: 'cancelled',
        goal: expect.objectContaining({ goalId: 'goal-a', revision: 1 }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finishes workspace cleanup when a Goal worker close rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-goal-workspace-'));
    const sessionPath = join(root, 'session.jsonl');
    const goalKey = '__goal__:C:/work\0session-a';
    await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: 'session-a', cwd: 'C:/work' })}\n`);
    const client = { send: vi.fn(async () => ({ sessionId: 'session-a', sessionFile: sessionPath })), respondUi: vi.fn() };
    const close = vi.fn(async (key: string) => {
      if (key === goalKey) throw new Error('goal worker close failed');
    });
    const manager = {
      get: vi.fn((key: string) => key === goalKey ? client : undefined),
      open: vi.fn(() => client),
      close,
    } as any;
    const unbindGoalSession = vi.fn();
    const { host } = fakeAgentHost();
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, unbindGoalSession });

    try {
      await service.openGoalWorker('session-a', 'C:/work', sessionPath);
      await expect(service.closeWorkspace('C:/work')).rejects.toThrow('goal worker close failed');
      expect(close).toHaveBeenCalledWith(goalKey);
      expect(host.close).toHaveBeenCalledWith('C:/work');
      expect(unbindGoalSession).toHaveBeenCalledWith('C:/work', 'session-a');
      await expect(service.enqueueGoalTurn({
        workspace: 'C:/work', sessionId: 'session-a', turnId: 'after-close',
        goal: { goalId: 'goal', revision: 1, nextRound: 1, idempotencyKey: 'goal:1:1', condition: 'condition' },
      })).rejects.toThrow('INVALID_GOAL_TURN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a background Goal worker from repointing the visible session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-goal-isolation-'));
    const visiblePath = join(root, 'visible.jsonl');
    const goalPath = join(root, 'goal.jsonl');
    await writeFile(visiblePath, `${JSON.stringify({ type: 'session', id: 'visible-session', cwd: 'C:/work' })}\n`);
    await writeFile(goalPath, `${JSON.stringify({ type: 'session', id: 'goal-session', cwd: 'C:/work' })}\n`);
    const goalKey = '__goal__:C:/work\0goal-session';
    const visibleClient = { send: vi.fn(async () => ({ sessionId: 'visible-session', sessionFile: visiblePath })), setSessionIdentity: vi.fn(), respondUi: vi.fn() };
    const goalClient = { send: vi.fn(async () => ({ sessionId: 'goal-session', sessionFile: goalPath })), setSessionIdentity: vi.fn(), respondUi: vi.fn() };
    const manager = {
      get: vi.fn((key: string) => (key === goalKey ? goalClient : key === 'C:/work' ? visibleClient : undefined)),
      open: vi.fn(() => visibleClient),
      openGoalWorker: vi.fn(() => goalClient),
      closeGoalWorker: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as any;
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const { host } = hostForSession(visiblePath);
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: thread as any });
    try {
      await service.openWorkspace('C:/work');
      await service.openGoalWorker('goal-session', 'C:/work', goalPath);
      goalClient.send.mockClear();

      await service.send('C:/work', 'agent_get_state', { source: 'goal', sessionId: 'goal-session', sessionPath: goalPath });
      expect(goalClient.send).toHaveBeenCalledWith({ type: 'get_state' });
      // The visible session must still own the workspace: the next interactive
      // turn belongs to it, not to the headless Goal session.
      await service.send('C:/work', 'agent_prompt', { message: 'user turn' });
      expect(thread.createTurn).toHaveBeenCalledWith(expect.objectContaining({ input: 'user turn', sessionId: 'visible-session' }));
      expect(visibleClient.setSessionIdentity).not.toHaveBeenCalledWith('goal-session', goalPath);

      for (const command of ['agent_switch_session', 'agent_new_session', 'agent_fork', 'agent_clone', 'agent_rewind_to']) {
        await expect(service.send('C:/work', command, { source: 'goal', sessionId: 'goal-session', sessionPath: goalPath }))
          .rejects.toThrow('GOAL_SESSION_COMMAND_FORBIDDEN');
      }
      expect(goalClient.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'switch_session' }));
      expect(goalClient.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fork' }));
      expect(goalClient.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'clone' }));
      expect(goalClient.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'new_session' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the active and every queued Goal turn as failed when the worker exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-goal-exit-'));
    const sessionPath = join(root, 'session.jsonl');
    await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: 'session-a', cwd: 'C:/work' })}\n`);
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), closeGoalWorker: vi.fn(async () => {}), close: vi.fn(async () => {}) } as any;
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'goal', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const onTurnSettled = vi.fn(async (result: { turnId: string }) => {
      if (result.turnId === 'turn-2') throw new Error('coordinator offline');
    });
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: fakeAgentHost().host, modelRuntimeHost: noopModelHost, threadStore: thread as any, onTurnSettled });
    try {
      for (const [index, turnId] of ['turn-1', 'turn-2', 'turn-3'].entries()) {
        const revision = index * 2 + 1;
        await service.enqueueGoalTurn({
          workspace: 'C:/work', sessionId: 'session-a', sessionPath, turnId,
          goal: { goalId: 'goal-a', revision, nextRound: 1, idempotencyKey: `goal-a:${revision}:1`, condition: 'ship it' },
        });
      }
      onTurnSettled.mockClear();

      await service.handlePiExit('C:/work', 1, { key: 'k', logicalWorkspace: 'C:/work', sessionId: 'session-a', source: 'goal' } as any);

      // Every queued turn already holds a claimed AgentData lease, so each one
      // needs its own terminal report even when an earlier callback rejects.
      expect(onTurnSettled).toHaveBeenCalledTimes(3);
      for (const [index, turnId] of ['turn-1', 'turn-2', 'turn-3'].entries()) {
        expect(onTurnSettled).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({
          workspace: 'C:/work', sessionId: 'session-a', turnId, status: 'failed',
          summary: 'Pi exited unexpectedly (1)',
          goal: { goalId: 'goal-a', revision: index * 2 + 1, nextRound: 1, idempotencyKey: `goal-a:${index * 2 + 1}:1` },
        }));
      }
      // The released idempotency keys must be dispatchable again after recovery.
      onTurnSettled.mockClear();
      await service.enqueueGoalTurn({
        workspace: 'C:/work', sessionId: 'session-a', sessionPath, turnId: 'turn-3',
        goal: { goalId: 'goal-a', revision: 5, nextRound: 1, idempotencyKey: 'goal-a:5:1', condition: 'ship it' },
      });
      expect(client.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'prompt' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['agent_fork', 'agent_clone'] as const)('does not resurrect a cleared Goal through the %s legacy entry', async (command) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-cleared-fork-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    const legacyGoal = { type: 'custom', id: 'goal-1', customType: 'goal', data: { condition: 'legacy goal', react: 2 } };
    await writeFile(sourceFile, [
      JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }),
      JSON.stringify({ ...legacyGoal, parentId: 'source-session' }),
    ].join('\n'));
    // Pi copies the session log when it forks, so the target still carries the
    // same legacy Goal entry.
    await writeFile(targetFile, [
      JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }),
      JSON.stringify({ ...legacyGoal, parentId: 'target-session' }),
    ].join('\n'));
    const storage = new AgentDataStorage(':memory:');
    storage.migrate();
    const store = new GoalStore(storage.db);
    let activeFile = sourceFile;
    const client = {
      send: vi.fn(async (rpc: Record<string, unknown>) => {
        if (rpc.type === 'get_state') return { sessionFile: activeFile };
        activeFile = targetFile;
        return { cancelled: false };
      }),
      setSessionIdentity: vi.fn(),
      respondUi: vi.fn(),
    };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const { host } = hostSwitchingSession(sourceFile, targetFile);
    const service = new PiRuntimeService({
      manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost,
      // Mirrors main.ts: a cleared source is forked as a tombstone instead of
      // being skipped, so the copied legacy entry has nothing left to restore.
      onSessionForked: async ({ sourceSessionId, targetSessionId }) => {
        const source = store.get(sourceSessionId);
        if (!source) return;
        store.fork({ sourceSessionId, sourceGoalId: source.goalId, targetSessionId });
      },
      migrateLegacyGoal: ({ workspace, sessionId, condition, react, paused }) => {
        store.recoverLegacy({ workspace, sessionId, condition, react, paused });
      },
    });
    try {
      await service.openWorkspace('C:/work');
      const legacy = store.get('source-session');
      expect(legacy).toMatchObject({ status: 'disarmed', source: 'legacy', condition: 'legacy goal' });
      store.clear({ sessionId: 'source-session', goalId: legacy!.goalId, revision: legacy!.revision, action: 'clear', origin: 'human-ui' });

      await service.send('C:/work', command, { sessionId: 'source-session', sessionPath: sourceFile });

      expect(store.getLive('target-session')).toBeUndefined();
      expect(store.get('target-session')).toMatchObject({
        status: 'cleared', source: 'fork', sourceGoalId: legacy!.goalId, sourceSessionId: 'source-session',
      });
      expect(store.history('target-session').map((event) => event.kind)).toEqual(['fork']);
    } finally {
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['agent_fork', 'agent_clone'] as const)('forks a live legacy Goal into one disarmed copy for %s', async (command) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-live-fork-'));
    const sourceFile = join(root, 'source.jsonl');
    const targetFile = join(root, 'target.jsonl');
    const legacyGoal = { type: 'custom', id: 'goal-1', customType: 'goal', data: { condition: 'legacy goal', react: 2 } };
    await writeFile(sourceFile, [
      JSON.stringify({ type: 'session', id: 'source-session', cwd: 'C:/work' }),
      JSON.stringify({ ...legacyGoal, parentId: 'source-session' }),
    ].join('\n'));
    await writeFile(targetFile, [
      JSON.stringify({ type: 'session', id: 'target-session', cwd: 'C:/work' }),
      JSON.stringify({ ...legacyGoal, parentId: 'target-session' }),
    ].join('\n'));
    const storage = new AgentDataStorage(':memory:');
    storage.migrate();
    const store = new GoalStore(storage.db);
    let activeFile = sourceFile;
    const client = {
      send: vi.fn(async (rpc: Record<string, unknown>) => {
        if (rpc.type === 'get_state') return { sessionFile: activeFile };
        activeFile = targetFile;
        return { cancelled: false };
      }),
      setSessionIdentity: vi.fn(),
      respondUi: vi.fn(),
    };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const { host } = hostSwitchingSession(sourceFile, targetFile);
    const service = new PiRuntimeService({
      manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', agentHost: host, modelRuntimeHost: noopModelHost,
      onSessionForked: async ({ sourceSessionId, targetSessionId }) => {
        const source = store.get(sourceSessionId);
        if (!source) return;
        store.fork({ sourceSessionId, sourceGoalId: source.goalId, targetSessionId });
      },
      migrateLegacyGoal: ({ workspace, sessionId, condition, react, paused }) => {
        store.recoverLegacy({ workspace, sessionId, condition, react, paused });
      },
    });
    try {
      await service.openWorkspace('C:/work');
      const legacy = store.get('source-session');

      await service.send('C:/work', command, { sessionId: 'source-session', sessionPath: sourceFile });

      expect(store.get('target-session')).toMatchObject({
        status: 'disarmed', source: 'fork', condition: 'legacy goal', sourceGoalId: legacy!.goalId,
      });
      expect(store.history('target-session').map((event) => event.kind)).toEqual(['fork']);
    } finally {
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes extension-backed mode and approval changes through prompt commands', async () => {
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({
      manager: { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any,
      processCommand: { command: 'pi', args: [] },
      agentDir: 'C:/agent',
      agentHost: host,
      modelRuntimeHost: noopModelHost,
    });

    await service.send('C:/work', 'agent_set_mode', { mode: 'plan' });
    expect(handle.prompt).toHaveBeenCalledWith('/mode plan', {}, 'main');

    handle.prompt.mockClear();
    await expect(service.send('C:/work', 'agent_set_approval', { level: 'full' })).resolves.toBeUndefined();
    await expect(service.send('C:/work', 'agent_exclude_entry', { timestamp: 101 })).resolves.toBeUndefined();
    await expect(service.send('C:/work', 'agent_restore_entry', { timestamp: 101 })).resolves.toBeUndefined();
    expect(handle.prompt).not.toHaveBeenCalled();
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
      manager: { get: vi.fn(), open: vi.fn(), close: vi.fn() } as any,
      processCommand: { command: 'pi', args: [] },
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
    const service = new PiRuntimeService({ manager: {} as never, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await expect(service.send('C:/work', 'agent_prompt', { message: '你好' })).resolves.toBeUndefined();
    expect(handle.prompt).toHaveBeenCalledTimes(1);
  });

  it('agent_prompt 活跃时 session 替换命令抛 SESSION_BUSY', async () => {
    const { host, handle } = fakeAgentHost();
    handle.prompt = vi.fn(async () => {});
    const service = new PiRuntimeService({ manager: {} as never, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost, threadStore: { createThread: async (i: never) => i, createTurn: async (i: never) => i, updateTurn: async (i: never) => i } as never });
    await service.send('C:/work', 'agent_prompt', { message: 'x' });
    await expect(service.send('C:/work', 'agent_new_session', {})).rejects.toThrow('SESSION_BUSY');
  });

  it('agent_set_mode 走 handle.prompt 的斜杠命令', async () => {
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({ manager: {} as never, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await service.send('C:/work', 'agent_set_mode', { mode: 'plan' });
    expect(handle.prompt).toHaveBeenCalledWith('/mode plan', {}, 'main');
  });

  it('agent_abort 调 session.abort', async () => {
    const { host, handle } = fakeAgentHost();
    const service = new PiRuntimeService({ manager: {} as never, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/a', agentHost: host, modelRuntimeHost: noopModelHost });
    await service.send('C:/work', 'agent_abort', {});
    expect(handle.session.abort).toHaveBeenCalledTimes(1);
  });
});
