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
});
