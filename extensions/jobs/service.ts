// 进程内 job 注册表：不落盘，随 sidecar 进程生灭。owner 用 sessionId 围栏。
// 语义移植自 DSH packages/jobs/jobs-local/src/index.ts（LocalJobRegistry），去掉了 cordis scope / controller 分层：
// 本进程只有一套组合，jobs 扩展总是随 sandbox / multi-agent 一起加载。
import { startPump, type PumpHandle } from "./pump.js";
import { renderModelDelta } from "./render.js";
import { OutputRing } from "./ring.js";
import {
  DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER,
  DEFAULT_OUTPUT_LIMIT_BYTES,
  DEFAULT_PUMP_POLL_MS,
  DEFAULT_RETAIN_BYTES,
  DEFAULT_SETTLED_RETAIN_BYTES,
  JobsError,
  type JobAppendOptions,
  type JobConsume,
  type JobDoneInfo,
  type JobEvent,
  type JobHandle,
  type JobKind,
  type JobOutcome,
  type JobOutputRead,
  type JobOutputSource,
  type JobSettleCause,
  type JobSnapshot,
  type JobStart,
  type JobStatus,
} from "./types.js";

export type JobDoneListener = (snapshot: JobSnapshot, info: JobDoneInfo) => void;
export type JobEventListener = (event: JobEvent) => void;

/** 兼容读取：可选等待，然后一次消耗式读取渲染成文本。 */
export interface JobRead {
  status: JobStatus;
  /** 增量输出 + 结算后第一次读取的结果；可能为空。 */
  text: string;
  job: JobSnapshot;
}

export interface JobsConfig {
  maxConcurrentJobsPerOwner: number;
  retainBytes: number;
  settledRetainBytes: number;
  pumpPollMs: number;
}

interface ProducerState {
  progress: string | undefined;
  /** 已提交的记录；只在 run() 调用期间为 undefined。 */
  job: TrackedJob | undefined;
}

interface TrackedJob {
  id: string;
  kind: JobKind;
  label: string;
  owner: string;
  workspace: string;
  outputLimitBytes: number;
  cancel: (reason?: string) => void;
  status: JobStatus;
  ring: OutputRing;
  /** 模型的消耗式游标；readAt 从不移动它。 */
  modelCursor: number;
  resultDelivered: boolean;
  state: ProducerState;
  detail: string | undefined;
  output: string | undefined;
  error: string | undefined;
  startedAt: number;
  finishedAt: number | undefined;
  killReason: string | undefined;
  settleCause: JobSettleCause | undefined;
  settled: Promise<void>;
  markSettled: () => void;
  waitResolvers: Set<() => void>;
  pump: PumpHandle | undefined;
  spillPaths: (string | undefined)[];
  stream: boolean;
  reported: boolean;
}

function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "killed" || status === "failed";
}

function resultText(job: Pick<TrackedJob, "output" | "error">): string | undefined {
  // 失败 / 被终止的 job 输出常是空串：用 ?? 会把错误原因吞掉。
  if (job.output?.trim()) return job.output;
  return job.error ?? (job.output || undefined);
}

export class JobsService {
  private readonly store = new Map<string, TrackedJob>();
  private readonly counters = new Map<string, number>();
  private readonly listeners = new Set<JobDoneListener>();
  private readonly eventListeners = new Set<JobEventListener>();
  private config: JobsConfig;

  constructor(config: Partial<JobsConfig> = {}) {
    this.config = JobsService.resolve(config);
  }

  private static resolve(config: Partial<JobsConfig>): JobsConfig {
    return {
      maxConcurrentJobsPerOwner: config.maxConcurrentJobsPerOwner ?? DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER,
      retainBytes: config.retainBytes ?? DEFAULT_RETAIN_BYTES,
      settledRetainBytes: config.settledRetainBytes ?? DEFAULT_SETTLED_RETAIN_BYTES,
      pumpPollMs: config.pumpPollMs ?? DEFAULT_PUMP_POLL_MS,
    };
  }

  /** 测试用：换配置（例如更快的泵）。 */
  configure(config: Partial<JobsConfig>): void {
    this.config = JobsService.resolve(config);
  }

