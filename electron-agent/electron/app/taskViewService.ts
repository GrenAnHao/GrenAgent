import type { Job, JobStore } from '../agentData/jobStore';
import type { TaskViewStore } from '../agentData/taskViewStore';
import type { TaskDetail, TaskListInput, TaskPage, TaskRef, TaskRetryOptions, TaskRetryPreview, TaskView } from '../agentData/operationsContracts';

export interface TaskViewServiceOptions {
  views: TaskViewStore; jobs: JobStore;
  /** Read-only target/pending-source checks only; this must not resolve models or start a worker. */
  readTarget: (job: Job) => Promise<{ exists: boolean; busy: boolean }>;
  dispatch: (job: Job, metadata: { retryOf: string }, options?: TaskRetryOptions) => Promise<Job>;
  canCancel?: (job: Job) => boolean;
}
const retryKinds = new Set(['codegraph.sync']);

export class TaskViewService {
  private readonly pendingTargets = new Set<string>();
  constructor(private readonly options: TaskViewServiceOptions) {}

  async list(input: TaskListInput = {}): Promise<TaskPage> {
    const page = this.options.views.list(input);
    return { ...page, items: await Promise.all(page.items.map((item) => this.withCapabilities(item))) };
  }

  async read(ref: TaskRef): Promise<TaskDetail | undefined> {
    const detail = this.options.views.readDetail(ref);
    return detail ? this.withCapabilities(detail) : undefined;
  }

  async previewRetry(ref: TaskRef): Promise<TaskRetryPreview> {
    const job = this.requireRetryable(ref);
    await this.assertTarget(job);
    return this.preview(job);
  }

  async retry(ref: TaskRef, options?: TaskRetryOptions): Promise<TaskView> {
    const job = this.requireRetryable(ref);
    const key = this.targetKey(job);
    if (this.pendingTargets.has(key)) throw new Error('TASK_TARGET_BUSY');
    this.pendingTargets.add(key);
    try {
      await this.assertTarget(job);
      const preview = await this.preview(job);
      const current = this.requireRetryable(ref);
      if (this.targetKey(current) !== key) throw new Error('TASK_TARGET_CHANGED');
      await this.assertTarget(current);
      const final = this.requireRetryable(ref);
      if (this.targetKey(final) !== key) throw new Error('TASK_TARGET_CHANGED');
      const created = await this.options.dispatch(final, { retryOf: job.id }, options);
      const view = this.options.views.read({ source: 'user', id: created.id });
      if (!view) throw new Error('TASK_NOT_FOUND');
      return this.withCapabilities(view);
    } finally { this.pendingTargets.delete(key); }
  }

  private requireUserTask(ref: TaskRef): Job {
    if (!ref || ref.source !== 'user') throw new Error('TASK_READ_ONLY');
    const job = this.options.jobs.get(ref.id);
    if (!job) throw new Error('TASK_NOT_FOUND');
    return job;
  }

  private requireRetryable(ref: TaskRef): Job {
    const job = this.requireUserTask(ref);
    if (!this.retryable(job)) throw new Error('TASK_RETRY_UNAVAILABLE');
    if (!this.options.views.read(ref)?.capabilities.remove) throw new Error('TASK_TARGET_BUSY');
    return job;
  }

  private retryable(job: Job): boolean {
    return retryKinds.has(job.kind) && ['failed', 'cancelled'].includes(job.state) && Boolean(job.workspace.trim());
  }

  private targetKey(job: Job): string { return job.metadata?.target ? `${job.metadata.target.type}:${job.metadata.target.id}` : `project:${job.workspace}`; }

  private async assertTarget(job: Job): Promise<void> {
    const target = await this.options.readTarget(job);
    if (!target.exists) throw new Error('TASK_TARGET_NOT_FOUND');
    if (target.busy) throw new Error('TASK_TARGET_BUSY');
  }

  private async preview(job: Job): Promise<TaskRetryPreview> {
    const ref = { source: 'user' as const, id: job.id }; const view = this.options.views.read(ref)!;
    return { ref, resource: view.resource, label: view.label, callsModel: false };
  }

  private async withCapabilities<T extends TaskView>(view: T): Promise<T> {
    if (view.ref.source === 'system') return view;
    const job = this.options.jobs.get(view.ref.id); if (!job) return view;
    const cancel = retryKinds.has(job.kind) && ['pending', 'running'].includes(job.state) && !job.metadata?.cancellationRequested && this.options.canCancel?.(job) === true;
    let retry = false;
    if (this.retryable(job) && view.capabilities.remove && !this.pendingTargets.has(this.targetKey(job))) {
      try {
        await this.assertTarget(job);
        retry = true;
      } catch { /* Unavailable targets disable only this row, not the whole task page. */ }
    }
    return { ...view, capabilities: { ...view.capabilities, cancel, retry } };
  }
}
