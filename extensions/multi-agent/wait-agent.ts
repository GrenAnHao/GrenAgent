// wait_agent：照 Codex multi_agents_v2 的 wait_agent。等自己的任意一个后台子代理结算，
// 只返回谁结算了，不返回正文——正文在随后到来的 subagent-settled 通知里。
// 父会话正忙（就在这个工具里）时通知按 steer 投递，落在本工具结果之后。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectCwd } from "../_shared/session-cwd.js";
import { toolPrompt } from "../_shared/toolPrompt.js";
import { onChildRunEvent, runningChildrenOf, type ChildSettlement } from "./child-runs.js";

/** Codex DEFAULT_MULTI_AGENT_V2_{DEFAULT,MIN,MAX}_WAIT_TIMEOUT_MS。 */
export const WAIT_DEFAULT_MS = 30_000;
export const WAIT_MIN_MS = 10_000;
export const WAIT_MAX_MS = 3_600_000;
const STEER_POLL_MS = 250;

export type WaitOutcome = "settled" | "timeout" | "steered" | "aborted" | "none";

export interface WaitResult {
  outcome: WaitOutcome;
  settled: ChildSettlement[];
  /** 返回时仍在跑的直接子代理。 */
  running: string[];
}

export async function waitForChildren(
  parentSessionId: string,
  opts: { timeoutMs: number; signal?: AbortSignal; hasPendingInput?: () => boolean },
): Promise<WaitResult> {
  if (runningChildrenOf(parentSessionId).length === 0) return { outcome: "none", settled: [], running: [] };
  const settled: ChildSettlement[] = [];
  const outcome = await new Promise<WaitOutcome>((resolve) => {
    let done = false;
    const cleanups: Array<() => void> = [];
    const finish = (value: WaitOutcome) => {
      if (done) return;
      done = true;
      for (const cleanup of cleanups) cleanup();
      resolve(value);
    };
    cleanups.push(
      onChildRunEvent((event) => {
        if (event.parentSessionId !== parentSessionId) return;
        if (event.settled) {
          settled.push(event.settled);
          // 同一时刻结算的兄弟一起报：等这一轮同步事件发完再返回。
          queueMicrotask(() => finish("settled"));
        } else if (runningChildrenOf(parentSessionId).length === 0) {
          finish("none");
        }
      }),
    );
    const timer = setTimeout(() => finish("timeout"), opts.timeoutMs);
    cleanups.push(() => clearTimeout(timer));
    if (opts.hasPendingInput) {
      const poll = setInterval(() => {
        try {
          if (opts.hasPendingInput?.()) finish("steered");
        } catch {
          /* 上下文已失效：不再检查用户插话 */
        }
      }, STEER_POLL_MS);
      cleanups.push(() => clearInterval(poll));
    }
    if (opts.signal) {
      if (opts.signal.aborted) finish("aborted");
      const onAbort = () => finish("aborted");
      opts.signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => opts.signal?.removeEventListener("abort", onAbort));
    }
  });
  return { outcome, settled, running: runningChildrenOf(parentSessionId) };
}

function describeRunning(ids: string[], labelOf: (id: string) => string | undefined): string {
  if (ids.length === 0) return "No sub-agents are still running.";
  return `Still running: ${ids.map((id) => withLabel(id, labelOf)).join(", ")}.`;
}

function withLabel(id: string, labelOf: (id: string) => string | undefined): string {
  const label = labelOf(id)?.trim();
  return label ? `${id} (${label})` : id;
}

export function formatWaitResult(
  result: WaitResult,
  timeoutMs: number,
  labelOf: (id: string) => string | undefined,
): string {
  const running = describeRunning(result.running, labelOf);
  switch (result.outcome) {
    case "none":
      return "No background sub-agents are running; nothing to wait for.";
    case "settled": {
      const lines = result.settled.map((s) => `- ${withLabel(s.childId, labelOf)}: ${s.stopReason}`);
      return `Wait completed. Settled:\n${lines.join("\n")}\nEach result arrives as a separate subagent-settled notice.\n${running}`;
    }
    case "timeout":
      return `Wait timed out after ${timeoutMs}ms. ${running}`;
    case "steered":
      return `Wait interrupted by new input. ${running}`;
    case "aborted":
      return `Wait aborted. ${running}`;
  }
}

export function registerWaitAgent(
  pi: ExtensionAPI,
  deps: {
    parentKey: (ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } }) => string;
    labelOf: (cwd: string, childId: string) => string | undefined;
  },
): void {
  pi.registerTool({
    name: "wait_agent",
    label: "Wait for Sub-agent",
    description:
      "Wait until any background sub-agent you started (spawn_agent action \"spawn\") settles, the timeout expires, or new user input arrives. " +
      "Returns only which sub-agents settled and how (completed / aborted / error); each result arrives as its own subagent-settled notice right after this tool result. " +
      `timeout_ms defaults to ${WAIT_DEFAULT_MS}, min ${WAIT_MIN_MS}, max ${WAIT_MAX_MS}. Returns immediately when none of your sub-agents is running.`,
    ...toolPrompt("Wait for a background sub-agent to settle.", [
      "Use wait_agent only when your next step is blocked on a background sub-agent's result; otherwise keep working, because every settled sub-agent sends its own notice.",
      "wait_agent does not return sub-agent output; read the subagent-settled notice that follows it, and do not call wait_agent again by reflex.",
    ]),
    parameters: Type.Object({
      timeout_ms: Type.Optional(
        Type.Number({
          description: `Timeout in milliseconds. Defaults to ${WAIT_DEFAULT_MS}, min ${WAIT_MIN_MS}, max ${WAIT_MAX_MS}.`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const requested = typeof params.timeout_ms === "number" && Number.isFinite(params.timeout_ms)
        ? Math.floor(params.timeout_ms)
        : undefined;
      if (requested !== undefined && requested > WAIT_MAX_MS) {
        return {
          content: [{ type: "text", text: `timeout_ms must be at most ${WAIT_MAX_MS}` }],
          details: {},
          isError: true,
        };
      }
      const timeoutMs = requested === undefined ? WAIT_DEFAULT_MS : Math.max(requested, WAIT_MIN_MS);
      const result = await waitForChildren(deps.parentKey(ctx), {
        timeoutMs,
        ...(signal ? { signal } : {}),
        hasPendingInput: () => ctx.hasPendingMessages(),
      });
      const clamped = requested !== undefined && requested < timeoutMs
        ? `\n\nRequested timeout of ${requested}ms was clamped to the minimum of ${timeoutMs}ms.`
        : "";
      const labelOf = (id: string) => deps.labelOf(projectCwd(ctx), id);
      return {
        content: [{ type: "text", text: `${formatWaitResult(result, timeoutMs, labelOf)}${clamped}` }],
        details: {
          outcome: result.outcome,
          timeoutMs,
          settled: result.settled.map((s) => ({ childId: s.childId, stopReason: s.stopReason })),
          running: result.running,
        },
      };
    },
  });
}