  /**
   * 预检（参数、并发上限）通过后调用 run 并原子注册。预检拒绝不留 id 也不留执行资源；
   * run 抛错则什么都不注册；run 返回后注册不再失败。
   */
  start(spec: JobStart): string {
    if (!spec.kind) throw new JobsError("invalid job kind: expected a non-empty string", "INVALID");
    if (!spec.label) throw new JobsError("invalid job label: expected a non-empty string", "INVALID");
    if (spec.outputLimitBytes !== undefined && (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)) {
      throw new JobsError(`invalid outputLimitBytes: expected a positive safe integer, got ${JSON.stringify(spec.outputLimitBytes)}`, "INVALID");
    }
    const active = this.activeJobCount(spec.owner);
    if (active >= this.config.maxConcurrentJobsPerOwner) {
      throw new JobsError(
        `background job limit reached for this owner (limit: ${this.config.maxConcurrentJobsPerOwner}); use job_kill to stop an unneeded job, wait for it to finish, then retry`,
        "LIMIT",
      );
    }

    // id 在 run 之前发出，生产方面才能带上它；run 抛错时这个序号直接跳过。
    const count = (this.counters.get(spec.kind) ?? 0) + 1;
    this.counters.set(spec.kind, count);
    const id = `${spec.kind}-${count}`;
    const ring = new OutputRing();
    const state: ProducerState = { progress: undefined, job: undefined };
    const handle: JobHandle = {
      id,
      append: (text, options) => this.appendRing(state, ring, text, options),
      updateProgress: (line) => this.updateProgress(state, line),
    };
    const hooks = spec.run(handle);

    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const job: TrackedJob = {
      id,
      kind: spec.kind,
      label: spec.label,
      owner: spec.owner,
      workspace: spec.workspace,
      outputLimitBytes: spec.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
      cancel: hooks.cancel.bind(hooks),
      status: "running",
      ring,
      modelCursor: 0,
      resultDelivered: false,
      state,
      detail: undefined,
      output: undefined,
      error: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      killReason: undefined,
      settleCause: undefined,
      settled,
      markSettled,
      waitResolvers: new Set(),
      pump: undefined,
      spillPaths: [],
      stream: (spec.output?.length ?? 0) > 0,
      reported: false,
    };
    // 绑定共享状态就是提交：run 期间暂存的写入已在环里，之后的写入都打到这条记录。
    state.job = job;
    this.store.set(id, job);
    // 先宣布注册再起泵：泵会同步排干一次并宣布 output，job 的第一个事件总是 registered。
    this.emit({ type: "registered", job: this.view(job) });

    const producerDone = Promise.resolve(hooks.done).then(
      (outcome) => outcome,
      (error: unknown): JobOutcome => {
        const message = String((error as Error)?.message ?? error);
        return { status: "failed", detail: message, error: message };
      },
    );
    if (spec.output !== undefined && spec.output.length > 0) {
      job.pump = startPump(
        spec.output.map((source) => this.guardSource(source)),
        {
          append: (text, options) => this.appendRing(state, ring, text, options),
          spill: (index, path) => {
            job.spillPaths[index] = path;
          },
        },
        this.config.pumpPollMs,
        Promise.race([producerDone, settled]),
      );
    }
    void producerDone.then(async (outcome) => {
      if (job.pump !== undefined) await job.pump.done;
      this.settle(job, outcome, job.settleCause ?? "producer");
    });
    return id;
  }

  /** 调用方自己的 job，按注册顺序。 */
  list(caller: string): JobSnapshot[] {
    return [...this.store.values()].filter((job) => job.owner === caller).map((job) => this.view(job));
  }

  /** 不做归属检查的投影：只给扩展内部（通知、测试）。 */
  snapshot(id: string): JobSnapshot | undefined {
    const job = this.store.get(id);
    return job ? this.view(job) : undefined;
  }

  get(id: string, caller: string): JobSnapshot {
    return this.view(this.expect(id, caller));
  }

  /** 从模型游标消耗到当前 total；结算后第一次读取带出终值结果一次。 */
  consume(id: string, caller: string): JobConsume {
    return this.consumeJob(this.expect(id, caller));
  }

