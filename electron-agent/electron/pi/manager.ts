import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonlBuffer } from './jsonl';
import { PiClient, type PiClientHandlers } from './client';
import { processRegistry, type ProcessRegistry } from '../app/processRegistry';

export interface PiProcessCommand {
  command: string;
  args: string[];
}

export type PiSpawn = (command: string, args: string[], options: {
  cwd: string;
  env: Record<string, string | undefined>;
  stdio: ['pipe', 'pipe', 'pipe'];
  windowsHide: boolean;
  detached: boolean;
}) => ChildProcessWithoutNullStreams;

export interface PiProcessOptions extends PiClientHandlers {
  cwd: string;
  env?: Record<string, string>;
  registry?: ProcessRegistry;
  spawnImpl?: PiSpawn;
  killTimeoutMs?: number;
}

class ChildTransport {
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly registry: ProcessRegistry,
    private readonly killTimeoutMs: number,
  ) {
    // writeLine receives write failures through its callback. The stream still
    // emits `error`, which must be observed to avoid an uncaught main-process error.
    this.child.stdin.on('error', () => {});
  }

  writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const closed = waitForClose(this.child, this.killTimeoutMs);
    // The pi sidecar exits by itself when its stdin pipe closes; ask it to
    // shut down gracefully before escalating to a process-tree kill.
    try {
      this.child.stdin.end();
    } catch {
      // stdin may already be destroyed.
    }
    await closed;
    if (this.child.exitCode === null && this.child.pid) {
      await this.registry.killTree(this.child.pid);
    }
  }
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('close', finish);
      child.removeListener('error', finish);
      resolve();
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('close', finish);
    child.once('error', finish);
  });
}

export function spawnPiClient(workspace: string, processCommand: PiProcessCommand, options: PiProcessOptions): PiClient {
  const spawnImpl = options.spawnImpl ?? (spawn as unknown as PiSpawn);
  const registry = options.registry ?? processRegistry;
  const child = spawnImpl(processCommand.command, processCommand.args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  registry.register(child, `pi:${workspace}`);
  const client = new PiClient(workspace, new ChildTransport(child, registry, options.killTimeoutMs ?? 3_000), options);
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

  constructor(
    private readonly command: PiProcessCommand,
    private readonly handlers: PiClientHandlers = {},
    private readonly options: Pick<PiProcessOptions, 'registry' | 'spawnImpl' | 'killTimeoutMs'> = {},
  ) {}

  get(workspace: string): PiClient | undefined {
    return this.clients.get(workspace);
  }

  all(): Array<[string, PiClient]> {
    return [...this.clients.entries()];
  }

  open(workspace: string, cwd: string, env?: Record<string, string>): PiClient {
    const existing = this.clients.get(workspace);
    if (existing) return existing;
    let spawned: PiClient | undefined;
    const client = spawnPiClient(workspace, this.command, {
      cwd,
      env,
      ...this.options,
      ...this.handlers,
      onExit: (ws, code) => {
        if (spawned && this.clients.get(ws) === spawned) this.clients.delete(ws);
        this.handlers.onExit?.(ws, code);
      },
    });
    spawned = client;
    this.clients.set(workspace, client);
    return client;
  }

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
