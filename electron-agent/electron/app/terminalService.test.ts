import { describe, expect, it, vi } from 'vitest';
import { TerminalService } from './terminalService';

describe('TerminalService', () => {
  it('streams stdout and exit for a whitelisted command', async () => {
    const emit = vi.fn();
    const service = new TerminalService(emit);
    await service.execute(process.execPath, ['-e', 'console.log("terminal-ok")']);

    expect(emit).toHaveBeenCalledWith('terminal-output', expect.objectContaining({ type: 'output', data: expect.stringContaining('terminal-ok') }));
    expect(emit).toHaveBeenCalledWith('terminal-output', { type: 'exit', exit_code: 0 });
  });

  it('rejects commands outside the Rust whitelist and path-prefixed names', async () => {
    const service = new TerminalService(() => {});
    await expect(service.execute('powershell', [])).rejects.toThrow('not allowed');
    await expect(service.execute('C:\\evil\\hack.exe', [])).rejects.toThrow('not allowed');
  });
});
