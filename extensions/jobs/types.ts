export type JobKind = "subagent";
export type JobStatus = "running" | "stopping" | "completed" | "failed" | "killed";
export type JobTerminalStatus = Extract<JobStatus, "completed" | "failed" | "killed">;

export interface JobOutcome {
  status: JobTerminalStatus;
  output?: string;
  error?: string;
}

export interface JobHooks {
  /** 同步、幂等；最终使 done 结算。 */
  cancel(reason?: string): void;
  /** 不应 reject；reject 视为 failed。 */
  done: Promise<JobOutcome>;
  /** 流式 kind 才有；缺省为终值 job。 */
  readOutput?(): string;
}

export interface JobStart {
  kind: JobKind;
  label: string;
  owner: string;
  workspace: string;
  outputLimitBytes?: number;
  run(): JobHooks;
}

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  label: string;
  owner: string;
  workspace: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  reported: boolean;
  outputLimitBytes: number;
  stream: boolean;
}

export type JobsErrorCode = "NOT_OWNER" | "NOT_FOUND";

export class JobsError extends Error {
  constructor(message: string, public readonly code: JobsErrorCode) {
    super(message);
    this.name = "JobsError";
  }
}

export const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024;
