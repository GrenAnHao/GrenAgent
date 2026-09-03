import { describe, expect, it, vi } from 'vitest';
import { ShellService, type Pty } from './shellService';

function pty(): Pty & { emitData(data: string): void; emitExit(code: number): void } {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  return {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: (listener) => { onData = listener; return { dispose: () => {} }; },
    onExit: (listener) => { onExit = listener; return { dispose: () => {} }; },
    emitData: (data) => onData?.(data), emitExit: (exitCode) => onExit?.({ exitCode }),
  };
}

describe('ShellService', () => {
  it('starts a PTY session and relays data, resize, write, exit and stop', async () => {
    const instance = pty();
    const spawn = vi.fn().mockReturnValue(instance);
    const emit = vi.fn();
    const service = new ShellService(emit, spawn, async (path) => path);
    const { session_id } = await service.start('C:/project');
    instance.emitData('ready');
    await service.write(session_id, 'echo test\r');
    await service.resize(session_id, 30, 120);
    instance.emitExit(0);
    await service.stop(session_id);

    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ cwd: 'C:/project', rows: 24, cols: 100 }));
    expect(emit).toHaveBeenCalledWith('shell-output', { type: 'output', data: 'ready', session_id });
    expect(instance.write).toHaveBeenCalledWith('echo test\r');
    expect(instance.resize).toHaveBeenCalledWith(120, 30);
    expect(emit).toHaveBeenCalledWith('shell-output', { type: 'exit', exit_code: 0, session_id });
    expect(instance.kill).toHaveBeenCalledOnce();
  });

  it('stopAll kills every open session and clears the session map', async () => {
    const instances = [pty(), pty()];
    let index = 0;
    const spawn = vi.fn(() => instances[index++]);
    const service = new ShellService(vi.fn(), spawn, async (path) => path);
    const first = await service.start();
    await service.start();

    await service.stopAll();
    expect(instances[0].kill).toHaveBeenCalledOnce();
    expect(instances[1].kill).toHaveBeenCalledOnce();
    await expect(service.write(first.session_id, 'x')).rejects.toThrow('shell session not found');
  });
});
