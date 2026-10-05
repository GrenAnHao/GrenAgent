// 把一条 bash 命令注册成 jobs 里的 bash job。移植自 DSH packages/shell/tool-bash/src/background.ts：
// 进程在 run() 里起（注册表准入之后），输出经 BashOutput.readFrom 由注册表泵进环，
// 非零退出记 completed + `exit code: N`，被取消记 killed，拿不到退出码记 failed。
// 前台命令也走这里（DSH：每次调用都是 job，前台只是等它），所以命令从起来那一刻就可见、可停，等待超时后原样转后台。
// 与 DSH 的差别：沙箱 exec 把 stdout / stderr 合成一路回调，这里不分通道，顺序和前台卡片一致。
import type { ExecOptions } from "../_shared/sandbox/operations.js";
import type { JobsService } from "../jobs/service.js";
import type { JobHooks, JobOutcome } from "../jobs/types.js";
import type { BashOutput } from "./bashOutput.js";

/** 模型每次读取 bash job 的上限，与前台 bash 的 50KB 截断一致。 */
export const BASH_JOB_OUTPUT_LIMIT_BYTES = 50 * 1024;
const LABEL_MAX_CHARS = 160;

export type ExecFn = (command: string, cwd: string, options: ExecOptions) => Promise<{ exitCode: number | null }>;

/** 进程怎么结束的；前台按 pi 的格式渲染它。 */
export type BashExit =
  | { kind: "exited"; exitCode: number | null }
  | { kind: "aborted" }
  | { kind: "error"; error: unknown };

/**
 * 进程结束映射到通用 job 结局（DSH processOutcome）：非零退出照常是 completed，detail 报 exit code，
 * 和前台渲染一样由模型决定怎么处理；拿不到退出码（沙箱 runner 没起来、壳被杀）是 failed。
 */
export function processOutcome(exit: BashExit): JobOutcome {
  if (exit.kind === "aborted") return { status: "killed", detail: "killed before exit" };
  if (exit.kind === "error") {
    const message = exit.error instanceof Error ? exit.error.message : String(exit.error);
    return { status: "failed", detail: message };
  }
  if (exit.exitCode === null) return { status: "failed", detail: "no exit code (the command did not run or was terminated)" };
  return { status: "completed", detail: `exit code: ${exit.exitCode}` };
}

/** job 标签：命令压成一行，过长截断。通知首行和 job_list 都用它。 */
export function jobLabel(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX_CHARS ? `${flat.slice(0, LABEL_MAX_CHARS - 1)}…` : flat;
}

export interface BashJobRequest {
  command: string;
  cwd: string;
  owner: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  output: BashOutput;
  /** 每块输出到达后调用（前台卡片的节流更新）。 */
  onData?: () => void;
}

export interface StartedBashJob {
  id: string;
  startedAt: number;
  output: BashOutput;
  /** 进程结算、输出 finish、临时文件关闭之后 resolve。 */
  exited: Promise<BashExit>;
  /** 外部 kill（界面、job_kill）给的原因；前台据此告诉模型别重试。 */
  stopped(): string | undefined;
}

/**
 * 准入之后异步起进程，不暴露半成品（DSH processJob）。done 在进程结算、日志关闭之后才 resolve。
 */
function processJob(
  start: (signal: AbortSignal) => Promise<{ exitCode: number | null }>,
  output: BashOutput,
  onExit: (exit: BashExit) => void,
  onCancel: (reason?: string) => void,
): JobHooks {
  const controller = new AbortController();
  const done: Promise<JobOutcome> = (async () => {
    let exit: BashExit;
    try {
      const { exitCode } = await start(controller.signal);
      exit = controller.signal.aborted ? { kind: "aborted" } : { kind: "exited", exitCode };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      exit = controller.signal.aborted || message === "aborted" ? { kind: "aborted" } : { kind: "error", error };
      if (exit.kind === "error") output.append(Buffer.from(`${message}\n`));
    }
    output.finish();
    await output.closeTempFile();
    onExit(exit);
    return processOutcome(exit);
  })();
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return;
      onCancel(reason);
      controller.abort(reason);
    },
    done,
  };
}

/** 注册并启动。准入失败（并发上限、参数）直接抛，什么都不起。 */
export function startBashJob(deps: { jobs: JobsService; exec: ExecFn }, req: BashJobRequest): StartedBashJob {
  let stopped: string | undefined;
  let resolveExit!: (exit: BashExit) => void;
  const exited = new Promise<BashExit>((resolve) => {
    resolveExit = resolve;
  });
  const id = deps.jobs.start({
    kind: "bash",
    label: jobLabel(req.command),
    owner: req.owner,
    workspace: req.workspace,
    outputLimitBytes: BASH_JOB_OUTPUT_LIMIT_BYTES,
    output: [{ read: (fromByte) => req.output.readFrom(fromByte) }],
    run: () =>
      processJob(
        (signal) =>
          deps.exec(req.command, req.cwd, {
            onData: (data) => {
              req.output.append(data);
              req.onData?.();
            },
            signal,
            env: req.env,
          }),
        req.output,
        resolveExit,
        (reason) => {
          stopped = reason;
        },
      ),
  });
  const startedAt = deps.jobs.snapshot(id)?.startedAt ?? Date.now();
  return { id, startedAt, output: req.output, exited, stopped: () => stopped };
}
