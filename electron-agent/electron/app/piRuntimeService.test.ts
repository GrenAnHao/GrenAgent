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
    expect(manager.open).toHaveBeenCalledWith('C:/work', 'C:/work', { PI_PACKAGE_DIR: 'C:/agent' });
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
    expect(manager.open).toHaveBeenCalledWith('C:/work', 'C:/work', { PI_PACKAGE_DIR: 'C:/agent' });
  });

  it('persists an interactive thread turn around agent_prompt and emits lifecycle events', async () => {
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn() };
    const manager = { get: vi.fn(() => client), open: vi.fn(() => client), close: vi.fn() } as any;
    const thread = { createThread: vi.fn(async (input) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })), createTurn: vi.fn(async (input) => ({ ...input, status: 'queued', mode: 'interactive', createdAt: 1 })), updateTurn: vi.fn(async (id, patch) => ({ id, ...patch })) };
    const events: any[] = [];
    const service = new PiRuntimeService({ manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent', threadStore: thread as any, emitAppEvent: (event) => events.push(event) });

    await service.send('C:/work', 'agent_prompt', { prompt: 'hello' });

    expect(thread.createThread).toHaveBeenCalledOnce();
    expect(thread.createTurn).toHaveBeenCalledWith(expect.objectContaining({ input: 'hello' }));
    expect(thread.updateTurn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'completed' }));
    expect(events.map((event) => event.type)).toEqual(['thread.created', 'turn.queued', 'turn.completed']);
  });
});
