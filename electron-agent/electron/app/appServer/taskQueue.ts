import { randomUUID } from 'node:crypto';
import type { ServiceTask, ServiceTaskCapability, ServiceTaskHooks, ServiceTaskStatus, ServiceTaskUsageReport } from './types';
import type { AgentDataStorage } from '../../agentData/storage';
import { ServiceTaskRegistry } from './serviceTaskRegistry';

export interface QueueTaskInput {
  id: string;
  kind: string;
  input: unknown;
  threadId?: string;
  sourceProjectId?: string;
  sourceSessionId?: string;
  capabilities?: ServiceTaskCapability[];
  system?: boolean;
}

interface QueueOptions {
  storage: AgentDataStorage;
  registry: ServiceTaskRegistry;
  execute: (task: ServiceTask & { threadId?: string; system: boolean }, hooks: ServiceTaskHooks) => Promise<unknown>;
  onSettled?: (task: ServiceTask) => void;
  now?: () => number;
}

export class TaskQueue {
  private readonly running = new Set<string>();
  private readonly waiters = new Map<string, { resolve: (task: ServiceTask) => void; reject: (error: Error) => void }>();
  private pumping = false;
  private stopped = false;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly options: QueueOptions) { this.now = options.now ?? Date.now; }

  enqueue(input: QueueTaskInput): Promise<ServiceTask> {
    if (this.stopped) return Promise.reject(new Error('service task queue is stopped'));
    const parsed = this.options.registry.validate(input.kind, input.input);
    this.options.registry.assertCapabilities(input.kind, input.capabilities ?? []);
    const now = this.now();
    const task: ServiceTask = { id: input.id, kind: input.kind, sourceProjectId: input.sourceProjectId, sourceSessionId: input.sourceSessionId, status: 'queued', input: parsed, attempts: 0, createdAt: now, updatedAt: now };
    const db = this.options.storage.db;
    db.prepare('INSERT INTO service_tasks(id,kind,source_project_id,source_session_id,source_thread_id,is_system,status,input,output,attempts,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(task.id, task.kind, task.sourceProjectId ?? null, task.sourceSessionId ?? null, input.threadId ?? null, input.system ? 1 : 0, task.status, JSON.stringify(task.input), null, task.attempts, null, task.createdAt, task.updatedAt);
    const promise = new Promise<ServiceTask>((resolve, reject) => this.waiters.set(task.id, { resolve, reject }));
    this.pump();
    return promise;
  }

  cancel(id: string): ServiceTask | undefined {
    const task = this.get(id); if (!task || task.status !== 'queued') return task;
    const updated = this.writeStatus(task, 'cancelled');
    this.notifySettled(updated);
    this.waiters.get(id)?.resolve(updated); this.waiters.delete(id);
    return updated;
  }

  recoverRunning(): ServiceTask[] {
    const rows = this.options.storage.db.prepare("SELECT * FROM service_tasks WHERE status='running'").all() as Array<Record<string, unknown>>;
    const recovered = rows.map((row) => {
      const task = this.map(row); return this.writeStatus(task, 'queued');
    });
    this.pump();
    return recovered;
  }

  get(id: string): ServiceTask | undefined {
    const row = this.options.storage.db.prepare('SELECT * FROM service_tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.map(row) : undefined;
  }

  /** Stop dispatching, but let active executors persist their terminal results. */
  stop(): void {
    this.stopped = true;
    for (const [id, waiter] of this.waiters) if (!this.running.has(id)) {
      const task = this.get(id);
      if (task) waiter.resolve(task);
      else waiter.reject(new Error('service task queue is stopped'));
      this.waiters.delete(id);
    }
  }
  isIdle(): boolean { return this.running.size === 0; }
  whenIdle(): Promise<void> { return this.isIdle() ? Promise.resolve() : new Promise((resolve) => this.idleWaiters.push(resolve)); }

  findPending(kind: string, matches: (task: ServiceTask) => boolean): ServiceTask | undefined {
    const rows = this.options.storage.db.prepare("SELECT * FROM service_tasks WHERE kind=? AND status IN ('queued','running') ORDER BY created_at ASC").all(kind) as Array<Record<string, unknown>>;
    return rows.map((row) => this.map(row)).find(matches);
  }

  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    queueMicrotask(() => { this.pumping = false; if (!this.stopped) this.startAvailable(); });
  }

  private startAvailable(): void {
    const rows = this.options.storage.db.prepare("SELECT * FROM service_tasks WHERE status='queued' ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
    const activeThreads = new Set<string>();
    for (const id of this.running) { const thread = this.threadId(id); if (thread) activeThreads.add(thread); }
    const systemRunning = [...this.running].some((id) => this.isSystem(id));
    let startedSystem = systemRunning;
    for (const row of rows) {
      const task = this.map(row); const threadId = this.threadId(task.id); const system = this.isSystem(task.id);
      if (this.running.has(task.id) || (threadId && activeThreads.has(threadId)) || (system && startedSystem)) continue;
      this.running.add(task.id); if (threadId) activeThreads.add(threadId); if (system) startedSystem = true;
      void this.run(task, threadId, system);
    }
  }

  private async run(task: ServiceTask, threadId: string | undefined, system: boolean): Promise<void> {
    const started = this.writeStatus(task, 'running', { attempts: task.attempts + 1 });
    try {
      const definition = this.options.registry.get(task.kind);
      const output = this.options.registry.validateOutput(task.kind, await withTimeout(
        this.options.execute({ ...started, threadId, system }, { onUsage: (report) => this.recordUsage(task.id, report) }),
        definition?.timeoutMs ?? 30_000,
      ));
      const completed = this.writeStatus(started, 'completed', { output });
      this.notifySettled(completed);
      this.waiters.get(task.id)?.resolve(completed); this.waiters.delete(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.stopped && isRetryableError(message) && started.attempts < (this.options.registry.get(task.kind)?.maxAttempts ?? 1)) {
        this.writeStatus(started, 'queued', { error: message });
      } else {
        const failed = this.writeStatus(started, 'failed', { error: message });
        this.notifySettled(failed);
        this.waiters.get(task.id)?.resolve(failed); this.waiters.delete(task.id);
      }
    } finally {
      this.running.delete(task.id); this.pump();
      if (this.isIdle()) for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private writeStatus(task: ServiceTask, status: ServiceTaskStatus, patch: { attempts?: number; output?: unknown; error?: string } = {}): ServiceTask {
    const updatedAt = this.now();
    this.options.storage.db.prepare('UPDATE service_tasks SET status=?,output=?,attempts=?,error=?,updated_at=? WHERE id=?').run(status, patch.output === undefined ? task.output === undefined ? null : JSON.stringify(task.output) : JSON.stringify(patch.output), patch.attempts ?? task.attempts, patch.error ?? task.error ?? null, updatedAt, task.id);
    return { ...task, status, attempts: patch.attempts ?? task.attempts, output: patch.output ?? task.output, error: patch.error ?? task.error, updatedAt };
  }

  /** 累加到同一行：重试与失败的那次调用同样花了钱。记账失败不能影响任务本身。 */
  private recordUsage(id: string, report: ServiceTaskUsageReport): void {
    try {
      const usage = (report.usage && typeof report.usage === 'object' ? report.usage : {}) as Record<string, unknown>;
      this.options.storage.db.prepare(`UPDATE service_tasks SET
        input_tokens=COALESCE(input_tokens,0)+?, output_tokens=COALESCE(output_tokens,0)+?,
        cache_read_tokens=COALESCE(cache_read_tokens,0)+?, cache_write_tokens=COALESCE(cache_write_tokens,0)+?,
        model=COALESCE(?,model) WHERE id=?`)
        .run(tokens(usage.input), tokens(usage.output), tokens(usage.cacheRead), tokens(usage.cacheWrite), report.model ?? null, id);
    } catch { /* 观测失败不改变任务结果 */ }
  }

  private notifySettled(task: ServiceTask): void {
    try { this.options.onSettled?.(task); } catch { /* A notification cannot change the persisted terminal result. */ }
  }

  private map(row: Record<string, unknown>): ServiceTask { return { id: String(row.id), kind: String(row.kind), sourceProjectId: row.source_project_id == null ? undefined : String(row.source_project_id), sourceSessionId: row.source_session_id == null ? undefined : String(row.source_session_id), status: String(row.status) as ServiceTaskStatus, input: JSON.parse(String(row.input)), output: row.output == null ? undefined : JSON.parse(String(row.output)), attempts: Number(row.attempts), error: row.error == null ? undefined : String(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
  private threadId(id: string): string | undefined { const row = this.options.storage.db.prepare('SELECT source_thread_id FROM service_tasks WHERE id=?').get(id) as { source_thread_id?: string } | undefined; return row?.source_thread_id ?? undefined; }
  private isSystem(id: string): boolean { const row = this.options.storage.db.prepare('SELECT is_system FROM service_tasks WHERE id=?').get(id) as { is_system?: number } | undefined; return row?.is_system === 1; }
}

/**
 * 模型正常结束却没给任何文本（formatNonStream 的 `empty content`）是确定性失败：同一份 prompt 重发一遍
 * 基本还是空，只会把整份载荷再付一次钱。provider 报错（限流、网络）不在此列，照旧重试。
 */
export function isRetryableError(message: string): boolean {
  return !message.startsWith('empty content');
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`service task timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
