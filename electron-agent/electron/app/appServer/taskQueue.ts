import { randomUUID } from 'node:crypto';
import type { AppEvent, ServiceTask, ServiceTaskCapability, ServiceTaskStatus } from './types';
import type { AgentDataStorage } from '../../agentData/storage';
import { EventBus } from './eventBus';
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
  execute: (task: ServiceTask & { threadId?: string; system: boolean }) => Promise<unknown>;
  eventBus?: Pick<EventBus, 'publish'>;
  now?: () => number;
}

export class TaskQueue {
  private readonly running = new Set<string>();
  private readonly waiters = new Map<string, { resolve: (task: ServiceTask) => void; reject: (error: Error) => void }>();
  private pumping = false;
  private readonly now: () => number;

  constructor(private readonly options: QueueOptions) { this.now = options.now ?? Date.now; }

  enqueue(input: QueueTaskInput): Promise<ServiceTask> {
    const parsed = this.options.registry.validate(input.kind, input.input);
    this.options.registry.assertCapabilities(input.kind, input.capabilities ?? []);
    const now = this.now();
    const task: ServiceTask = { id: input.id, kind: input.kind, sourceProjectId: input.sourceProjectId, sourceSessionId: input.sourceSessionId, status: 'queued', input: parsed, attempts: 0, createdAt: now, updatedAt: now };
    const db = this.options.storage.db;
    db.prepare('INSERT INTO service_tasks(id,kind,source_project_id,source_session_id,source_thread_id,is_system,status,input,output,attempts,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(task.id, task.kind, task.sourceProjectId ?? null, task.sourceSessionId ?? null, input.threadId ?? null, input.system ? 1 : 0, task.status, JSON.stringify(task.input), null, task.attempts, null, task.createdAt, task.updatedAt);
    this.publish('task.queued', task, input.threadId);
    const promise = new Promise<ServiceTask>((resolve, reject) => this.waiters.set(task.id, { resolve, reject }));
    this.pump();
    return promise;
  }

  cancel(id: string): ServiceTask | undefined {
    const task = this.get(id); if (!task || task.status !== 'queued') return task;
    const updated = this.writeStatus(task, 'cancelled');
    this.publish('task.cancelled', updated, this.threadId(id));
    this.waiters.get(id)?.resolve(updated); this.waiters.delete(id);
    return updated;
  }

  recoverRunning(): ServiceTask[] {
    const rows = this.options.storage.db.prepare("SELECT * FROM service_tasks WHERE status='running'").all() as Array<Record<string, unknown>>;
    const recovered = rows.map((row) => {
      const task = this.map(row); const updated = this.writeStatus(task, 'queued');
      this.publish('task.queued', updated, this.threadId(task.id)); return updated;
    });
    this.pump();
    return recovered;
  }

  get(id: string): ServiceTask | undefined {
    const row = this.options.storage.db.prepare('SELECT * FROM service_tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.map(row) : undefined;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => { this.pumping = false; this.startAvailable(); });
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
    this.publish('task.started', started, threadId);
    try {
      const definition = this.options.registry.get(task.kind);
      const output = this.options.registry.validateOutput(task.kind, await withTimeout(
        this.options.execute({ ...started, threadId, system }),
        definition?.timeoutMs ?? 30_000,
      ));
      const completed = this.writeStatus(started, 'completed', { output });
      this.publish('task.completed', completed, threadId); this.waiters.get(task.id)?.resolve(completed); this.waiters.delete(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (started.attempts < (this.options.registry.get(task.kind)?.maxAttempts ?? 1)) {
        const queued = this.writeStatus(started, 'queued', { error: message });
        this.publish('task.queued', queued, threadId);
      } else {
        const failed = this.writeStatus(started, 'failed', { error: message });
        this.publish('task.failed', failed, threadId); this.waiters.get(task.id)?.resolve(failed); this.waiters.delete(task.id);
      }
    } finally { this.running.delete(task.id); this.pump(); }
  }

  private writeStatus(task: ServiceTask, status: ServiceTaskStatus, patch: { attempts?: number; output?: unknown; error?: string } = {}): ServiceTask {
    const updatedAt = this.now();
    this.options.storage.db.prepare('UPDATE service_tasks SET status=?,output=?,attempts=?,error=?,updated_at=? WHERE id=?').run(status, patch.output === undefined ? task.output === undefined ? null : JSON.stringify(task.output) : JSON.stringify(patch.output), patch.attempts ?? task.attempts, patch.error ?? task.error ?? null, updatedAt, task.id);
    return { ...task, status, attempts: patch.attempts ?? task.attempts, output: patch.output ?? task.output, error: patch.error ?? task.error, updatedAt };
  }

  private map(row: Record<string, unknown>): ServiceTask { return { id: String(row.id), kind: String(row.kind), sourceProjectId: row.source_project_id == null ? undefined : String(row.source_project_id), sourceSessionId: row.source_session_id == null ? undefined : String(row.source_session_id), status: String(row.status) as ServiceTaskStatus, input: JSON.parse(String(row.input)), output: row.output == null ? undefined : JSON.parse(String(row.output)), attempts: Number(row.attempts), error: row.error == null ? undefined : String(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
  private threadId(id: string): string | undefined { const row = this.options.storage.db.prepare('SELECT source_thread_id FROM service_tasks WHERE id=?').get(id) as { source_thread_id?: string } | undefined; return row?.source_thread_id ?? undefined; }
  private isSystem(id: string): boolean { const row = this.options.storage.db.prepare('SELECT is_system FROM service_tasks WHERE id=?').get(id) as { is_system?: number } | undefined; return row?.is_system === 1; }
  private publish(type: AppEvent['type'], task: ServiceTask, threadId?: string): void { this.options.eventBus?.publish({ id: randomUUID(), type, timestamp: this.now(), projectId: task.sourceProjectId, threadId, data: task }); }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`service task timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