  /** 非消耗读取：给观察者（界面），不动模型游标。 */
  readAt(id: string, from: number, caller: string): JobOutputRead {
    const job = this.expect(id, caller);
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new JobsError(`invalid output read offset: expected a non-negative safe integer, got ${JSON.stringify(from)}`, "INVALID");
    }
    return job.ring.readFrom(from);
  }

  /** 可选等待，然后一次消耗式读取，渲染成模型看到的文本。 */
  async read(
    id: string,
    caller: string,
    opts: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<JobRead> {
    const job = this.expect(id, caller);
    if (opts.wait && !isTerminal(job.status)) {
      await this.waitJob(job, Math.max(1, opts.timeoutMs ?? 60_000), opts.signal);
    }
    const read = this.consumeJob(job);
    const delta = renderModelDelta(read.chunks, read.lossy, read.job.ring.spillPaths ?? []);
    const text = read.result === undefined
      ? delta
      : `${delta}${delta.length > 0 && !delta.endsWith("\n") ? "\n" : ""}${read.result}`;
    return { status: read.job.status, text, job: read.job };
  }

  /** 等到结算或超时，不取消 job。调用方 abort 只在 job 存活时 reject。 */
  async wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<JobSnapshot> {
    return this.waitJob(this.expect(id, caller), timeoutMs, signal);
  }

  kill(id: string, caller: string, reason?: string): "requested" | "already-finished" {
    const job = this.expect(id, caller);
    if (isTerminal(job.status)) return "already-finished";
    // 先 cancel：抛错时生命周期状态不变。
    job.cancel(reason);
    job.status = "stopping";
    // 后写者胜：detail 报告最近一次 kill 意图。
    if (reason !== undefined) job.killReason = reason;
    job.settleCause = "kill";
    this.emit({ type: "stopping", job: this.view(job) });
    return "requested";
  }

  /** 移除一条已结算记录：给自己收了终态、从没把 id 交给模型的调用方。 */
  remove(id: string, caller: string): void {
    const job = this.expect(id, caller);
    if (!isTerminal(job.status)) {
      throw new JobsError(`job ${id} is still ${job.status}; kill it and wait for settlement before removing it`, "LIVE");
    }
    this.drop([job]);
  }

  markReported(id: string): void {
    const job = this.store.get(id);
    if (job) job.reported = true;
  }

  hasLive(owner: string): boolean {
    for (const job of this.store.values()) {
      if (job.owner === owner && !isTerminal(job.status)) return true;
    }
    return false;
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 全部生命周期与输出事件（给宿主界面跟随）。监听器抛错不影响注册表。 */
  onEvent(listener: JobEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 所有者销毁：取消其存活 job，等结算，再删记录。结算原因记为 teardown。 */
  async detachOwner(owner: string): Promise<void> {
    const owned = [...this.store.values()].filter((job) => job.owner === owner);
    this.cancelForTeardown(owned, "owner disposed");
    await Promise.all(owned.map((job) => job.settled));
    this.drop(owned);
  }

  private drop(jobs: readonly TrackedJob[]): void {
    for (const job of jobs) {
      this.store.delete(job.id);
      this.emit({ type: "removed", job: this.view(job) });
    }
  }

  private emit(event: JobEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        /* observer errors must not break the registry */
      }
    }
  }

  private emitOutput(job: TrackedJob): void {
    this.emit({ type: "output", id: job.id, owner: job.owner, total: job.ring.total });
  }

  private activeJobCount(owner: string): number {
    let count = 0;
    for (const job of this.store.values()) {
      if (job.owner === owner && !isTerminal(job.status)) count += 1;
    }
    return count;
  }

  private expect(id: string, caller: string): TrackedJob {
    const job = this.store.get(id);
    if (!job) throw new JobsError(`job ${id} 不存在（jobs 不跨进程保留）`, "NOT_FOUND");
    if (job.owner !== caller) throw new JobsError(`job ${id} 不属于当前会话`, "NOT_OWNER");
    return job;
  }

  private view(job: TrackedJob): JobSnapshot {
    const spillPaths = [...new Set(job.spillPaths.filter((path): path is string => path !== undefined))];
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      owner: job.owner,
      workspace: job.workspace,
      status: job.status,
      ...(job.state.progress !== undefined ? { progress: job.state.progress } : {}),
      ...(job.detail !== undefined ? { detail: job.detail } : {}),
      startedAt: job.startedAt,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      ...(job.output !== undefined ? { output: job.output } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      reported: job.reported,
      outputLimitBytes: job.outputLimitBytes,
      stream: job.stream,
      ring: {
        total: job.ring.total,
        earliest: job.ring.earliest,
        ...(spillPaths.length > 0 ? { spillPaths } : {}),
      },
    };
  }

  /** 终态读取是结算流裁到结算上限的时刻：结算时为它保留了全部未消费字节。 */
  private consumeJob(job: TrackedJob): JobConsume {
    const read = job.ring.readFrom(job.modelCursor);
    job.modelCursor = job.ring.total;
    const terminal = isTerminal(job.status);
    const result = terminal && !job.resultDelivered ? resultText(job) : undefined;
    if (terminal) {
      job.resultDelivered = true;
      // 模型已经收走终态：完成通知不必再发。
      job.reported = true;
      job.ring.trim(this.config.settledRetainBytes);
    }
    return {
      chunks: read.chunks,
      lossy: read.lossy,
      ...(result !== undefined ? { result } : {}),
      job: this.view(job),
    };
  }

  private async waitJob(job: TrackedJob, timeoutMs: number, signal?: AbortSignal): Promise<JobSnapshot> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new JobsError(`invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`, "INVALID");
    }
    if (!isTerminal(job.status)) {
      if (signal?.aborted) throw new Error("wait aborted");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          job.waitResolvers.delete(onSettled);
          signal?.removeEventListener("abort", onAbort);
        };
        const onSettled = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(new Error("wait aborted"));
        };
        // 超时先离开等待集合：之后的结算不算 awaited，照常通知。
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, timeoutMs);
        job.waitResolvers.add(onSettled);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return this.view(job);
  }

  /** 结算后的写入静默丢弃：强制结算可能先于生产方自己的结算。 */
  private appendRing(state: ProducerState, ring: OutputRing, text: string, options: JobAppendOptions | undefined): void {
    const job = state.job;
    if (job !== undefined && isTerminal(job.status)) return;
    if (!ring.append(text, options, this.config.retainBytes)) return;
    if (job !== undefined) this.emitOutput(job);
  }

  /** 源第一次抛错后当作耗尽：job 照常跑到自己的结算，不因泵失败卡住。 */
  private guardSource(source: JobOutputSource): JobOutputSource {
    let failed = false;
    return {
      ...(source.channel !== undefined ? { channel: source.channel } : {}),
      read: (fromByte) => {
        if (failed) return { text: "", nextOffset: fromByte, lossy: false };
        try {
          return source.read(fromByte);
        } catch {
          failed = true;
          return { text: "", nextOffset: fromByte, lossy: false };
        }
      },
    };
  }

  private updateProgress(state: ProducerState, line: string): void {
    const job = state.job;
    if (job !== undefined && isTerminal(job.status)) return;
    state.progress = line;
    if (job !== undefined) this.emit({ type: "progress", job: this.view(job) });
  }

  /**
   * 首次结算胜出：记录终态，释放等待方，再通知监听器。
   * 通知报告这次结算是否释放了仍在等的 wait（awaited），超时或 abort 的 wait 已经离开集合，不算。
   */
  private settle(job: TrackedJob, outcome: JobOutcome, cause: JobSettleCause): void {
    if (isTerminal(job.status)) return;
    job.status = outcome.status;
    const detail = outcome.detail;
    if (outcome.status === "killed" && job.killReason !== undefined) {
      job.detail = detail !== undefined ? `${detail}; ${job.killReason}` : job.killReason;
    } else if (detail !== undefined) {
      job.detail = detail;
    }
    job.state.progress = undefined;
    if (outcome.output !== undefined) job.output = outcome.output;
    if (outcome.error !== undefined) job.error = outcome.error;
    job.finishedAt = Date.now();
    // 结算即封流：裁到结算上限，但不低于模型游标尚未消费的字节。
    job.ring.trim(Math.max(this.config.settledRetainBytes, job.ring.total - job.modelCursor));
    const waiters = [...job.waitResolvers];
    job.waitResolvers.clear();
    for (const resolveWait of waiters) resolveWait();
    job.markSettled();
    const snap = this.view(job);
    const info: JobDoneInfo = { cause, awaited: waiters.length > 0 };
    for (const listener of this.listeners) {
      try {
        listener(snap, info);
      } catch {
        /* listener errors must not break settlement */
      }
    }
    this.emit({ type: "settled", job: snap, ...info });
    // 流随结算结束：最后一个 output 信号跟在结算之后，被它唤醒的观察者读到的是终态。
    this.emitOutput(job);
  }

  /** 销毁时逐个取消；cancel 抛错就强制记 failed，避免销毁死锁。 */
  private cancelForTeardown(jobs: TrackedJob[], reason: string): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) continue;
      job.settleCause = "teardown";
      try {
        job.cancel(reason);
        job.status = "stopping";
        this.emit({ type: "stopping", job: this.view(job) });
      } catch (error: unknown) {
        const detail = `cancel threw during teardown; work may be orphaned: ${String(error)}`;
        this.settle(job, { status: "failed", detail }, "teardown");
      }
    }
  }

  __reset(): void {
    this.store.clear();
    this.counters.clear();
    this.listeners.clear();
    this.eventListeners.clear();
    this.config = JobsService.resolve({});
  }
}

export const jobs = new JobsService();

export function __resetJobsForTest(): void {
  jobs.__reset();
}
