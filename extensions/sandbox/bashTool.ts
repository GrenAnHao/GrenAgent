// GrenAgent 自有的 bash 工具，替换 pi 的 createBashToolDefinition。
//
// 对外契约照 pi 1.0.2（dist/core/tools/bash.js）保持：工具名 bash、参数 command / timeout、
// 结构化结果 { output, truncated, full_output_path, exit_code, wall_time_seconds }、给模型的文本格式
// （截断提示里的 `Full output: <路径>`、`Command exited with code N` 标 isError、`Command aborted`）、
// 流式更新只放尾部文本、PI_* 会话环境变量。升级 pi 时对照那份文件的 diff 决定是否跟进；bashTool.test.ts 钉住这些格式。
//
// 执行模型照 DSH packages/shell/tool-bash：每次调用都先注册成 jobs 里的 bash job，前台只是等它。
// 等到 timeout（默认 120 秒）仍在跑就原样转后台，返回已有输出和 job id，模型继续干活、结束时收通知；
// run_in_background 直接返回 id。会话 id 缺失或准入被拒时退回 pi 原来的前台执行（timeout 到点杀进程）。
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { fitWithSuffix, renderModelDelta } from "../jobs/render.js";
import type { JobsService } from "../jobs/service.js";
import { BashOutput, type BashSnapshot } from "./bashOutput.js";
import { BASH_JOB_OUTPUT_LIMIT_BYTES, startBashJob, type BashExit, type ExecFn, type StartedBashJob } from "./bashJob.js";

/** pi 的流式更新节流（renderers/bash.js 的 BASH_UPDATE_THROTTLE_MS）。 */
const BASH_UPDATE_THROTTLE_MS = 100;
/** codemode 结构化结果里 output 的上限（pi 同值）。 */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
/** 前台等待默认秒数（DSH bash-local 的 120s）。 */
export const DEFAULT_FOREGROUND_TIMEOUT_SEC = 120;
/** 主动停止时等进程结算的上限。 */
const STOP_SETTLE_MS = 30_000;

export const BASH_PROMPT_SNIPPET = "Execute bash commands (ls, grep, find, etc.)";
export const BASH_PROMPT_GUIDELINES = [
  "You can inspect PI_* environment variables for current model and session details.",
  "Use bash with run_in_background: true for builds, test suites, or servers that run longer than a minute, then keep working; a foreground command still running after its timeout moves to the background on its own. Collect output with job_output and stop it with job_kill instead of sleeping or polling.",
];

const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({
    description: `Seconds to wait in the foreground (default ${DEFAULT_FOREGROUND_TIMEOUT_SEC}). When it passes, the command keeps running as a background job instead of being killed: you get the output so far and a job id; collect the rest with job_output, stop it with job_kill.`,
  })),
  run_in_background: Type.Optional(Type.Boolean({
    description: "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.",
  })),
});

/** 与 pi 的 bashOutputSchema 一致：codemode 脚本拿到的就是这个形状。 */
const bashOutputSchema = Type.Object({
  output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
  truncated: Type.Boolean(),
  full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
  exit_code: Type.Number(),
  wall_time_seconds: Type.Number(),
});

type BashParams = Static<typeof bashSchema>;

export interface BashJobRef {
  jobId: string;
  /** 进程内 job id 重启后会复用，界面用它和 jobId 一起认 job。 */
  jobStartedAt: number;
}

export type BashToolDetails =
  | { truncation?: BashSnapshot["truncation"]; fullOutputPath?: string }
  | (BashJobRef & { background: true; logPath?: string })
  | (BashJobRef & { promoted: true; fullOutputPath?: string });

export interface GrenBashDeps {
  jobs: JobsService;
  exec: ExecFn;
  /** 前台默认等待秒数；不给则读 BASH_FOREGROUND_TIMEOUT_SEC，再退到 120。 */
  foregroundTimeoutSec?: () => number;
  tempDir?: string;
}

type ToolCtx = {
  cwd: string;
  sessionManager: { getSessionId: () => string; getSessionFile?: () => string | undefined };
  model?: { provider: string; id: string };
  thinkingLevel?: string;
};

function resolveTimeoutSec(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  if (timeout > MAX_TIMEOUT_SECONDS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  return timeout;
}

function configuredForegroundSec(): number {
  const n = Number(getConfig("BASH_FOREGROUND_TIMEOUT_SEC") ?? "");
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FOREGROUND_TIMEOUT_SEC;
}

/** pi 的 getShellEnv + resolveSpawnContext：PATH 前置 pi bin 目录，换上当前会话的 PI_* 事实。 */
export function bashEnv(ctx: ToolCtx): NodeJS.ProcessEnv {
  const binDir = join(getAgentDir(), "bin");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const entries = currentPath.split(delimiter).filter(Boolean);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [pathKey]: entries.includes(binDir) ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter),
  };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile?.();
  if (file) env.PI_SESSION_FILE = file;
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  return env;
}

