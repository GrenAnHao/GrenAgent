// 宿主侧的 job 观察者：把注册表事件合并成帧推给界面（对应 DSH api/job-controller 的 job.list / job.follow）。
// 只用非消耗的 readAt，模型的游标和通知状态都不受影响。
// 输出事件按 intervalMs 合并：构建日志一秒几千行，逐块推会压垮 IPC。
import type { JobsService } from "./service.js";
import type { JobSnapshot, JobStatus } from "./types.js";

export interface JobLiveView {
  id: string;
  kind: string;
  label: string;
  owner: string;
  workspace: string;
  status: JobStatus;
  progress?: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface JobFrame {
  job: JobLiveView;
  /** 自上一帧以来的输出；from 是这段文本的起始偏移，next 是续读偏移。 */
  delta?: { from: number; text: string; next: number; lossy: boolean };
  removed?: true;
}

export interface JobLiveSnapshot {
  job: JobLiveView;
  /** 当前保留的全部输出（从 earliest 开始）。 */
  text: string;
  next: number;
  /** 开头有字节已经不在内存里。 */
  lossy: boolean;
  spillPaths?: string[];
}

export function liveView(job: JobSnapshot): JobLiveView {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    owner: job.owner,
    workspace: job.workspace,
    status: job.status,
    ...(job.progress !== undefined ? { progress: job.progress } : {}),
    ...(job.detail !== undefined ? { detail: job.detail } : {}),
    startedAt: job.startedAt,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
  };
}

/** 晚加入的界面先拿一份快照，再接后续帧。startedAt 不对（进程重启后 id 复用）当作不存在。 */
export function jobLiveSnapshot(registry: JobsService, id: string, startedAt: number): JobLiveSnapshot | undefined {
  const job = registry.snapshot(id);
  if (!job || job.startedAt !== startedAt) return undefined;
  const read = registry.readAt(id, 0, job.owner);
  return {
    job: liveView(job),
    text: read.chunks.map((chunk) => chunk.text).join(""),
    next: read.next,
    lossy: read.lossy,
    ...(job.ring.spillPaths ? { spillPaths: job.ring.spillPaths } : {}),
  };
}

/** 用户在界面上停掉 job。不是模型请求的 kill，所以所有者照常收到结算通知。 */
export function killJobForUser(registry: JobsService, id: string, startedAt: number): "requested" | "already-finished" | "not-found" {
  const job = registry.snapshot(id);
  if (!job || job.startedAt !== startedAt) return "not-found";
  return registry.kill(id, job.owner, "cancelled by the user");
}

export interface JobObserver {
  stop(): void;
  /** 测试用：立刻发出待发的帧。 */
  flush(): void;
}

export function createJobObserver(
  registry: JobsService,
  emit: (frames: JobFrame[]) => void,
  opts: { intervalMs?: number } = {},
): JobObserver {
  const intervalMs = opts.intervalMs ?? 100;
  const cursors = new Map<string, number>();
  const pending = new Map<string, { removed?: JobSnapshot }>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.size === 0) return;
    const frames: JobFrame[] = [];
    for (const [id, mark] of pending) {
      if (mark.removed) {
        cursors.delete(id);
        frames.push({ job: liveView(mark.removed), removed: true });
        continue;
      }
      const job = registry.snapshot(id);
      if (!job) continue;
      const from = cursors.get(id) ?? 0;
      let delta: JobFrame["delta"];
      if (job.ring.total > from) {
        const read = registry.readAt(id, from, job.owner);
        const text = read.chunks.map((chunk) => chunk.text).join("");
        delta = { from: read.lossy ? job.ring.earliest : from, text, next: read.next, lossy: read.lossy };
        cursors.set(id, read.next);
      }
      frames.push({ job: liveView(job), ...(delta ? { delta } : {}) });
    }
    pending.clear();
    if (frames.length > 0) emit(frames);
  };

  const schedule = () => {
    timer ??= setTimeout(flush, intervalMs);
  };

  const unsubscribe = registry.onEvent((event) => {
    if (event.type === "output") {
      if (!pending.has(event.id)) pending.set(event.id, {});
      schedule();
      return;
    }
    if (event.type === "removed") {
      pending.set(event.job.id, { removed: event.job });
      schedule();
      return;
    }
    if (event.type === "registered") cursors.set(event.job.id, 0);
    if (!pending.has(event.job.id)) pending.set(event.job.id, {});
    // 生命周期变化（开始、停止中、结算）立即可见，不等合并窗口。
    flush();
  });

  return {
    stop: () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      cursors.clear();
    },
    flush,
  };
}
