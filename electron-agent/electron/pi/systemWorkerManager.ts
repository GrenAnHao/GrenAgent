import type { PiClient, PiClientHandlers } from './client';
import { spawnPiClient, type PiProcessCommand } from './manager';

export interface SystemWorkerTask { id: string; kind: string; input: unknown; maxAttempts?: number }
export interface SystemWorkerState { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; attempts: number; output?: unknown; error?: string }
interface WorkerOptions {
  processCommand: PiProcessCommand;
  cwd?: string;
  idleTimeoutMs?: number;
  maxAttempts?: number;
  createClient?: (workerKey: string, command: PiProcessCommand, options: { cwd: string; env: Record<string, string> } & PiClientHandlers) => PiClient;
}

export class SystemWorkerManager {
  private client?: PiClient;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private current?: string;
  private readonly states = new Map<string, SystemWorkerState>();

  constructor(private readonly options: WorkerOptions) {}

  async run(task: SystemWorkerTask): Promise<unknown> {
    const state = this.states.get(task.id) ?? { id: task.id, status: 'queued' as const, attempts: 0 };
    this.states.set(task.id, state);
    const maxAttempts = task.maxAttempts ?? this.options.maxAttempts ?? 1;
    while (state.attempts < maxAttempts) {
      state.attempts += 1; state.status = 'running'; this.current = task.id;
      try {
        const client = this.ensureClient();
        const output = await client.send({ type: 'service_task', kind: task.kind, input: task.input });
        state.status = 'completed'; state.output = output; this.current = undefined; this.scheduleIdleClose(); return output;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error); this.closeClient();
        if (state.attempts >= maxAttempts) { state.status = 'failed'; this.current = undefined; throw error; }
        state.status = 'queued';
      }
    }
    throw new Error('system task failed');
  }

  taskState(id: string): SystemWorkerState | undefined { const state = this.states.get(id); return state ? { ...state } : undefined; }

  close(): void { this.clearIdle(); this.closeClient(); }

  private ensureClient(): PiClient {
    if (this.client) { this.clearIdle(); return this.client; }
    const command = { command: this.options.processCommand.command, args: [...this.options.processCommand.args, '--system-worker'] };
    const create = this.options.createClient ?? ((key: string, value: PiProcessCommand, options: { cwd: string; env: Record<string, string> } & PiClientHandlers) => spawnPiClient(key, value, options));
    this.client = create('__system__', command, { cwd: this.options.cwd ?? process.cwd(), env: { PI_SYSTEM_WORKER: '1', PI_DISABLE_PROJECT_CONTEXT: '1' }, onExit: () => { if (this.current) this.closeClient(); } });
    return this.client;
  }

  private scheduleIdleClose(): void { this.clearIdle(); const timeout = this.options.idleTimeoutMs; if (timeout === undefined || timeout < 0) return; this.idleTimer = setTimeout(() => this.closeClient(), timeout); }
  private clearIdle(): void { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = undefined; }
  private closeClient(): void { this.clearIdle(); const client = this.client; this.client = undefined; if (client) void client.close(); }
}