const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

/** pi 的 formatOutput：尾部文本加截断说明。 */
function formatOutput(output: BashOutput, snapshot: BashSnapshot, emptyText = "(no output)") {
  const truncation = snapshot.truncation;
  let text = snapshot.content || emptyText;
  let details: BashToolDetails | undefined;
  if (truncation.truncated) {
    details = { truncation, ...(snapshot.fullOutputPath ? { fullOutputPath: snapshot.fullOutputPath } : {}) };
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    if (truncation.lastLinePartial) {
      const lastLineSize = formatSize(output.getLastLineBytes());
      text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
    } else if (truncation.truncatedBy === "lines") {
      text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
    } else {
      text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
    }
  }
  return { text, details };
}

export function renderBackgroundStart(jobId: string, logPath: string | undefined): string {
  return (
    `started background job ${jobId}\n` +
    (logPath ? `full log: ${logPath}\n` : "") +
    "You will be notified when it finishes; read newer output with job_output, stop it with job_kill."
  );
}

/** DSH renderPromoted：已有输出，然后仍在运行的标记与交接说明。 */
export function renderPromoted(output: string, timeoutSec: number, jobId: string): string {
  const marker =
    `[still running after ${timeoutSec}s; moved to background job ${jobId}]\n` +
    "The command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.";
  const body = output.length > 0 ? (output.endsWith("\n") ? output.slice(0, -1) : output) : "";
  return fitWithSuffix(body, `${body ? "\n" : ""}${marker}`, BASH_JOB_OUTPUT_LIMIT_BYTES, "\n[output truncated]");
}

