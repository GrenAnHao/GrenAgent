// 后台 job 的类型。语义按 DSH packages/jobs（jobs / jobs-local / tool-jobs）移植：
// 每个 job 一个有界输出环，模型用消耗式游标读，观察者按绝对偏移读，互不干扰。
// 子代理不再走 jobs（结果经 subagent-settled 通知交回），只剩 bash。
export type JobKind = "bash";
export type JobStatus = "running" | "stopping" | "completed" | "failed" | "killed";
export type JobTerminalStatus = Extract<JobStatus, "completed" | "failed" | "killed">;

/** stdout / stderr 进模型读取；log 只给观察者，从不进模型。 */
export type JobChannel = "stdout" | "stderr" | "log";

/** 结算原因：生产方自己结束、被 kill、或所有者/服务销毁（没人能读通知了）。 */
export type JobSettleCause = "producer" | "kill" | "teardown";

export interface JobOutcome {
  status: JobTerminalStatus;
  /** 终态原因，渲染进状态行（`exit code: 3`）；被 kill 时合并 kill 原因。 */
  detail?: string;
}

export interface JobAppendOptions {
  channel?: JobChannel;
  /** 这一块之前有字节丢了（生产方或保留上限）。 */
  gapBefore?: true;
}

/** 输出环里的一块：绝对偏移、文本、通道、丢失标记。偏移一经分配不再移动。 */
export interface JobChunk {
  readonly at: number;
  readonly text: string;
  readonly channel?: JobChannel;
  readonly gapBefore?: true;
}

/** 一次非消耗读取。 */
export interface JobOutputRead {
  chunks: readonly JobChunk[];
  /** 下次续读的偏移，即环当前 total；总在块边界上。 */
  next: number;
  /** from 低于最早保留字节，chunks 之前有字节缺失。 */
  lossy: boolean;
}

/** 拉取源的一次增量读取。 */
export interface JobSourceRead {
  text: string;
  nextOffset: number;
  lossy: boolean;
  /** 源当前保有完整流的文件路径；每次读取都报告，某次不报即撤回。 */
  spillPath?: string;
}

/** 注册表按自己的节奏泵进输出环的拉取源；结算前再排干一次。 */
export interface JobOutputSource {
  channel?: JobChannel;
  read(fromByte: number): JobSourceRead;
}

/** 生产方面：交给 JobStart.run，整个 job 生命期有效。结算后的写入丢弃而不抛错。 */
export interface JobHandle {
  readonly id: string;
  append(text: string, options?: JobAppendOptions): void;
  updateProgress(line: string): void;
}

export interface JobHooks {
  /** 同步、幂等；最终使 done 结算。 */
  cancel(reason?: string): void;
  /** 生产方释放资源后才 resolve。不应 reject；reject 视为 failed。 */
  done: Promise<JobOutcome>;
}

export interface JobStart {
  kind: JobKind;
  label: string;
  owner: string;
  workspace: string;
  /** 模型侧每次完整读取 / 通知的 UTF-8 字节上限。 */
  outputLimitBytes?: number;
  /** 注册表泵送的拉取源；没有则由生产方自己 append。 */
  output?: readonly JobOutputSource[];
  /** 预检通过后调用一次；抛错则什么都不注册。 */
  run(job: JobHandle): JobHooks;
}

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  label: string;
  owner: string;
  workspace: string;
  status: JobStatus;
  /** 运行中的进度行；结算时清掉。 */
  progress?: string;
  /** 终态原因（合并了 kill 原因）。 */
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  reported: boolean;
  outputLimitBytes: number;
  /** 输出环坐标与完整流文件。 */
  ring: { total: number; earliest: number; spillPaths?: string[] };
}

/** 一次消耗式读取（模型游标）。 */
export interface JobConsume {
  chunks: readonly JobChunk[];
  lossy: boolean;
  job: JobSnapshot;
}

export interface JobDoneInfo {
  cause: JobSettleCause;
  /** 这次结算释放了一个仍在等的 wait：等待方已经拿到终态，通知可以跳过。 */
  awaited: boolean;
}

/**
 * 注册表事件（DSH JobEvent）。生命周期事件带提交后的投影；output 只带 id 与新的 total，
 * 观察者从自己的游标 readAt，注册表从不推负载。
 */
export type JobEvent =
  | { type: "registered" | "progress" | "stopping" | "removed"; job: JobSnapshot }
  | { type: "settled"; job: JobSnapshot; cause: JobSettleCause; awaited: boolean }
  | { type: "output"; id: string; owner: string; total: number };

export type JobsErrorCode = "NOT_OWNER" | "NOT_FOUND" | "LIMIT" | "INVALID" | "LIVE";

export class JobsError extends Error {
  constructor(message: string, public readonly code: JobsErrorCode) {
    super(message);
    this.name = "JobsError";
  }
}

/** 通知 / 模型读取的默认字节上限。 */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024;
/** 每个所有者 running + stopping 的上限。 */
export const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER = 10;
/** 运行期每个环的保留量。 */
export const DEFAULT_RETAIN_BYTES = 256 * 1024;
/** 结算后的保留量；模型尚未读的字节保留到它首次终态读取。 */
export const DEFAULT_SETTLED_RETAIN_BYTES = 16 * 1024;
/** 拉取源轮询间隔。 */
export const DEFAULT_PUMP_POLL_MS = 150;
