import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { PiRuntimeService } from './piRuntimeService';

describe('PiRuntimeService', () => {
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
    const events: any[] = [];
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', threadStore: thread as any, emitAppEvent: (event) => events.push(event) });

    await service.send('C:/work', 'agent_prompt', { prompt: 'hello' });

    expect(thread.createThread).toHaveBeenCalledOnce();
    expect(thread.createTurn).toHaveBeenCalledWith(expect.objectContaining({ input: 'hello' }));
    expect(thread.updateTurn).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['thread.created', 'turn.queued']);

    await service.handlePiEvent('C:/work', { type: 'agent_start' });
    await service.handlePiEvent('C:/work', { type: 'message_start', message: { role: 'assistant', content: [] } });
    await service.handlePiEvent('C:/work', { type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', delta: 'hi' } });
    await service.handlePiEvent('C:/work', { type: 'message_end', message: { role: 'assistant', content: [] } });
    await service.handlePiEvent('C:/work', { type: 'agent_end', messages: [] });

    expect(events.map((event) => event.type)).toEqual([
      'thread.created', 'turn.queued', 'turn.started', 'item.created', 'item.delta', 'item.updated', 'turn.completed',
    ]);
    expect(events.filter((event) => event.itemId).map((event) => event.itemId)).toEqual([
      expect.any(String), expect.any(String), expect.any(String),
    ]);
    expect(new Set(events.filter((event) => event.itemId).map((event) => event.itemId)).size).toBe(1);
    expect(thread.updateTurn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ status: 'completed' }));
    expect(thread.upsertItem).toHaveBeenCalledTimes(3);
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
