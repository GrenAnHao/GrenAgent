import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { realpath } from 'node:fs/promises';

const allowedCommands = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'pip', 'pip3', 'git', 'cargo', 'rustc', 'go', 'make', 'cmake', 'ls', 'dir', 'cat', 'echo', 'pwd']);

export type TerminalEvent =
  | { type: 'output'; data: string }
  | { type: 'exit'; exit_code: number };

export class TerminalService {
  constructor(private readonly emit: (event: 'terminal-output', payload: TerminalEvent) => void) {}

  async execute(command: string, args: string[], workspace?: string): Promise<void> {
    validateCommand(command);
    const cwd = workspace?.trim() ? await realpath(workspace) : undefined;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (data: Buffer) => this.emit('terminal-output', { type: 'output', data: data.toString('utf8') }));
      child.stderr.on('data', (data: Buffer) => this.emit('terminal-output', { type: 'output', data: data.toString('utf8') }));
      child.once('error', (error) => reject(new Error(`spawn failed: ${error.message}`)));
      child.once('close', (code) => {
        this.emit('terminal-output', { type: 'exit', exit_code: code ?? 1 });
        resolve();
      });
    });
  }
}

function validateCommand(command: string): void {
  const normalized = basename(command).toLowerCase().replace(/\.exe$/, '');
  if (allowedCommands.has(normalized)) return;
  throw new Error(`Command '${command}' not allowed. Permitted: ${[...allowedCommands].join(', ')}`);
}
