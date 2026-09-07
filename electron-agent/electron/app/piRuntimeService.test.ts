import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { PiRuntimeService } from './piRuntimeService';

describe('PiRuntimeService', () => {
  it('keeps turns and late lifecycle events isolated for two sessions in one workspace', async () => {
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', threadStore: thread as any });

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
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', threadStore: thread as any, onEvent });

    await service.send('C:/work', 'agent_prompt', { message: 'hello', sessionId: 'session-a', source: 'goal' });
    await service.handlePiEvent('C:/work', { type: 'agent_start' }, 'session-a', 'goal');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'C:/work', sessionId: 'session-a', source: 'goal', event: { type: 'agent_start' } }));
  });

  it('issues the Agent Data endpoint for the resolved project cwd', async () => {
    const client = { send: async <T>() => ({} as T), respondUi: vi.fn() };
    const manager = { get: vi.fn(), open: vi.fn(() => client), close: vi.fn() };
    const endpoint = vi.fn(() => 'project-endpoint');
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent',
      resolveWorkspace: async () => 'D:/resolved-project', agentDataEndpoint: endpoint });
    await service.openWorkspace('alias');
    expect(endpoint).toHaveBeenCalledWith('D:/resolved-project');
    expect(manager.open).toHaveBeenCalledWith('alias', 'D:/resolved-project', expect.objectContaining({ AGENT_DATA_ENDPOINT: 'project-endpoint' }));
  });

  it('opens a workspace and forwards agent commands to its Pi client', async () => {
    const client = { send: vi.fn(async (command: Record<string, unknown>) => ({ sessionFile: 'C:/sessions/a.jsonl', command })), respondUi: vi.fn() };
    let activeClient: typeof client | undefined;
    const manager = {
      get: vi.fn(() => activeClient),
      open: vi.fn(() => {
        activeClient = client;
        return client;
      }),
      close: vi.fn(async () => {}),
    } as any;
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: ['--mode', 'rpc'] }, agentDir: 'C:/agent' });

    await expect(service.openWorkspace('C:/work')).resolves.toEqual({ restoredSession: null, sessionFile: 'C:/sessions/a.jsonl' });
    await expect(service.send('C:/work', 'agent_get_state', {})).resolves.toEqual({ sessionFile: 'C:/sessions/a.jsonl', command: { type: 'get_state' } });
    expect(manager.open).toHaveBeenCalledWith('C:/work', 'C:/work', { PI_PACKAGE_DIR: 'C:/agent', PI_PERMISSION_PROFILE: 'workspace' });
    expect(client.send).toHaveBeenLastCalledWith({ type: 'get_state' });
  });

  it('rejects commands that do not map to a Pi RPC operation', async () => {
    const manager = { get: vi.fn(), open: vi.fn(), close: vi.fn() };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent' });

    await expect(service.send('C:/work', 'agent_not_real', {})).rejects.toThrow('Unsupported Pi command');
  });

  it('opens a workspace on the first agent command when warm_workspace has not run yet', async () => {
    const client = { send: vi.fn(async (command: Record<string, unknown>) => command), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => undefined), open: vi.fn(() => client), close: vi.fn() } as any;
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent' });

    await expect(service.send('C:/work', 'agent_get_state', {})).resolves.toEqual({ type: 'get_state' });
    expect(manager.open).toHaveBeenCalledWith('C:/work', 'C:/work', { PI_PACKAGE_DIR: 'C:/agent', PI_PERMISSION_PROFILE: 'workspace' });
  });

  it('keeps a prompt queued until Pi lifecycle events persist its items and complete it', async () => {
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const thread = { createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })), createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })), updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })), upsertItem: vi.fn(async (item) => item) };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', threadStore: thread as any });

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
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const thread = { createThread: vi.fn(), createTurn: vi.fn(), updateTurn: vi.fn() };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { message: '/goal write tests' });

    expect(client.send).toHaveBeenCalledWith({ type: 'prompt', message: '/goal write tests' });
    expect(thread.createThread).not.toHaveBeenCalled();
    expect(thread.createTurn).not.toHaveBeenCalled();
  });

  it('steers the active Turn and queues follow-up prompts without replacing it', async () => {
    const client = { send: vi.fn(async (command: Record<string, unknown>) => command), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const thread = {
      createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })),
      updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })),
    };
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', threadStore: thread as any });

    await service.send('C:/work', 'agent_prompt', { message: 'first' });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'steer now', streamingBehavior: 'steer' })).resolves.toMatchObject({ type: 'prompt', message: 'steer now', streamingBehavior: 'steer' });
    await expect(service.send('C:/work', 'agent_prompt', { message: 'after this', streamingBehavior: 'followUp' })).resolves.toMatchObject({ status: 'queued', position: 1 });

    expect(thread.createTurn).toHaveBeenCalledOnce();
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('routes extension-backed mode and approval changes through prompt commands', async () => {
    const client = { send: vi.fn(async (command: Record<string, unknown>) => command), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(), close: vi.fn() } as any;
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent' });

    await expect(service.send('C:/work', 'agent_set_mode', { mode: 'plan' })).resolves.toEqual({
      type: 'prompt',
      message: '/mode plan',
    });
    await expect(service.send('C:/work', 'agent_set_approval', { level: 'full' })).resolves.toEqual({
      type: 'prompt',
      message: '/approval full',
    });
    await expect(service.send('C:/work', 'agent_exclude_entry', { timestamp: 101 })).resolves.toEqual({
      type: 'prompt',
      message: '/ctx-exclude 101',
    });
    await expect(service.send('C:/work', 'agent_restore_entry', { timestamp: 101 })).resolves.toEqual({
      type: 'prompt',
      message: '/ctx-restore 101',
    });
  });

  it('rewinds by resolving the message timestamp to an entry id before forking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-'));
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'root' }),
      JSON.stringify({ type: 'message', id: 'entry-1', message: { role: 'user', timestamp: 100 } }),
      JSON.stringify({ type: 'message', id: 'entry-2', message: { role: 'user', timestamp: 200 } }),
    ].join('\n'));
    const client = {
      send: vi.fn(async (command: Record<string, unknown>) => {
        if (command.type === 'get_state') return { sessionFile };
        return command;
      }),
      respondUi: vi.fn(),
    };
    const manager = { get: vi.fn(() => client), open: vi.fn(), close: vi.fn() } as any;
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent' });

    try {
      await expect(service.send('C:/work', 'agent_rewind_to', { timestamp: 200 })).resolves.toEqual({
        type: 'fork',
        entryId: 'entry-2',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