export function createGrenBashTool(deps: GrenBashDeps): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
  const foregroundSec = deps.foregroundTimeoutSec ?? configuredForegroundSec;

  return {
    name: "bash",
    label: "bash",
    description:
      `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. ` +
      `A command still running after the timeout (default ${DEFAULT_FOREGROUND_TIMEOUT_SEC} seconds) moves to a background job instead of being killed; run_in_background starts it there directly.`,
    promptSnippet: BASH_PROMPT_SNIPPET,
    promptGuidelines: [...BASH_PROMPT_GUIDELINES],
    parameters: bashSchema,
    outputSchema: bashOutputSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params: BashParams, signal, onUpdate, rawCtx) {
      const ctx = rawCtx as unknown as ToolCtx;
      const { command } = params;
      const timeoutSec = resolveTimeoutSec(params.timeout);
      const env = bashEnv(ctx);
      const owner = ctx.sessionManager.getSessionId()?.trim() ?? "";
      const job = { jobs: deps.jobs, exec: deps.exec };

      if (params.run_in_background === true) {
        if (signal?.aborted) throw new Error("Command aborted");
        if (!owner) throw new Error("run_in_background needs a session; run the command in the foreground instead");
        const output = new BashOutput({ eagerFile: true, ...(deps.tempDir ? { tempDir: deps.tempDir } : {}) });
        const started = startBashJob(job, { command, cwd: ctx.cwd, owner, workspace: ctx.cwd, env, output });
        return {
          content: [{ type: "text", text: renderBackgroundStart(started.id, output.fullOutputPath) }],
          details: {
            background: true,
            jobId: started.id,
            jobStartedAt: started.startedAt,
            ...(output.fullOutputPath ? { logPath: output.fullOutputPath } : {}),
          },
        };
      }

      // ── 前台：pi 的流式更新原样保留 ──
      const output = new BashOutput(deps.tempDir ? { tempDir: deps.tempDir } : {});
      let updatesOpen = true;
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;
      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty || !updatesOpen) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: [{ type: "text", text: snapshot.content || "" }],
          details: {
            ...(snapshot.truncation.truncated ? { truncation: snapshot.truncation } : {}),
            ...(snapshot.fullOutputPath ? { fullOutputPath: snapshot.fullOutputPath } : {}),
          },
        });
      };
      const clearUpdateTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
      };
      const scheduleOutputUpdate = () => {
        if (!onUpdate || !updatesOpen) return;
        updateDirty = true;
        const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };
      const closeUpdates = () => {
        clearUpdateTimer();
        emitOutputUpdate();
        updatesOpen = false;
      };
      onUpdate?.({ content: [], details: undefined });
      const startedAtMs = performance.now();

      /** 进程已结算：按 pi 的格式出结果。 */
      const finishResult = async (exit: BashExit, stopped: string | undefined) => {
        output.finish();
        closeUpdates();
        await output.closeTempFile();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        if (exit.kind === "aborted") {
          const { text } = formatOutput(output, snapshot, "");
          throw new Error(appendStatus(text, stopped ? `Command stopped: ${stopped}` : "Command aborted"));
        }
        if (exit.kind === "error") {
          const err = exit.error;
          if (err instanceof Error && err.message.startsWith("timeout:")) {
            const { text } = formatOutput(output, snapshot, "");
            throw new Error(appendStatus(text, `Command timed out after ${err.message.split(":")[1]} seconds`));
          }
          throw err instanceof Error ? err : new Error(String(err));
        }
        const { text: outputText, details } = formatOutput(output, snapshot);
        if (exit.exitCode === null) throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
        const wallTimeSeconds = Math.round((performance.now() - startedAtMs) / 100) / 10;
        const full = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
        const structuredContent = {
          output: full.content,
          truncated: full.truncated,
          ...(full.truncated && snapshot.fullOutputPath ? { full_output_path: snapshot.fullOutputPath } : {}),
          exit_code: exit.exitCode,
          wall_time_seconds: wallTimeSeconds,
        };
        if (exit.exitCode !== 0) {
          return {
            content: [{ type: "text" as const, text: appendStatus(outputText, `Command exited with code ${exit.exitCode}`) }],
            details,
            structuredContent,
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: outputText }], details, structuredContent };
      };

      try {
        let started: StartedBashJob | undefined;
        if (owner && !signal?.aborted) {
          try {
            started = startBashJob(job, { command, cwd: ctx.cwd, owner, workspace: ctx.cwd, env, output, onData: scheduleOutputUpdate });
          } catch {
            // 准入被拒（并发上限）：退回 pi 原来的前台执行。
            started = undefined;
          }
        }

        if (!started) {
          // 不受管：timeout 到点杀进程（pi 语义，无默认超时）。
          let exit: BashExit;
          try {
            const r = await deps.exec(command, ctx.cwd, {
              onData: (data) => {
                output.append(data);
                scheduleOutputUpdate();
              },
              ...(signal ? { signal } : {}),
              ...(timeoutSec !== undefined ? { timeout: timeoutSec } : {}),
              env,
            });
            exit = { kind: "exited", exitCode: r.exitCode };
          } catch (error) {
            exit = error instanceof Error && error.message === "aborted" ? { kind: "aborted" } : { kind: "error", error };
          }
          return await finishResult(exit, undefined);
        }

        const waitSec = timeoutSec ?? foregroundSec();
        /** 本次调用自己停掉 job 并等它结算：结算算 awaited，不再发通知；id 从没交给模型，记录随调用离开。 */
        const stopAndForget = async (reason: string) => {
          try {
            deps.jobs.kill(started!.id, owner, reason);
            const view = await deps.jobs.wait(started!.id, STOP_SETTLE_MS, owner);
            if (view.status !== "running" && view.status !== "stopping") deps.jobs.remove(started!.id, owner);
          } catch {
            /* 已被移除或不再归本会话 */
          }
        };

        let view;
        try {
          view = await deps.jobs.wait(started.id, waitSec * 1000, owner, signal);
        } catch {
          // 只有调用方 abort 会让等待 reject：模型这次调用结束，命令随之停止，与原来的前台语义一致。
          await stopAndForget("tool call aborted");
          return await finishResult({ kind: "aborted" }, undefined);
        }

        if (view.status === "running" || view.status === "stopping") {
          // 等待超时：命令留在后台继续跑。一次消耗式读取带出到目前为止的输出，job_output 从这里接着读。
          closeUpdates();
          const read = deps.jobs.consume(started.id, owner);
          const delta = renderModelDelta(read.chunks, read.lossy, read.job.ring.spillPaths ?? []);
          const fullOutputPath = output.fullOutputPath;
          return {
            content: [{ type: "text", text: renderPromoted(delta, waitSec, started.id) }],
            details: {
              promoted: true,
              jobId: started.id,
              jobStartedAt: started.startedAt,
              ...(fullOutputPath ? { fullOutputPath } : {}),
            },
          };
        }

        // 等待期间结算：结果随本次调用交付，记录随之离开（模型从没见过这个 id）。
        try {
          deps.jobs.remove(started.id, owner);
        } catch {
          /* 已被移除 */
        }
        return await finishResult(await started.exited, started.stopped());
      } finally {
        clearUpdateTimer();
      }
    },
  };
}
