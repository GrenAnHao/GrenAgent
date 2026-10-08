// 把一条 bash 命令注册成 jobs 里的 bash job。移植自 DSH packages/shell/tool-bash/src/background.ts：
// 进程在 run() 里起（注册表准入之后），输出经 BashOutput.readFrom 由注册表泵进环，
// 非零退出记 completed + `exit code: N`，被取消记 killed，拿不到退出码记 failed。
// 前台命令也走这里（DSH：每次调用都是 job，前台只是等它），所以命令从起来那一刻就可见、可停，等待超时后原样转后台。
// 沙箱事实（拒绝、runner 失败）随退出码一起回来，照 DSH tool-pwsh 的 sandboxNotes 并进结算 detail。
// 与 DSH 的差别：沙箱 exec 把 stdout / stderr 合成一路回调，这里不分通道，顺序和前台卡片一致。
import { sandboxNotes } from "../_shared/sandbox/facts.js";
import type { ExecOptions } from "../_shared/sandbox/operations.js";
import type { FileSandboxMode, SandboxRunFacts } from "../_shared/sandbox/types.js";
import type { JobsService } from "../jobs/service.js";
import type { JobHooks, JobOutcome } from "../jobs/types.js";
import type { BashOutput } from "./bashOutput.js";

/** 模型每次读取 bash job 的上限，与前台 bash 的 50KB 截断一致。 */
export const BASH_JOB_OUTPUT_LIMIT_BYTES = 50 * 1024;
const LABEL_MAX_CHARS = 160;

/** 沙箱 exec 的结果：退出码加沙箱事实。测试替身可以不给事实。 */
export interface ExecResult {
  exitCode: number | null;
  sandbox?: SandboxRunFacts;
}

export type ExecFn = (command: string, cwd: string, options: ExecOptions) => Promise<ExecResult>;

/** 进程怎么结束的；前台按 pi 的格式渲染它。 */
export type BashExit =
  | { kind: "exited"; exitCode: number | null; sandbox?: SandboxRunFacts }
  | { kind: "aborted" }
  | { kind: "error"; error: unknown };

/** 被拒后要不要提示模型可以升权，按这次实际生效的模式算（bashTool 用 canOfferEscalation 给）。 */
export type OfferEscalation = (mode: FileSandboxMode) => boolean;
const NO_OFFER: OfferEscalation = () => false;

/**
 * 进程结束映射到通用 job 结局（DSH processOutcome）：非零退出照常是 completed，detail 报 exit code，
 * 沙箱拒绝的标记接在后面；沙箱 runner 没起来是 failed，detail 是 runner 标记和原因；拿不到退出码也是 failed。
 */
export function processOutcome(exit: BashExit, offerEscalation: OfferEscalation = NO_OFFER): JobOutcome {
  if (exit.kind === "aborted") return { status: "killed", detail: "killed before exit" };
  if (exit.kind === "error") {
    const message = exit.error instanceof Error ? exit.error.message : String(exit.error);
    return { status: "failed", detail: message };
  }
  const facts = exit.sandbox;
  if (facts?.runnerFailed) return { status: "failed", detail: sandboxNotes(facts, false).join(" ") };
  if (exit.exitCode === null) return { status: "failed", detail: "no exit code (the command did not run or was terminated)" };
  const notes = facts ? sandboxNotes(facts, offerEscalation(facts.mode)) : [];
  const code = `exit code: ${exit.exitCode}`;
  return { status: "completed", detail: notes.length > 0 ? `${code}; ${notes.join(" ")}` : code };
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
  /** 结算 detail 里要不要带升权提示；不给就不带。 */
  offerEscalation?: OfferEscalation;
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
  start: (signal: AbortSignal) => Promise<ExecResult>,
  output: BashOutput,
  onExit: (exit: BashExit) => void,
  onCancel: (reason?: string) => void,
  offerEscalation: OfferEscalation,
): JobHooks {
  const controller = new AbortController();
  const done: Promise<JobOutcome> = (async () => {
    let exit: BashExit;
    try {
      const { exitCode, sandbox } = await start(controller.signal);
      exit = controller.signal.aborted
        ? { kind: "aborted" }
        : { kind: "exited", exitCode, ...(sandbox ? { sandbox } : {}) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      exit = controller.signal.aborted || message === "aborted" ? { kind: "aborted" } : { kind: "error", error };
      if (exit.kind === "error") output.append(Buffer.from(`${message}\n`));
    }
    output.finish();
    await output.closeTempFile();
    onExit(exit);
    return processOutcome(exit, offerEscalation);
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
        req.offerEscalation ?? NO_OFFER,
      ),
  });
  const startedAt = deps.jobs.snapshot(id)?.startedAt ?? Date.now();
  return { id, startedAt, output: req.output, exited, stopped: () => stopped };
}
