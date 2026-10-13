// 通用后台 job：job_output / job_list / job_kill + 结算 notice。生产者（bash run_in_background）调 jobs.start。
// 后台子代理不走这里：结果经 subagent-settled 通知交回（extensions/multi-agent）。
// 语义移植自 DSH packages/jobs/tool-jobs：模型已经收走的结算不再通知——等待释放的（awaited）、
// 模型自己 job_kill 的、所有者销毁导致的（teardown）都跳过。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { formatJobNotice } from "./notice.js";
import { fitWithSuffix, jobDetail, statusLine } from "./render.js";
import { jobs } from "./service.js";
import { JobsError, type JobDoneInfo, type JobSnapshot } from "./types.js";

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_WAIT_MAX_MS = 600_000;
const DEFAULT_WAKE_BUDGET = 3;

interface OwnerHost {
  sendMessage: ExtensionAPI["sendMessage"];
  isIdle: () => boolean;
}

const owners = new Map<string, OwnerHost>();
const wakes = new Map<string, number>();
/** 模型经 job_kill 请求停掉的存活 job：那条工具结果就是送达，结算通知只会重复它。 */
const killedByModel = new Set<string>();
let unsubscribe: (() => void) | undefined;

function num(key: string, fallback: number): number {
  const n = Number(getConfig(key) ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function callerId(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  try {
    return ctx.sessionManager?.getSessionId?.()?.trim() ?? "";
  } catch {
    return "";
  }
}

function fail(e: unknown) {
  const text = e instanceof JobsError ? e.message : String((e as Error)?.message ?? e);
  return { content: [{ type: "text" as const, text }], isError: true, details: {} };
}

function deliver(snapshot: JobSnapshot, info: JobDoneInfo): void {
  const killed = killedByModel.delete(snapshot.id);
  if (snapshot.reported || killed || info.awaited || info.cause === "teardown") return;
  const host = owners.get(snapshot.owner);
  if (!host) return;
  const msg = {
    customType: "job-done",
    content: formatJobNotice(snapshot),
    display: true,
    details: { jobId: snapshot.id, kind: snapshot.kind, status: snapshot.status },
  };
  if (!host.isIdle()) {
    host.sendMessage(msg, { triggerTurn: false, deliverAs: "steer" });
  } else {
    const spent = wakes.get(snapshot.owner) ?? 0;
    if (spent < num("JOBS_WAKE_BUDGET", DEFAULT_WAKE_BUDGET)) {
      wakes.set(snapshot.owner, spent + 1);
      host.sendMessage(msg, { triggerTurn: true, deliverAs: "followUp" });
    } else {
      host.sendMessage(msg, { triggerTurn: false });
    }
  }
  jobs.markReported(snapshot.id);
}

export default function (pi: ExtensionAPI) {
  unsubscribe?.();
  unsubscribe = jobs.onJobDone(deliver);

  pi.on("session_start", async (_e, ctx) => {
    const id = callerId(ctx);
    if (!id) return;
    owners.set(id, { sendMessage: (m, o) => pi.sendMessage(m, o), isIdle: () => ctx.isIdle() });
    wakes.set(id, 0);
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    const id = callerId(ctx);
    if (!id) return;
    owners.delete(id);
    wakes.delete(id);
    await jobs.detachOwner(id);
  });

  pi.on("input", async (_e, ctx) => {
    const id = callerId(ctx);
    if (id) wakes.set(id, 0);
    return undefined;
  });

  pi.registerTool({
    name: "job_output",
    label: "Job Output",
    description:
      "Read a background job (bash run_in_background): output since the previous read. " +
      "The response ends with `[status: ...]` (plus the exit code once a command finished). " +
      "Set `wait: true` to block until the job settles or `timeout_ms` expires (a timed-out wait returns [status: running] and leaves the job alive).",
    promptSnippet: "Read a background job by id.",
    promptGuidelines: [
      "Track every background job id you start (bash run_in_background) and read it with job_output. You are notified in-session when one finishes — do not busy-poll job_output or sleep on it; keep working on independent steps and do not duplicate a running job's work.",
      "Before giving a final answer, collect every still-relevant job with job_output (wait: true only when genuinely blocked), and job_kill jobs that stopped mattering.",
    ],
    parameters: Type.Object({
      job_id: Type.String({ description: "Job id returned by the tool that started the background work." }),
      wait: Type.Optional(Type.Boolean({ description: "Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Max wait in milliseconds (with wait: true). Capped by JOBS_WAIT_MAX_MS." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const max = num("JOBS_WAIT_MAX_MS", DEFAULT_WAIT_MAX_MS);
        const timeoutMs = Math.min(typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : num("JOBS_WAIT_TIMEOUT_MS", DEFAULT_WAIT_MS), max);
        const r = await jobs.read(params.job_id, callerId(ctx), { wait: params.wait === true, timeoutMs, ...(signal ? { signal } : {}) });
        const body = r.text.length > 0 ? r.text : "(no new output)";
        const content = body.endsWith("\n") ? body.slice(0, -1) : body;
        const text = fitWithSuffix(content, `\n${statusLine(r.job)}`, r.job.outputLimitBytes, "\n[output truncated]");
        return { content: [{ type: "text", text }], details: { jobId: r.job.id, kind: r.job.kind, status: r.job.status } };
      } catch (e) {
        return fail(e);
      }
    },
  });

  pi.registerTool({
    name: "job_list",
    label: "Job List",
    description: "List your background jobs (running and finished) with their ids, kinds, and statuses.",
    promptSnippet: "List background jobs and their statuses.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const rows = jobs.list(callerId(ctx));
      if (rows.length === 0) return { content: [{ type: "text", text: "(no background jobs)" }], details: {} };
      const lines = rows.map((s) => {
        const detail = jobDetail(s);
        return `${s.id} [${s.kind}] ${s.status}${detail ? ` (${detail})` : ""} — ${s.label}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "job_kill",
    label: "Job Kill",
    description: "Request cancellation of a running background job by id. Returns immediately; the job settles as killed once its work actually stops.",
    promptSnippet: "Cancel a running background job by id.",
    parameters: Type.Object({
      job_id: Type.String({ description: "Job id returned by the tool that started the background work." }),
      reason: Type.Optional(Type.String({ description: "Optional short reason, recorded in the job's terminal status and forwarded to the job." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const caller = callerId(ctx);
        const outcome = jobs.kill(params.job_id, caller, params.reason);
        if (outcome === "requested") killedByModel.add(params.job_id);
        const snap = jobs.get(params.job_id, caller);
        const text =
          outcome === "already-finished"
            ? `job ${params.job_id} had already finished ${statusLine(snap)}`
            : `requested cancellation of job ${params.job_id}`;
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) {
        return fail(e);
      }
    },
  });
}

export function __resetJobsOwnersForTest(): void {
  owners.clear();
  wakes.clear();
  killedByModel.clear();
}
