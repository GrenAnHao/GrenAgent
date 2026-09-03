import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { realpath } from 'node:fs/promises';
import { processRegistry, type ProcessRegistry } from './processRegistry';
import { SandboxManager } from './sandbox/sandboxManager';

const allowedCommands = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'pip', 'pip3', 'git', 'cargo', 'rustc', 'go', 'make', 'cmake', 'ls', 'dir', 'cat', 'echo', 'pwd']);

export type TerminalEvent =
  | { type: 'output'; data: string }
  | { type: 'exit'; exit_code: number };

export class TerminalService {
  private readonly registry: ProcessRegistry;
  private readonly sandbox?: SandboxManager;

  constructor(
    private readonly emit: (event: 'terminal-output', payload: TerminalEvent) => void,
    registryOrSandbox: ProcessRegistry | SandboxManager = processRegistry,
    sandbox?: SandboxManager,
  ) {
    if ('prepare' in registryOrSandbox) {
      this.registry = processRegistry;
      this.sandbox = registryOrSandbox;
    } else {
      this.registry = registryOrSandbox;
      this.sandbox = sandbox;
    }
  }

  async execute(command: string, args: string[], workspace?: string, profile = 'workspace'): Promise<void> {
    validateCommand(command);
    const cwd = workspace?.trim() ? await realpath(workspace) : undefined;
    const launch = this.sandbox?.prepare({ profile, workspaceRoot: cwd, cwd, needsNetwork: commandNetworkRequirement(command, args) }) ?? { profile, cwd, env: process.env, network: 'none' as const, degraded: false };
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd: launch.cwd, env: launch.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.registry.register(child, `terminal:${basename(command)}`);
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

function commandNetworkRequirement(command: string, args: string[]): boolean {
  const value = `${command} ${args.join(' ')}`.toLowerCase();
  return /(^|\s)(curl|wget|npm|pnpm|yarn|pip|pip3)($|\s)/.test(value);
}

function validateCommand(command: string): void {
  const normalized = basename(command).toLowerCase().replace(/\.exe$/, '');
  if (allowedCommands.has(normalized)) return;
  throw new Error(`Command '${command}' not allowed. Permitted: ${[...allowedCommands].join(', ')}`);
}
