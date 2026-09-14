// 进程内 job 注册表：不落盘，随 sidecar 进程生灭。owner 用 sessionId 围栏。
import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  JobsError,
  type JobHooks,
  type JobKind,
  type JobSnapshot,
  type JobStart,
} from "./types.js";

type JobRecord = JobSnapshot & { hooks: JobHooks; waiters: Array<() => void> };

export type JobDoneListener = (snapshot: JobSnapshot) => void;

export interface JobRead {
  status: JobSnapshot["status"];
  text: string;
}

function toSnapshot(r: JobRecord): JobSnapshot {
  const { hooks: _h, waiters: _w, ...rest } = r;
  return { ...rest };
}

export class JobsService {
  private readonly records = new Map<string, JobRecord>();
  private readonly counters = new Map<JobKind, number>();
  private readonly listeners = new Set<JobDoneListener>();

  start(req: JobStart): string {
    const hooks = req.run();
    const n = (this.counters.get(req.kind) ?? 0) + 1;
    this.counters.set(req.kind, n);
    const id = `${req.kind}-${n}`;
    const record: JobRecord = {
      id,
      kind: req.kind,
      label: req.label,
      owner: req.owner,
      workspace: req.workspace,
      status: "running",
      startedAt: Date.now(),
      reported: false,
      outputLimitBytes: req.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
      stream: typeof hooks.readOutput === "function",
      hooks,
      waiters: [],
    };
    this.records.set(id, record);
    void hooks.done
      .then(
        (outcome) => this.settle(record, outcome.status, outcome.output, outcome.error),
        (e) => this.settle(record, "failed", undefined, String((e as Error)?.message ?? e)),
      );
    return id;
  }

  private settle(r: JobRecord, status: JobSnapshot["status"], output?: string, error?: string): void {
    if (r.finishedAt !== undefined) return;
    r.status = status;
    r.finishedAt = Date.now();
    if (output !== undefined) r.output = output;
    if (error !== undefined) r.error = error;
    for (const w of r.waiters.splice(0)) w();
    const snap = toSnapshot(r);
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        /* listener errors must not break settlement */
      }
    }
  }

  private owned(id: string, caller: string): JobRecord {
    const r = this.records.get(id);
    if (!r) throw new JobsError(`job ${id} 不存在（jobs 不跨进程保留）`, "NOT_FOUND");
    if (r.owner !== caller) throw new JobsError(`job ${id} 不属于当前会话`, "NOT_OWNER");
    return r;
  }

  snapshot(id: string): JobSnapshot | undefined {
    const r = this.records.get(id);
    return r ? toSnapshot(r) : undefined;
  }

  markReported(id: string): void {
    const r = this.records.get(id);
    if (r) r.reported = true;
  }

  async read(id: string, caller: string, opts: { wait?: boolean; timeoutMs?: number } = {}): Promise<JobRead> {
    const r = this.owned(id, caller);
    if (r.finishedAt === undefined && opts.wait) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, opts.timeoutMs ?? 60000));
        r.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        if (r.finishedAt !== undefined) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    if (r.finishedAt === undefined) {
      return { status: r.status, text: r.stream ? r.hooks.readOutput!() : "" };
    }
    r.reported = true;
    return { status: r.status, text: r.stream ? r.hooks.readOutput!() : (r.output ?? r.error ?? "") };
  }

  list(caller: string): JobSnapshot[] {
    return [...this.records.values()].filter((r) => r.owner === caller).map(toSnapshot);
  }

  kill(id: string, caller: string, reason?: string): "requested" | "already-finished" {
    const r = this.owned(id, caller);
    if (r.finishedAt !== undefined) return "already-finished";
    r.status = "stopping";
    r.hooks.cancel(reason);
    return "requested";
  }

  hasLive(owner: string): boolean {
    for (const r of this.records.values()) {
      if (r.owner === owner && r.finishedAt === undefined) return true;
    }
    return false;
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async detachOwner(owner: string): Promise<void> {
    const live = [...this.records.values()].filter((r) => r.owner === owner && r.finishedAt === undefined);
    for (const r of live) {
      r.status = "stopping";
      try {
        r.hooks.cancel("owner disposed");
      } catch {
        /* cancel 抛错不阻塞 dispose */
      }
    }
    await Promise.all(live.map((r) => r.hooks.done.catch(() => undefined)));
  }

  __reset(): void {
    this.records.clear();
    this.counters.clear();
    this.listeners.clear();
  }
}

export const jobs = new JobsService();

export function __resetJobsForTest(): void {
  jobs.__reset();
}
