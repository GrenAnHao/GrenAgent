import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonlBuffer } from './jsonl';
import { PiClient, type PiClientHandlers, type PiClientMetadata } from './client';
import { processRegistry, type ProcessRegistry } from '../app/processRegistry';
import { SandboxManager } from '../app/sandbox/sandboxManager';
import type { PermissionProfileName } from '../app/permissionManager';

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
  key?: string;
  logicalWorkspace?: string;
  sessionId?: string;
  sessionPath?: string;
  source?: 'interactive' | 'goal';
  registry?: ProcessRegistry;
  spawnImpl?: PiSpawn;
  killTimeoutMs?: number;
  sandbox?: SandboxManager;
  profile?: PermissionProfileName;
  workspaceRoot?: string;
}

export interface PiWorkerOpenOptions {
  key: string;
  cwd: string;
  logicalWorkspace: string;
  sessionId?: string;
  sessionPath?: string;
  source?: 'interactive' | 'goal';
  env?: Record<string, string>;
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
  const launch = options.sandbox?.prepare({
    profile: options.profile ?? (workspace === '__system__' ? 'automation' : 'workspace'),
    workspaceRoot: options.workspaceRoot ?? options.cwd,
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  }) ?? { profile: 'workspace' as const, cwd: options.cwd, env: { ...process.env, ...options.env }, network: 'none' as const, degraded: false };
  const args = options.sessionPath ? [...processCommand.args, '--session', options.sessionPath] : processCommand.args;
  const child = spawnImpl(processCommand.command, args, {
    cwd: launch.cwd ?? options.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  registry.register(child, `pi:${workspace}`);
  const metadata: PiClientMetadata | undefined = options.sessionId || options.sessionPath || options.source
    ? {
      key: options.key ?? workspace,
      logicalWorkspace: options.logicalWorkspace ?? workspace,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
      ...(options.source ? { source: options.source } : {}),
    }
    : undefined;
  const client = new PiClient(options.logicalWorkspace ?? workspace, new ChildTransport(child, registry, options.killTimeoutMs ?? 3_000), options, metadata);
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
    private readonly options: Pick<PiProcessOptions, 'registry' | 'spawnImpl' | 'killTimeoutMs'> & { sandbox?: SandboxManager } = {},
  ) {}

  get(workspace: string): PiClient | undefined {
    return this.clients.get(workspace);
  }

  all(): Array<[string, PiClient]> {
    return [...this.clients.entries()];
  }

  open(workspace: string, cwd: string, env?: Record<string, string>): PiClient;
  open(options: PiWorkerOpenOptions): PiClient;
  open(workspaceOrOptions: string | PiWorkerOpenOptions, cwd?: string, env?: Record<string, string>): PiClient {
    const spec: PiWorkerOpenOptions = typeof workspaceOrOptions === 'string'
      ? { key: workspaceOrOptions, cwd: cwd ?? workspaceOrOptions, logicalWorkspace: workspaceOrOptions, env }
      : workspaceOrOptions;
    const { key, logicalWorkspace } = spec;
    const existing = this.clients.get(key);
    if (existing) return existing;
    let spawned: PiClient | undefined;
    const client = spawnPiClient(key, this.command, {
      ...this.options,
      ...this.handlers,
      cwd: spec.cwd,
      env: spec.env,
      key,
      logicalWorkspace,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      ...(spec.sessionPath ? { sessionPath: spec.sessionPath } : {}),
      ...(spec.source ? { source: spec.source } : {}),
      sandbox: this.options.sandbox,
      profile: logicalWorkspace === '__system__' ? 'automation' : 'workspace',
      onExit: (ws, code, metadata) => {
        if (spawned && this.clients.get(key) === spawned) this.clients.delete(key);
        if (metadata) this.handlers.onExit?.(ws, code, metadata);
        else this.handlers.onExit?.(ws, code);
      },
    });
    spawned = client;
    this.clients.set(key, client);
    return client;
  }

  openGoalWorker(sessionId: string, workspace: string, sessionPath: string, cwd = workspace, env?: Record<string, string>): PiClient {
    return this.open({ key: `__goal__:${sessionId}`, cwd, logicalWorkspace: workspace, sessionId, sessionPath, source: 'goal', env });
  }

  closeGoalWorker(sessionId: string): Promise<void> { return this.close(`__goal__:${sessionId}`); }

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
