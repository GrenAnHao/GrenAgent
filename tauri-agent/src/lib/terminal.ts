import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface TerminalOutputEvent {
  type: 'output' | 'exit';
  data?: string;
  exit_code?: number;
  session_id?: string;
}

export const terminal = {
  run: (command: string, args: string[], workspace?: string) =>
    invoke<void>('execute_command', { command, args, workspace }),

  onOutput: (handler: (event: TerminalOutputEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalOutputEvent>('terminal-output', (e) => handler(e.payload)),

  shellStart: (workspace?: string) =>
    invoke<{ session_id: string }>('shell_start', { workspace }),

  shellWrite: (sessionId: string, data: string) =>
    invoke<void>('shell_write', { sessionId, data }),

  shellStop: (sessionId: string) => invoke<void>('shell_stop', { sessionId }),

  onShellOutput: (handler: (event: TerminalOutputEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalOutputEvent>('shell-output', (e) => handler(e.payload)),
};
