import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonlBuffer } from './jsonl';
import { PiClient, type PiClientHandlers } from './client';
import { SandboxManager } from '../app/sandbox/sandboxManager';
import type { PermissionProfileName } from '../app/permissionManager';

export interface PiProcessCommand {
  command: string;
  args: string[];
}

export interface PiProcessOptions extends PiClientHandlers {
  cwd: string;
  env?: Record<string, string>;
  sandbox?: SandboxManager;
  profile?: PermissionProfileName;
  workspaceRoot?: string;
}

class ChildTransport {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return Promise.resolve();
    this.child.kill();
    return Promise.resolve();
  }
}

export function spawnPiClient(workspace: string, processCommand: PiProcessCommand, options: PiProcessOptions): PiClient {
  const launch = options.sandbox?.prepare({
    profile: options.profile ?? (workspace === '__system__' ? 'automation' : 'workspace'),
    workspaceRoot: options.workspaceRoot ?? options.cwd,
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  }) ?? { profile: 'workspace' as const, cwd: options.cwd, env: { ...process.env, ...options.env }, network: 'none' as const, degraded: false };
  const child = spawn(processCommand.command, processCommand.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = new PiClient(workspace, new ChildTransport(child), options);
  const buffer = new JsonlBuffer();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => buffer.push(chunk).forEach((line) => client.handleLine(line)));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => options.onLog?.(`[pi:${workspace}] ${chunk.trim()}`));
  child.on('error', (error) => options.onLog?.(`[pi:${workspace}] process error: ${error.message}`));
  child.on('close', (code) => void client.close(code));
  return client;
}

export class PiManager {
  private readonly clients = new Map<string, PiClient>();

  constructor(private readonly command: PiProcessCommand, private readonly handlers: PiClientHandlers = {}, private readonly sandbox?: SandboxManager) {}

  get(workspace: string): PiClient | undefined {
    return this.clients.get(workspace);
  }

  all(): Array<[string, PiClient]> {
    return [...this.clients.entries()];
  }

  open(workspace: string, cwd: string, env?: Record<string, string>): PiClient {
    const existing = this.clients.get(workspace);
    if (existing) return existing;
    const client = spawnPiClient(workspace, this.command, { cwd, env, sandbox: this.sandbox, profile: workspace === '__system__' ? 'automation' : 'workspace', ...this.handlers });
    this.clients.set(workspace, client);
    return client;
  }

  openSystem(cwd: string, env?: Record<string, string>): PiClient {
    return this.open('__system__', cwd, { PI_SYSTEM_WORKER: '1', PI_DISABLE_PROJECT_CONTEXT: '1', ...env });
  }

  closeSystem(): Promise<void> { return this.close('__system__'); }

  async close(workspace: string): Promise<void> {
    const client = this.clients.get(workspace);
    if (!client) return;
    this.clients.delete(workspace);
    await client.close();
  }

  async closeAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close()));
  }
}
