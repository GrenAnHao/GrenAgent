import { invoke, listen, type UnlistenFn } from '../platform/runtime';

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

  shellResize: (sessionId: string, rows: number, cols: number) =>
    invoke<void>('shell_resize', { sessionId, rows, cols }),

  shellStop: (sessionId: string) => invoke<void>('shell_stop', { sessionId }),

  onShellOutput: (handler: (event: TerminalOutputEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalOutputEvent>('shell-output', (e) => handler(e.payload)),
};
