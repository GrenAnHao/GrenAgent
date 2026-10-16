import type { IndexProgress } from '@colbymchenry/codegraph';
import type { CodeGraphEngine } from './codeGraphEngine';

interface JobCallbacks {
  start(id: string): Promise<unknown>;
  complete(id: string): Promise<unknown>;
  fail(id: string, error: string): Promise<unknown>;
  cancelled(id: string): Promise<unknown>;
  stage(id: string, stage: string, processed?: number, total?: number): void;
}
const stages: Record<string, string> = { scanning: '扫描文件', parsing: '解析代码', resolving: '解析引用', linking: '关联符号' };

/** Keep terminal job persistence alive until the embedded SDK has finished using its DB. */
export class CodeGraphJobs {
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelling = new Set<string>();
  private closed = false;
  private shutdown?: Promise<void>;

  constructor(private readonly engine: Pick<CodeGraphEngine, 'runSync' | 'cancelSync' | 'close'>, private readonly callbacks: JobCallbacks) {}

  run(id: string, workspace: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('CodeGraph jobs are closed'));
    const task = this.execute(id, workspace).finally(() => { this.active.delete(id); this.cancelling.delete(id); });
    this.active.set(id, task);
    return task;
  }

  async cancel(id: string): Promise<void> {
    // 本进程没在跑这个任务（上一个进程留下的孤儿）：没有执行者会来确认取消，在这里直接落定。
    // 不落定的话任务永远停在「正在取消，等待确认」，重试和删除也一直不可用。
    if (!this.active.has(id)) { await this.callbacks.cancelled(id); return; }
    this.cancelling.add(id);
    try { await this.engine.cancelSync(id); }
    catch (error) { this.cancelling.delete(id); throw error; }
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true;
    for (const id of this.active.keys()) this.cancelling.add(id);
    this.shutdown = (async () => {
      await this.engine.close();
      await Promise.allSettled([...this.active.values()]);
    })();
    return this.shutdown;
  }

  private async execute(id: string, workspace: string): Promise<void> {
    try {
      await this.callbacks.start(id);
      if (!this.cancelling.has(id)) {
        await this.engine.runSync(id, workspace, (progress: IndexProgress) => {
          const stage = stages[progress.phase] ?? progress.phase;
          if (Number.isSafeInteger(progress.current) && Number.isSafeInteger(progress.total)
            && progress.current >= 0 && progress.total > 0 && progress.current <= progress.total) {
            this.callbacks.stage(id, stage, progress.current, progress.total);
          } else {
            this.callbacks.stage(id, stage);
          }
        });
      }
      if (this.cancelling.has(id)) await this.callbacks.cancelled(id);
      else await this.callbacks.complete(id);
    } catch (error) {
      if (this.cancelling.has(id) || (error instanceof Error && error.name === 'AbortError')) await this.callbacks.cancelled(id);
      else await this.callbacks.fail(id, error instanceof Error ? error.message : String(error));
    }
  }
}
