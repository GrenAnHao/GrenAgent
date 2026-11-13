// multi-agent: delegate work to pi sub-agents, each with its own context window.
// Single task, several in parallel, or a chain. Execution goes through manager.ts,
// which picks the in-process or worker backend.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { gateToolCall, getAgentMode } from "../agent-mode/modes.js";
import { isUltraRouting, routingContextEnv } from "../_shared/ultra-context.js";
import { catalogModel, resolveUltraRoute, routeLabel, routingError } from "./routing.js";
import { parentModelSpec, resolveSubagentModel } from "./runner.js";
import {
  preferredBackend,
  runSubagent,
  selectSubagentBackend,
  startBackgroundRun,
  startContinuableSubagent,
  type SubagentResult,
} from "./manager.js";
import { sendSettlementToParent, settlementMessage } from "./parent-host.js";
import type { SettlementNotice } from "./settlement-notice.js";
import { registerWaitAgent } from "./wait-agent.js";
import { registerListAgents } from "./list-agents.js";
import { registerTopApprovalLifecycle } from "./approval-top.js";
import { detachableSignal, ForegroundRun, SteerWatch, waitOrDetach } from "./detach.js";
import { assertRouteAllowed, isThinkingLevel, readModelSelectionPolicy, resolveRouteAlias, resolveThinkingLevel, THINKING_LEVELS } from "./model-selection.js";
import { availableModels, registerListSubagentModels } from "./list-models-tool.js";
import type { SubagentStopReason } from "./assistant-output.js";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import { projectCwd } from "../_shared/session-cwd.js";
import { normalizeTasks, spawnHasWork } from "./tasks.js";
import { getApprovalPolicy } from "../_shared/approval.js";
import { resolveProfile, profileToModel, profileToEnv, profileLimits, type ProfileInput } from "./capability.js";
import { discoverAgents, inferNamedAgentProfile, resolveAgent, suggestAgent, withBuiltinDefaults, type AgentScope } from "./agents.js";
import { SubAgentRegistry, type SubAgentRow } from "./registry.js";
import { cancelSubAgent } from "./cancel.js";
import { withoutSubagentDeadline } from "./codemode-deadline.js";
import { forEachRegistry, getRegistry, inflight } from "./controlPlane.js";
import { getConfig } from "../_shared/runtime-config.js";
import { tailLines, LIVE_TRANSCRIPT_TAIL, TRANSCRIPT_CAP } from "./transcript-tail.js";
import { registerWorkflows } from "./workflows.js";
import { registerAdjacentTools } from "./adjacent-tools.js";
import { currentChild, outsideChild, runAsChild } from "../_shared/leak-owner.js";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { disposeActivation, getActivation } from "./activation.js";
import { establishCatalogChild, foldCatalogFromEntries } from "./catalog.js";
import { emitCatalogChanged } from "./catalog-events.js";
import { completedPrefix } from "./fork-seed.js";
import { assertDepthAllowed, childDepthOf } from "./depth.js";

function parentSessionPath(ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }): string | undefined {
  try {
    const p = ctx.sessionManager?.getSessionFile?.();
    return p?.trim() ? p.trim() : undefined;
  } catch {
    return undefined;
  }
}

function catalogLabel(task: string): string {
  const line = (task.split(/\r?\n/, 1)[0] ?? "").trim();
  if (!line) return "(untitled)";
  return line.length <= 80 ? line : line.slice(0, 80);
}

/**
 * 后台子代理的结算通知：先交父会话宿主（agent-host 里的会话，按忙闲决定 steer / followUp）；
 * 没有宿主（CLI、worker 进程里的父会话）就用扩展 API 发给发起 spawn 的这个会话。
 */
function deliverSettlement(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "isIdle">,
  parentPath: string | undefined,
  workspace: string,
  notice: SettlementNotice,
  spawner: string | undefined,
): void {
  if (parentPath && sendSettlementToParent(parentPath, workspace, notice)) return;
  sendSettlementViaExtension(pi, ctx, notice, spawner);
}

/** 用发起 spawn 的会话自己的扩展 API 投递结算通知：忙时 steer，闲时 followUp 并触发一轮。 */
function sendSettlementViaExtension(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "isIdle">,
  notice: SettlementNotice,
  spawner: string | undefined,
): void {
  let idle = true;
  try {
    idle = ctx.isIdle();
  } catch {
    /* 上下文已失效：按空闲投递，由会话自己排队 */
  }
  try {
    // 类型上是 void，运行时可能返回 promise：两种失败都吞掉（父会话已经不在）。
    const send = (): void =>
      void Promise.resolve(
        pi.sendMessage(settlementMessage(notice), idle ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "steer" }),
      ).catch(() => {});
    // 唤起的是发起 spawn 的那个会话的一轮：它自己是子代理（spawn 时记下的身份）就算它的，
    // 否则不算任何子代理的；不能带着结算的那个子代理的身份（_shared/leak-owner.ts）。
    if (spawner) runAsChild(spawner, send);
    else outsideChild(send);
  } catch {
    /* 父会话已经不在 */
  }
}

function writeParentCatalog(
  pi: ExtensionAPI,
  ctx: { sessionManager?: { getSessionFile?: () => string | undefined } },
  opts: { childId: string; sessionPath: string; mode: "one-shot" | "continuable"; label: string },
): void {
  establishCatalogChild((t, d) => pi.appendEntry(t, d), {
    childId: opts.childId,
    sessionPath: opts.sessionPath,
    childCreatedAt: Date.now(),
    mode: opts.mode,
    label: opts.label,
  });
  const parentPath = parentSessionPath(ctx);
  if (parentPath) emitCatalogChanged({ sessionPath: parentPath });
}

function writeOneShotCatalog(
  pi: ExtensionAPI,
  ctx: { sessionManager?: { getSessionFile?: () => string | undefined } },
  opts: { childId: string; sessionPath?: string; label: string },
): void {
  if (!opts.sessionPath) return;
  try {
    writeParentCatalog(pi, ctx, {
      childId: opts.childId,
      sessionPath: opts.sessionPath,
      mode: "one-shot",
      label: opts.label,
    });
  } catch {
    /* one-shot: 目录失败不改变工具结果 */
  }
}

function parentCatalogHasFacts(
  ctx: { sessionManager?: { buildContextEntries?: () => unknown } },
  sessionPath: string,
): boolean {
  try {
    const sm = ctx.sessionManager;
    if (sm && typeof sm.buildContextEntries === "function") {
      return foldCatalogFromEntries(sm.buildContextEntries() as never).entries.length > 0;
    }
    const opened = SessionManager.open(sessionPath);
    return foldCatalogFromEntries(opened.buildContextEntries() as never).entries.length > 0;
  } catch {
    return true;
  }
}

function parentLeafMessages(ctx: {
  sessionManager?: { buildContextEntries?: () => unknown };
}): unknown[] {
  const entries = ctx.sessionManager?.buildContextEntries?.();
  if (!Array.isArray(entries)) return [];
  const out: unknown[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { type?: string; message?: unknown };
    if (item.type === "message") out.push(item.message);
  }
  return out;
}

function forkDetails(fork: unknown, seedMessages: unknown[]): Record<string, unknown> {
  if (!fork) return {};
  return { forked: true, inheritedEventCount: seedMessages.length };
}

function parentSessionId(ctx: { sessionManager?: { getSessionId?: () => string } }): string | null {
  try {
    const sid = ctx.sessionManager?.getSessionId?.();
    return sid?.trim() ? sid.trim() : null;
  } catch {
    return null;
  }
}

function subagentDetails(
  id: string,
  r: SubagentResult,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agentId: id,
    exitCode: r.exitCode,
    ...(r.sessionPath ? { sessionPath: r.sessionPath } : {}),
    ...(r.stopReason ? { stopReason: r.stopReason } : {}),
    ...extra,
  };
}

/**
 * 子代理当前实际运行的思考档位。embedded 子会话起来后把实际档位写进注册表（已按模型能力收窄），以注册表为准；
 * 进程回退路径没有这个值，退到调用参数里显式给的档位；都没有就是未知。
 */
function runningThinkingLevel(
  registry: SubAgentRegistry,
  id: string | undefined,
  requested?: string,
): string | undefined {
  let fromRegistry: string | null | undefined;
  try {
    fromRegistry = id ? registry.get(id)?.thinkingLevel : undefined;
  } catch {
    fromRegistry = undefined;
  }
  return fromRegistry?.trim() || requested?.trim() || undefined;
}

function cleanModel(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

/** explicit spawn model (cheap/strong resolve to the configured route) → named agent → profile → SUBAGENT_MODEL → parent session model. */
function pickSubagentModel(
  explicit: string | undefined,
  layerModel: string | undefined,
  profileModel: string | undefined,
  parent: { provider?: string; id?: string } | undefined,
): string | undefined {
  const explicitRoute = cleanModel(explicit);
  return (
    (explicitRoute ? resolveRouteAlias(explicitRoute) : undefined) ??
    cleanModel(layerModel) ??
    cleanModel(profileModel) ??
    resolveSubagentModel() ??
    parentModelSpec(parent)
  );
}

// 单会话仍占用的子代理数（按 sessionId；拿不到则退回按 cwd）。一次性任务结束就释放；
// 可继续的子代理要等收尾、没有后续消息才释放。进程内状态，扩展宿主 重启清零。
const sessionSpawnCount = new Map<string, number>();

function sessionCap(): number {
  const rawMax = getConfig("SUBAGENT_MAX_PER_SESSION");
  return rawMax == null || rawMax.trim() === "" ? 6 : Number(rawMax) || 0;
}

function releaseReserved(sessionKey: string, n = 1): void {
  if (sessionCap() <= 0 || n <= 0) return;
  const left = (sessionSpawnCount.get(sessionKey) ?? 0) - n;
  if (left <= 0) sessionSpawnCount.delete(sessionKey);
  else sessionSpawnCount.set(sessionKey, left);
}

function sessionSpawnKey(ctx: { cwd: string; sessionManager?: { getSessionId?: () => string } }): string {
  try {
    const sid = ctx.sessionManager?.getSessionId?.();
    if (sid && sid.trim()) return sid.trim();
  } catch {
    /* sessionManager 不可用：退回 cwd 维度（单工作区通常单活跃会话，近似单会话） */
  }
  return ctx.cwd;
}

// 把一个前台子代理登记进 inflight，让 UI 取消 / reapStuck 能 abort 它（此前只有后台 spawn 登记，
// 前台 run/chain/parallel 卡住时取消与 reapStuck 都够不到）。同时把工具的外层 signal 链接进来：
// 外层一中止，子进程也随之中止。返回的 controller.signal 作为传给 runner 的唯一信号。
function registerInflight(id: string, outer: AbortSignal | null | undefined): AbortController {
  const controller = new AbortController();
  inflight.set(id, controller);
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller;
}

/** 写注册表终态。写失败（库被锁、行已删）不能挡住后面的收尾和结算通知。 */
function finishQuietly(reg: SubAgentRegistry, id: string, patch: Parameters<SubAgentRegistry["finish"]>[1]): void {
  try {
    reg.finish(id, patch);
  } catch {
    /* 注册表记账失败：这一行留在 running，由卡死回收收尾 */
  }
}

// 回执不说是谁发的：子代理里触发它的是父代理经 send_message 发来的消息。
const DETACH_REASON = "A new message arrived while this run was waiting";

/** 前台单任务转后台的回执。 */
function detachedSingleText(agentId: string): string {
  return (
    `${DETACH_REASON}, so sub-agent ${agentId} moved to the background and keeps running. ` +
    "Respond to that message now; this sub-agent's result arrives later as a subagent-settled notice " +
    "(call wait_agent only if your next step is blocked on it)."
  );
}

/** 并行 run 转后台的回执：已经结束的照常给结果，还在跑（或还没轮到）的写明转到后台。 */
function detachedParallelResult(
  slots: Array<{
    task: string;
    ok: boolean;
    output: string;
    error?: string;
    partial?: boolean;
    agentId?: string;
    sessionPath?: string;
    stopReason?: SubagentStopReason;
    model?: string;
    settled?: boolean;
  }>,
  fg: ForegroundRun,
  thinkingOf: (id: string | undefined) => { thinkingLevel?: string },
) {
  const finished = (s: (typeof slots)[number]) => s.settled === true && !fg.isRunning(s.agentId);
  const moved = slots.filter((s) => !finished(s)).length;
  const head =
    `${DETACH_REASON}, so ${moved} unfinished sub-agent(s) moved to the background and keep running. ` +
    "Respond to that message now; each one reports back with its own subagent-settled notice.";
  const body = slots
    .map((s, i) => {
      if (!finished(s)) {
        const where = s.agentId ? `Still running as ${s.agentId}` : "Not started yet; it will run in the background";
        return `## Sub-agent ${i + 1} (moved to background)\n\n${where}; its result arrives as a subagent-settled notice.`;
      }
      const label = `## Sub-agent ${i + 1}${s.ok ? "" : " (failed)"}`;
      if (s.ok) return `${label}\n\n${s.output || "(no output)"}`;
      return `${label}\n\nError: ${s.error}`;
    })
    .join("\n\n---\n\n");
  return {
    content: [{ type: "text" as const, text: `${head}\n\n${body}` }],
    details: {
      mode: "parallel",
      detached: true,
      count: slots.length,
      failed: slots.filter((s) => finished(s) && !s.ok).length,
      results: slots.map((s) =>
        finished(s)
          ? {
              task: s.task,
              ok: s.ok,
              output: s.output,
              error: s.error,
              agentId: s.agentId,
              sessionPath: s.sessionPath,
              stopReason: s.stopReason,
              ...(s.model ? { model: s.model } : {}),
              ...thinkingOf(s.agentId),
            }
          : {
              task: s.task,
              status: "running",
              detached: true,
              ...(s.agentId ? { agentId: s.agentId } : {}),
              ...(s.sessionPath ? { sessionPath: s.sessionPath } : {}),
              ...(s.model ? { model: s.model } : {}),
              ...thinkingOf(s.agentId),
            },
      ),
    },
  };
}

// 父代理已经拿着自己写下的任务。结果正文再贴全文，会被当成子代理的产出。
// 主代理用 codemode 调 spawn_agent({ action: "list" }) 找回结论时，读到的也是这段正文。
// 任务留在 details，界面跟进卡片从那里读。
function listEntry(row: SubAgentRow): string {
  const head = `${row.id}  [${row.status}]  ${row.model ?? "-"}  parent=${row.parentId ?? "-"} depth=${row.depth}`;
  const parts = [head];
  if (row.output?.trim()) parts.push("", row.output);
  if (row.error?.trim()) parts.push("", `Error: ${row.error}`);
  if (!row.output?.trim() && !row.error?.trim()) parts.push("", "(no output)");
  return parts.join("\n");
}

function statusText(row: SubAgentRow): string {
  const parts = [`agent ${row.id}: ${row.status}`];
  if (row.output) parts.push("", row.output);
  if (row.error) parts.push("", `Error: ${row.error}`);
  return parts.join("\n");
}

/** Abort + mark any background sub-agent that stopped emitting activity for too long. */
function reapStuck(reg: SubAgentRegistry): void {
  const thresholdMs = Number(getConfig("SUBAGENT_STUCK_MS") ?? "300000") || 300000;
  for (const row of reg.findStuck(thresholdMs)) {
    cancelSubAgent(row.id, reg, inflight);
    reg.finish(row.id, { status: "error", error: `stuck: no activity for >${Math.round(thresholdMs / 1000)}s`, exitCode: -1 });
  }
}

export default function (pi: ExtensionAPI) {
  const modelPolicy = readModelSelectionPolicy();
  registerListSubagentModels(pi, modelPolicy);
  const modelField = (desc: string) => ({ model: Type.Optional(Type.String({ description: desc })) });
  const maybeModel = (desc: string) => modelField(desc);
  const thinkingLevelField = {
    thinking_level: Type.Optional(
      Type.Union(
        THINKING_LEVELS.map((l) => Type.Literal(l)),
        { description: "Thinking level for the child model; only levels listed by `list_subagent_models` for that route. A level the route does not support is moved to the nearest supported one and reported in the result." },
      ),
    ),
  };
  const maybeThinkingLevel = () => thinkingLevelField;

  // 子代理需要人批准时，请求转到这个会话的界面（approval-route.ts）。
  registerTopApprovalLifecycle(pi);

  // Workflow slash-commands (/implement, /scout-and-plan, /implement-and-review)
  // + seed default named agents (scout/planner/reviewer/worker).
  registerWorkflows(pi);

  // 前台 run 转后台（detach.ts）用到的本会话状态：
  // - codemode 脚本里经 ctx.executeTool 发起的 spawn_agent（tool_call 事件带 parentToolCallId），它们要的就是结果，不转后台；
  // - 这一轮来的 steer，只有它触发转后台。
  const nestedSpawnCalls = new Set<string>();
  const steers = new SteerWatch();
  pi.on("input", (event) => {
    steers.noteInput(event);
  });
  pi.on("turn_start", () => steers.reset());
  // 这一轮来了 steer，而且还排着（被别的扩展的 input 钩子拦下的不会进队列）。
  const steerWaiting = (ctx: { hasPendingMessages(): boolean }): boolean => steers.arrived && ctx.hasPendingMessages();
  pi.on("agent_end", () => {
    steers.reset();
    // 被拦下、没走到 execute 的嵌套调用，id 留在这里没人删。
    nestedSpawnCalls.clear();
  });

  // codemode 脚本到 timeout_ms 会取消脚本里跑到一半的子代理。脚本调用 spawn_agent 时去掉脚本级时限，
  // 由子代理自己的空闲 / 硬超时兆底。tool_call 可以就地改 input，只影响执行，不改会话里记下的调用。
  pi.on("tool_call", (event) => {
    // 记下 codemode 脚本里的嵌套调用：前台 run 转后台（detach.ts）不适用于它们。
    const nested = (event as { parentToolCallId?: unknown }).parentToolCallId;
    if (event.toolName === "spawn_agent" && typeof nested === "string" && nested && event.toolCallId) {
      nestedSpawnCalls.add(event.toolCallId);
      return;
    }
    if (event.toolName !== "codemode") return;
    const input = event.input as { code?: unknown };
    if (typeof input?.code !== "string") return;
    const next = withoutSubagentDeadline(input.code);
    if (next !== undefined) input.code = next;
  });

  // 进程启动即回收上一个进程遗留的孤儿子代理（registry.db 里卡在 "running" 的行）并装好取消监听，
  // 而不是仅靠 spawn_agent 懒触发 getRegistry。否则 扩展宿主 重启后只要主代理不再 spawn，遗留的
  // running 行没有任何路径会被清理：前端任务托盘直接读 registry.db，会一直显示"运行中"；面板上的
  // 取消（写 cancel-requests.jsonl）也因 watcher 未安装而无人消费。session_start 在打开/恢复/
  // 切换会话时触发，正好覆盖"刚重启"的时机；getRegistry 对同一 cwd 幂等，只在首次 load 时 reap 一次，
  // 不会误杀进程内正在运行的子代理。子代理进程（PI_IS_SUBAGENT=1）必须跳过：它与兄弟子代理共享
  // 主工作区 registry，启动即 reap 会把正在并行运行的兄弟误判成孤儿。
  // 用户 rewind/fork 会新建会话文件并拷贝旧 leaf 上的目录事实。GrenAgent fork 会重跑
  // factory，不能靠闭包里的 pendingForkBase；用 SessionStartEvent.reason === "fork"。
  pi.on("session_start", (event, ctx) => {
    if (process.env.PI_IS_SUBAGENT === "1") return;
    try {
      getRegistry(projectCwd(ctx));
    } catch {
      /* 回收失败不阻塞 session_start */
    }
    if (event?.reason === "fork") {
      try {
        const current = parentSessionPath(ctx);
        if (current && parentCatalogHasFacts(ctx, current)) {
          pi.appendEntry("subagent_catalog_base", { version: 0, reason: "user-fork" });
          emitCatalogChanged({ sessionPath: current });
        }
      } catch {
        /* fork base 失败不阻断 reap 之后的其它 listener */
      }
    }
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Sub-agent",
    description:
      "Delegate a task to a sub-agent with its own context window. " +
      "Modes: `task` (single) | `tasks` (parallel) | `chain` (sequential, with {previous} placeholder). " +
      "`agent` picks a named agent (system prompt + tools + model) from ~/.pi/agent/agents/*.md: " +
      "scout/ask/reviewer are read-only, planner is restricted-write, worker is writable. " +
      "`profile` (explore|planner|reviewer|default) sets filesystem/MCP access; omitted profile still follows the named agent. " +
      "In Ultra mode only Ultra role/default settings select implicit models; agent/profile model defaults are ignored. Ordinary mode keeps its existing model policy. " +
      "The sub-agent works in your current working directory; to isolate edits on their own branch, call create_worktree yourself first. " +
      "Pass `title` as the short card name (one clause, at most 24 characters); the sub-agent still receives the full task text. " +
      "`action: \"run\"` (default) blocks and returns the sub-agent output(s); `action: \"spawn\"` starts one task in the background, returns its agentId at once, and delivers the result later as a subagent-settled notice. " +
      "If a steering message arrives while a `run` (single task or `tasks`) is still waiting, the unfinished sub-agents move to the background and each reports back with a subagent-settled notice; calls inside codemode scripts and `chain` always wait for the result.",
    promptSnippet: "Delegate a task to a sub-agent with its own context window.",
    promptGuidelines: [
      "Use spawn_agent 时每次都带 title：一句任务名，不超过 24 字，用用户当前语言。单任务写在顶层；并行 tasks 和链式 chain 的每一项各自带 title。title 只做卡片名，完整要求仍写在 task。",
      "Use spawn_agent to parallelize independent sub-tasks or to isolate a large exploration from the main context.",
      "Each sub-agent starts fresh — include all context it needs in the task text.",
      "Use `agent` for a specialized role: scout/ask (readonly recon), planner, reviewer, worker (writable). Use `chain` to pipe one step's output into the next via {previous}.",
      "Omit `profile` and the named role still selects explore/planner/reviewer/default. For an unnamed read-only child pass `profile: \"explore\"`.",
      "Prefer scout for broad fan-out; do simple single-file lookups yourself.",
      "Use spawn_agent action \"spawn\" when you have independent work to do meanwhile: its result arrives as a subagent-settled notice, so do not poll status or wait just to collect the conclusion.",
      "子任务要接着当前对话往下做时用 fork: true；要隔离探索时不要开。",
      "Ultra 或普通自选路由开启时先调用 list_subagent_models，只能从当前模式授权的模型或别名中选择；普通自选关闭时省略显式 model，要写 thinking_level 也先查它（会列出默认路由的可用档位）。",
      "fork: true 时换模型会失去父前缀缓存，非必要不换。",
    ],
    parameters: Type.Object({
      title: Type.Optional(
        Type.String({
          description:
            "Short card name: one clause, at most 24 characters, in the user's language. Not sent to the sub-agent.",
        }),
      ),
      task: Type.Optional(Type.String({ description: "A single task for one sub-agent" })),
      ...maybeModel("Model route (provider/id) or alias `cheap` / `strong` for `task`. Must come from `list_subagent_models`; omit to use the configured default."),
      tasks: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({
              title: Type.Optional(
                Type.String({
                  description: "Short card name for this task: one clause, at most 24 characters, in the user's language.",
                }),
              ),
              task: Type.String(),
              ...maybeModel("Model route or alias `cheap` / `strong` for this task; must come from `list_subagent_models`."),
              ...maybeThinkingLevel(),
              agent: Type.Optional(Type.String()),
            }),
          ]),
          { description: "Multiple tasks in parallel; each item may be a string or { title, task, model, agent }." },
        ),
      ),
      agent: Type.Optional(
        Type.String({
          description:
            "Named agent (from ~/.pi/agent/agents/*.md): applies its system prompt + tools + model. Defaults: scout (codebase recon/exploration), planner, reviewer, worker. Synonyms like 'explorer'/'explore' resolve to scout.",
        }),
      ),
      agentScope: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
          description:
            'Where to discover named agents. Default "user"; "both"/"project" also reads repo .pi/agents — an untrusted repo can thereby inject a sub-agent system prompt + tool allowlist, so keep "user" for unfamiliar code.',
        }),
      ),
      chain: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.Optional(
              Type.String({
                description: "Short card name for this step: one clause, at most 24 characters, in the user's language.",
              }),
            ),
            task: Type.String(),
            agent: Type.Optional(Type.String()),
            ...maybeModel("Model route or alias `cheap` / `strong` for this step; must come from `list_subagent_models`."),
            ...maybeThinkingLevel(),
          }),
          { description: "Sequential steps; each step's task may contain {previous} (replaced by the prior step's output). Pass title on each step." },
        ),
      ),
      profile: Type.Optional(
        Type.Union(
          [
            Type.String({ description: "Preset profile: explore | planner | reviewer | default" }),
            Type.Object(
              {
                extends: Type.Optional(Type.String()),
                fs: Type.Optional(
                  Type.Union([
                    Type.Literal("readonly"),
                    Type.Literal("workspace"),
                    Type.Object({ writeAllow: Type.Array(Type.String()) }),
                  ]),
                ),
                net: Type.Optional(Type.Boolean()),
                mcp: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
                spawn: Type.Optional(Type.Boolean()),
                ...maybeModel("Model route or alias (cheap/strong) for this profile."),
              },
              { additionalProperties: false },
            ),
          ],
          { description: "Capability profile: preset name or inline object. Composable, additive/subtractive." },
        ),
      ),
      action: Type.Optional(
        Type.Union(
          [
            Type.Literal("run"),
            Type.Literal("spawn"),
            Type.Literal("status"),
            Type.Literal("cancel"),
            Type.Literal("list"),
            Type.Literal("remove"),
          ],
          {
            description:
              "run (default, blocking, returns the output) | spawn (background, returns agentId; the result arrives later as a subagent-settled notice) | status | cancel | list (all sub-agents) | remove (delete a record)",
          },
        ),
      ),
      agentId: Type.Optional(
        Type.String({ description: "Sub-agent id for status/cancel/remove (from a prior background spawn)." }),
      ),
      fork: Type.Optional(
        Type.Boolean({ description: "When true, seed the child with the parent session's completed turns." }),
      ),
      ...maybeThinkingLevel(),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const nestedCall = nestedSpawnCalls.delete(toolCallId);
      // 调 spawn_agent 的会话自己是子代理时它的身份：退回扩展 API 投递结算通知时，唤起的那一轮还算它的。
      const spawner = currentChild();
      const action = params.action ?? "run";
      const ultra = isUltraRouting(ctx);
      const registry = getRegistry(projectCwd(ctx));

      // 模型策略「禁用子代理」：直接拒绝 run/spawn（status/list/cancel/remove 仍可用于善后历史任务）。
      if (!ultra && (action === "run" || action === "spawn") && getConfig("SUBAGENT_MODE")?.trim() === "disabled") {
        throw new Error(
          "子代理已被禁用（设置 → 子代理 → 模型策略 = 禁用子代理）。如需使用请改为「继承父模型」或「选定模型」。",
        );
      }

      if (action === "status" || action === "cancel" || action === "list" || action === "remove") {
        // Lazy stuck reaping so status/list reflect reality even without the timer.
        reapStuck(registry);

        if (action === "list") {
          const rows = registry.list();
          const body = rows.length ? rows.map(listEntry).join("\n\n---\n\n") : "(no sub-agents)";
          return {
            content: [{ type: "text", text: body }],
            details: {
              count: rows.length,
              agents: rows.map((x) => ({
                agentId: x.id,
                status: x.status,
                task: x.task,
                model: x.model,
                output: x.output,
                error: x.error,
              })),
            },
          };
        }

        const id = params.agentId?.trim();
        if (!id) throw new Error(`action '${action}' requires agentId`);
        const row = registry.get(id);
        if (!row) throw new Error(`unknown agentId: ${id}`);

        if (action === "remove") {
          if (row.status === "running") cancelSubAgent(id, registry, inflight);
          registry.remove(id);
          return { content: [{ type: "text", text: `removed ${id}` }], details: { agentId: id, removed: true, task: row.task } };
        }
        if (action === "cancel") {
          if (row.status === "running") cancelSubAgent(id, registry, inflight);
          const out = registry.get(id) ?? row;
          return {
            content: [{ type: "text", text: statusText(out) }],
            details: { agentId: out.id, status: out.status, task: out.task, ...(out.error ? { error: out.error } : {}) },
          };
        }
        const out = registry.get(id) ?? row;
        return {
          content: [{ type: "text", text: statusText(out) }],
          details: {
            agentId: out.id,
            status: out.status,
            exitCode: out.exitCode,
            task: out.task,
            ...(out.error ? { error: out.error } : {}),
          },
        };
      }

      const list = normalizeTasks(params);
      const childDepth = childDepthOf(ctx as never);
      const parentSid = parentSessionId(ctx);
      try {
        assertDepthAllowed(childDepth);
      } catch (e) {
        return { content: [{ type: "text", text: String((e as Error).message ?? e) }], details: {}, isError: true };
      }
      const explicitRoutes: Array<{ route: string; location: string; agent?: string }> = [];
      if (typeof params.model === "string" && params.model.trim()) explicitRoutes.push({ route: params.model.trim(), location: "task", agent: params.agent });
      for (const [index, t] of (params.tasks ?? []).entries()) {
        if (typeof t === "object" && typeof t.model === "string" && t.model.trim()) explicitRoutes.push({ route: t.model.trim(), location: `tasks[${index}]`, agent: t.agent ?? params.agent });
      }
      for (const [index, s] of (params.chain ?? []).entries()) {
        if (typeof s.model === "string" && s.model.trim()) explicitRoutes.push({ route: s.model.trim(), location: `chain[${index}]`, agent: s.agent ?? params.agent });
      }
      const profileModel =
        params.profile && typeof params.profile === "object"
          ? (params.profile as { model?: unknown }).model
          : undefined;
      const inlineProfileModel = typeof profileModel === "string" ? profileModel.trim() : "";
      const thinkingLevelRaw = (params as { thinking_level?: unknown }).thinking_level;
      const thinkingLevel = typeof thinkingLevelRaw === "string" ? thinkingLevelRaw.trim() : "";
      const nodeThinking = [...(params.tasks ?? []), ...(params.chain ?? [])].some((item) => typeof item === "object" && Boolean(item.thinking_level));
      if (!ultra && !modelPolicy.enabled) {
        if (explicitRoutes.length > 0 || inlineProfileModel || thinkingLevel || nodeThinking) {
          return {
            content: [{ type: "text", text: "子代理路由选择未开启（设置 → 子代理 → 允许模型自选路由）" }],
            details: {},
            isError: true,
          };
        }
      } else if (!ultra) {
        const avail = availableModels(ctx as never);
        try {
          for (const request of explicitRoutes) {
            try { assertRouteAllowed(request.route, modelPolicy, avail); } catch (error) {
              throw routingError(request.location, request.agent, "model", request.route, String((error as Error).message));
            }
          }
          if (inlineProfileModel && inlineProfileModel !== "cheap" && inlineProfileModel !== "strong") {
            try { assertRouteAllowed(inlineProfileModel, modelPolicy, avail); } catch (error) {
              throw routingError("profile", params.agent, "profile.model", inlineProfileModel, String((error as Error).message));
            }
          }
        } catch (e) {
          return { content: [{ type: "text", text: String((e as Error).message ?? e) }], details: {}, isError: true };
        }
      }
      const requestedThinking = new Map<string, string>();
      const thinkingOf = (id: string | undefined): { thinkingLevel?: string } => {
        const level = runningThinkingLevel(registry, id, (id ? requestedThinking.get(id) : undefined) ?? thinkingLevel);
        return level ? { thinkingLevel: level } : {};
      };
      const hasChain = (params.chain?.length ?? 0) > 0;
      if (!spawnHasWork(params)) throw new Error("provide `task`, `tasks`, or `chain`");

      // 单会话最大子代理数（0/空＝不限）。预占在实际 spawn 前，防止先并发再统计绕过上限。
      // 所有任务只在完整参数通过授权后启动，统一预占本次名额。
      const sessionKey = sessionSpawnKey(ctx);
      const maxPerSession = sessionCap();
      const requested = hasChain ? params.chain?.length ?? 0 : list.length;
      let slotsLeft = 0;
      // 前台 run 转后台后（detach.ts），还在跑的子代理各自结束时归还名额，这里不能提前一把还掉。
      let keepReservations = false;
      const releaseOne = () => {
        if (slotsLeft <= 0) return;
        slotsLeft -= 1;
        releaseReserved(sessionKey, 1);
      };
      const transferOne = () => {
        slotsLeft = Math.max(0, slotsLeft - 1);
      };
      if (maxPerSession > 0 && requested > 0) {
        const already = sessionSpawnCount.get(sessionKey) ?? 0;
        if (already + requested > maxPerSession) {
          throw new Error(
            `已达单会话子代理上限（${maxPerSession}）：当前占用 ${already} 个，本次又请求 ${requested} 个。` +
              `已完成且无需继续的子代理会释放名额。可在「设置 → 子代理」调大「单会话最大子代理数」。`,
          );
        }
        sessionSpawnCount.set(sessionKey, already + requested);
        slotsLeft = requested;
      }

      try {

      // Named-agent resolution (markdown agents in ~/.pi/agent/agents + .pi/agents).
      // A named agent contributes its system prompt + tool allowlist + model.
      const agentScope = (params.agentScope as AgentScope | undefined) ?? "user";
      // Built-in defaults (scout/planner/reviewer/worker) are unioned in as a fallback
      // so a request for a known default never hard-fails when disk discovery is empty
      // (e.g. agentScope:"project" with no repo .pi/agents, cold start before seeding,
      // or a relocated/cleared agent dir). Disk agents still win on name clash.
      const discovered = withBuiltinDefaults(discoverAgents(ctx.cwd, agentScope).agents);
      const agentLayer = (
        name: string | undefined,
      ): { name?: string; filePath?: string; thinkingLevel?: string; systemPrompt?: string; tools?: string[]; model?: string; backend?: "worker" | "in-process" } => {
        const n = name?.trim();
        if (!n) return {};
        const a = resolveAgent(discovered, n);
        if (!a) {
          const avail = discovered.map((x) => x.name).join(", ") || "none";
          if (discovered.length === 0) {
            // 一个 agent 都没发现，多为冷启动 seed 时机 / agentDir 偏移：打印运行时真实路径，
            // 便于下次复现时直接拿到 扩展宿主 实际的 getAgentDir 与目录内容。
            try {
              const ad = getAgentDir();
              const udir = join(ad, "agents");
              const entries = existsSync(udir) ? readdirSync(udir).join(",") : "";
              console.error(
                `[multi-agent] no agents discovered (scope=${agentScope}): agentDir=${ad} userDir=${udir} exists=${existsSync(udir)} entries=[${entries}]`,
              );
            } catch (e) {
              console.error(`[multi-agent] agent-dir diag failed: ${String((e as Error)?.message ?? e)}`);
            }
          }
          const suggestion = suggestAgent(discovered, n);
          const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
          throw new Error(`unknown agent "${n}".${hint} Available agents: ${avail}`);
        }
        return { name: a.name, filePath: a.filePath, thinkingLevel: a.thinkingLevel, systemPrompt: a.systemPrompt, tools: a.tools, model: a.model, ...(a.backend ? { backend: a.backend } : {}) };
      };

      const chainHead = Array.isArray(params.chain)
        ? (params.chain[0] as { agent?: unknown } | undefined)
        : undefined;
      const hintAgent =
        (typeof params.agent === "string" && params.agent.trim()) ||
        list[0]?.agent ||
        (typeof chainHead?.agent === "string" ? chainHead.agent.trim() : "");
      let hintTools: string[] | undefined;
      if (hintAgent) {
        try {
          hintTools = agentLayer(hintAgent).tools;
        } catch {
          /* 未知名留给后面各路径抛错；名字表仍可用于推断只读/可写档 */
        }
      }
      const profile = resolveProfile(
        (params.profile as ProfileInput | undefined) ?? inferNamedAgentProfile(hintAgent || undefined, hintTools),
      );
      if (params.fork) {
        if (hasChain || list.length !== 1) throw new Error("fork 仅支持单任务");
      }
      const seedMessages = params.fork ? completedPrefix(parentLeafMessages(ctx), toolCallId) : [];
      const profileModel = ultra ? undefined : profileToModel(profile, getConfig);
      // 显式 profile 与按命名角色推断的 profile 都要落到 env + registry，否则 UI 一律显示「工作」、
      // 只读档的 SAFETY_READONLY / deny 也不会生效。
      const profileEnv: Record<string, string> = { ...profileToEnv(profile), ...routingContextEnv(ultra) };
      // 子代理继承 owner 审批策略，但把 `full` / `workspace` 下调为 `auto`：自主 spawn 的子代理
      // 对用户可见性低，不应连 safety 的危险命令确认 / 受保护路径拦截（④）都跳过。能力硬限
      // （① readonly/deny）与 owner 自身会话不受影响——这里只收紧"模型自动起的子代理"。
      // headless 下 ask 仍在 safety 内降级为 auto 行为（不全拦），故 auto 是安全且足够的下限。
      const ownerPolicy = getApprovalPolicy();
      profileEnv.APPROVAL_POLICY = ownerPolicy === "full" || ownerPolicy === "workspace" ? "auto" : ownerPolicy;
      profileEnv.SUBAGENT_DEPTH = String(childDepth);
      const limits = profileLimits(profile);
      const profileJson = JSON.stringify(profile);

      type Unit = { task: string; model?: string; agent?: string; thinking_level?: string };
      type Selection = {
        model?: string;
        thinkingLevel?: string;
        layer: ReturnType<typeof agentLayer>;
        location: string;
        /** 请求的档位不被目标模型支持、已就近收敛时记下来，回给调用方看。 */
        thinkingCoerced?: { requested: string; level: string };
      };
      const selections = new Map<Unit, Selection>();
      const units: Unit[] = params.chain?.length ? params.chain : list;
      const locationOf = (index: number) => params.chain?.length ? `chain[${index}]` : params.task && index === 0 ? "task" : `tasks[${index - (params.task ? 1 : 0)}]`;
      const selectionOf = (unit: Unit): Selection => {
        const saved = selections.get(unit);
        if (saved) return saved;
        const location = locationOf(units.indexOf(unit));
        const layer = agentLayer(unit.agent ?? params.agent);
        const chosen = ultra
          ? resolveUltraRoute({ model: unit.model, agent: layer.name ?? unit.agent, location, parent: ctx.model, available: availableModels(ctx as never) })
          : { model: pickSubagentModel(unit.model, layer.model, profileModel, ctx.model), source: layer.model ? `${layer.filePath}: model` : "普通子代理模型配置" };
        const level = unit.thinking_level?.trim() || thinkingLevel || (!ultra ? layer.thinkingLevel : undefined);
        let resolved: string | undefined;
        let coerced: Selection["thinkingCoerced"];
        if (level) {
          const model = chosen.model ? catalogModel(chosen.model, availableModels(ctx as never), !ultra) : undefined;
          const target = model ?? (routeLabel(ctx.model) === chosen.model ? ctx.model : undefined);
          try {
            if (!target) throw new Error("thinking_level 需要一个可解析的目标模型");
            // 调用方（模型）按别家的默认档猜一个本模型没有的档时，就进收敛而不是整体失败：
            // 会话本身也是收敛的（SDK clampThinkingLevel），子代理没理由比它更严。
            const pick = resolveThinkingLevel(level, target as never);
            resolved = pick.level;
            if (pick.coerced) coerced = { requested: pick.requested, level: pick.level };
          } catch (error) {
            const source = unit.thinking_level || thinkingLevel ? "thinking_level" : `${layer.filePath}: thinking_level`;
            throw routingError(location, layer.name ?? unit.agent, source, level, String((error as Error).message));
          }
        }
        const selected = { model: chosen.model, thinkingLevel: resolved, layer, location, ...(coerced ? { thinkingCoerced: coerced } : {}) };
        selections.set(unit, selected);
        return selected;
      };
      // Model configuration errors must be found before any Ultra node can create a child.
      try {
        for (const unit of units) {
          try { selectionOf(unit); } catch (error) {
            if (ultra || unit.thinking_level || thinkingLevel) throw error;
            // Preserve ordinary per-slot failure semantics for unrelated unknown agents.
          }
        }
      } catch (error) {
        return { content: [{ type: "text", text: String((error as Error).message) }], details: {}, isError: true };
      }
      /**
       * 收敛过的思考档要如实回给调用方：否则它下一步还会照旧写那个不存在的档。
       * 没收敛（或调用方没给档）时返回空串，不改动任何输出。
       */
      const coercionNote = (): string => {
        const notes = [...selections.values()]
          .filter((s) => s.thinkingCoerced)
          .map(
            (s) =>
              `${s.location} 路由 ${s.model ?? "默认"} 没有思考档 ${s.thinkingCoerced!.requested}，已改为 ${s.thinkingCoerced!.level}`,
          );
        return notes.length ? `注意：${notes.join("；")}。可用档位见 list_subagent_models。\n\n` : "";
      };

      const assertCanStart = (unit: Unit, selected: Selection) => {
        const mode = getAgentMode(projectCwd(ctx), parentSid ?? undefined);
        const gate = gateToolCall(mode, "spawn_agent", {});
        if (gate?.block) throw new Error(gate.reason);
        if (!ultra && getConfig("SUBAGENT_MODE")?.trim() === "disabled") throw new Error("普通子代理已被禁用；停止未启动的任务");
        if (unit.model && !ultra) {
          if (!modelPolicy.enabled) throw new Error("普通子代理模型自选授权已撤销；停止未启动的任务");
          assertRouteAllowed(unit.model, modelPolicy, availableModels(ctx as never));
        }
        if (unit.model && ultra) resolveUltraRoute({ model: selected.model, agent: selected.layer.name, location: selected.location, parent: ctx.model, available: availableModels(ctx as never) });
      };

      // Chain mode: run steps sequentially; each step's {previous} is replaced by
      // the prior step's output. Stops at the first failing step.
      if (params.chain && params.chain.length > 0) {
        if (action === "spawn") throw new Error("chain 暂不支持后台 spawn（请用 action:run）");
        const steps = params.chain;
        type ChainSlot = {
          step: number;
          agent?: string;
          task: string;
          model?: string;
          ok: boolean;
          output: string;
          error?: string;
          agentId?: string;
          sessionPath?: string;
          stopReason?: SubagentStopReason;
          status: "waiting" | "starting" | "running" | "done" | "error" | "cancelled";
        };
        const previewModel = (step: (typeof steps)[number]): string | undefined => {
          try {
            return selectionOf(step).model;
          } catch {
            return undefined;
          }
        };
        const slots: ChainSlot[] = steps.map((step, i) => ({
          step: i + 1,
          agent: step.agent ?? params.agent,
          task: step.task,
          model: previewModel(step),
          ok: false,
          output: "",
          status: i === 0 ? "starting" : "waiting",
        }));
        const publishChain = () => {
          onUpdate?.({
            content: [{ type: "text", text: "链式子代理运行中" }],
            details: {
              mode: "chain",
              streaming: true,
              results: slots.map((s) => ({
                step: s.step,
                task: s.task,
                ...(s.agent ? { agent: s.agent } : {}),
                ...(s.model ? { model: s.model } : {}),
                ...thinkingOf(s.agentId),
                ...(s.agentId ? { agentId: s.agentId } : {}),
                ...(s.sessionPath ? { sessionPath: s.sessionPath } : {}),
                ...(s.stopReason ? { stopReason: s.stopReason } : {}),
                status: s.status,
                ...(s.status === "done" || s.status === "error" || s.status === "cancelled"
                  ? { ok: s.status === "done", output: s.output, ...(s.error ? { error: s.error } : {}) }
                  : {}),
              })),
            },
          });
        };
        const finishedChainResults = () =>
          slots
            .filter((s) => s.status === "done" || s.status === "error" || s.status === "cancelled")
            .map((s) => ({
              step: s.step,
              agent: s.agent,
              task: s.task,
              ok: s.status === "done",
              output: s.output,
              error: s.error,
              agentId: s.agentId,
              sessionPath: s.sessionPath,
              stopReason: s.stopReason,
              ...(s.model ? { model: s.model } : {}),
              ...thinkingOf(s.agentId),
            }));
        publishChain();
        let previous = "";
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const taskText = step.task.replace(/\{previous\}/g, previous);
          const stepAgent = step.agent ?? params.agent;
          const selection = selectionOf(step);
          try {
            assertCanStart(step, selection);
          } catch (error) {
            const message = String((error as Error).message);
            slots[i] = { ...slots[i], status: "error", ok: false, error: message, output: "" };
            publishChain();
            releaseOne();
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${message}` }],
              details: { mode: "chain", stoppedAt: i + 1, results: finishedChainResults() },
              isError: true,
            };
          }
          const layer = selection.layer;
          const chosenModel = selection.model;
          const id = SubAgentRegistry.genId();
          if (selection.thinkingLevel) requestedThinking.set(id, selection.thinkingLevel);
          registry.create({
            id,
            task: taskText,
            profile: profileJson,
            model: chosenModel ?? null,
            parentId: parentSid ?? null, depth: childDepth,
          });
          slots[i] = {
            ...slots[i],
            agent: stepAgent,
            task: taskText,
            model: chosenModel,
            agentId: id,
            status: "starting",
          };
          publishChain();
          const controller = registerInflight(id, signal);
          const r = await runSubagent(ctx.cwd, taskText, id, {
            projectCwd: projectCwd(ctx),
            parentSessionPath: parentSessionPath(ctx),
            model: chosenModel,
            systemPrompt: layer.systemPrompt,
            backend: layer.backend,
            tools: layer.tools,
            env: profileEnv,
            mcp: profile.mcp,
            timeoutMs: limits.timeoutMs,
            thinkingLevel: selection.thinkingLevel,
            depth: childDepth,
            signal: controller.signal,
            onUpdate: (u) => {
              registry.progress(id, u.transcript);
              const slot = slots[i];
              if (!slot || slot.status === "done" || slot.status === "error" || slot.status === "cancelled") return;
              if (!u.sessionPath || slot.sessionPath === u.sessionPath) return;
              registry.setSessionPath(id, u.sessionPath, u.thinkingLevel);
              slots[i] = { ...slot, sessionPath: u.sessionPath, status: "running" };
              publishChain();
            },
          }).finally(() => inflight.delete(id));
          const terminal = r.ok ? "done" : controller.signal.aborted ? "cancelled" : "error";
          registry.finish(
            id,
            r.ok
              ? { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript }
              : {
                  status: terminal === "cancelled" ? "cancelled" : "error",
                  output: r.output,
                  error: r.error,
                  exitCode: r.exitCode,
                  transcript: r.transcript,
                },
          );
          slots[i] = {
            ...slots[i],
            ok: r.ok,
            output: r.output,
            error: r.error,
            agentId: id,
            sessionPath: r.sessionPath,
            stopReason: r.stopReason,
            model: chosenModel,
            status: terminal,
          };
          publishChain();
          if (!r.ok) {
            releaseOne();
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1}${stepAgent ? ` (${stepAgent})` : ""}: ${r.error ?? "failed"}` }],
              details: { mode: "chain", stoppedAt: i + 1, results: finishedChainResults() },
              isError: true,
            };
          }
          writeOneShotCatalog(pi, ctx, { childId: id, sessionPath: r.sessionPath, label: catalogLabel(taskText) });
          previous = r.output;
          releaseOne();
        }
        const last = slots[slots.length - 1];
        return {
          content: [{ type: "text", text: `${coercionNote()}${last?.output || "(no output)"}` }],
          details: { mode: "chain", results: finishedChainResults() },
        };
      }

      if (action === "spawn") {
        if (list.length !== 1) throw new Error("background spawn 仅支持单任务");
        const { task } = list[0];
        const selection = selectionOf(list[0]);
        assertCanStart(list[0], selection);
        const layer = selection.layer;
        const id = SubAgentRegistry.genId();
        const chosenModel = selection.model;
        if (selection.thinkingLevel) requestedThinking.set(id, selection.thinkingLevel);
        const parentPath = parentSessionPath(ctx);
        const workspace = currentWorkspaceContext()?.workspace ?? ctx.cwd;
        const spawnedText =
          coercionNote() +
          `Background sub-agent started. agentId: ${id}\n` +
          "You will get a subagent-settled notice when it finishes; call wait_agent only if your next step is blocked on it.";
        // 不能续聊的后端（CLI、worker 进程里的父会话）：后台跑一次，结束时由管理器发结算通知。
        const startBackground = (): void => {
          registry.create({ id, task, profile: profileJson, model: chosenModel ?? null, parentId: parentSid ?? null, depth: childDepth });
          const controller = new AbortController();
          inflight.set(id, controller);
          startBackgroundRun(ctx.cwd, task, id, {
            projectCwd: projectCwd(ctx),
            parentSessionId: parentSid ?? "",
            parentSessionPath: parentPath,
            model: chosenModel,
            systemPrompt: layer.systemPrompt,
            backend: layer.backend,
            tools: layer.tools,
            env: profileEnv,
            mcp: profile.mcp,
            timeoutMs: limits.timeoutMs,
            depth: childDepth,
            thinkingLevel: selection.thinkingLevel,
            signal: controller.signal,
            onUpdate: (u) => {
              if (u.sessionPath) registry.setSessionPath(id, u.sessionPath, u.thinkingLevel);
              registry.progress(id, u.transcript);
            },
            onSettled: (r) => {
              // 记账失败也要归还名额（释放边界，teardown.ts）。
              try {
                finishQuietly(registry, id, r.ok
                  ? { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript }
                  : {
                      status: controller.signal.aborted ? "cancelled" : "error",
                      output: r.output,
                      error: r.error,
                      exitCode: r.exitCode,
                      transcript: r.transcript,
                    });
                if (r.ok) writeOneShotCatalog(pi, ctx, { childId: id, sessionPath: r.sessionPath, label: catalogLabel(task) });
              } finally {
                inflight.delete(id);
                releaseReserved(sessionKey, 1);
              }
            },
            deliver: (notice) => deliverSettlement(pi, ctx, parentPath, workspace, notice, spawner),
          });
        };

        if (selectSubagentBackend(layer.backend).capabilities.continuable) {
          registry.create({
            id,
            task,
            profile: profileJson,
            model: chosenModel ?? null,
            parentId: parentSid ?? null, depth: childDepth,
          });
          const controller = new AbortController();
          inflight.set(id, controller);
          try {
            const started = await startContinuableSubagent({
              cwd: ctx.cwd,
              projectCwd: projectCwd(ctx),
              task,
              agentId: id,
              parentSessionPath: parentPath,
              parentSessionId: parentSid,
              model: chosenModel,
              systemPrompt: layer.systemPrompt,
              backend: preferredBackend(layer.backend),
              deliverFallback: (notice) => sendSettlementViaExtension(pi, ctx, notice, spawner),
              tools: layer.tools,
              env: profileEnv,
              mcp: profile.mcp,
              timeoutMs: limits.timeoutMs,
              thinkingLevel: isThinkingLevel(selection.thinkingLevel) ? selection.thinkingLevel : undefined,
              seedMessages,
              depth: childDepth,
              parentActivationId: parentSid && getActivation(parentSid) ? parentSid : undefined,
              signal: controller.signal,
              onUpdate: (u) => {
                if (u.sessionPath) registry.setSessionPath(id, u.sessionPath, u.thinkingLevel);
                registry.progress(id, u.transcript);
              },
              onSettled: (info) => {
                const status =
                  info.stopReason === "aborted" ? "cancelled" : info.stopReason === "error" ? "error" : "done";
                // 记账失败也要归还名额（释放边界，teardown.ts）。
                finishQuietly(registry, id, {
                  status,
                  output: info.output,
                  exitCode: status === "done" ? 0 : -1,
                  ...(info.diagnostic ? { error: info.diagnostic } : {}),
                });
                inflight.delete(id);
                releaseReserved(sessionKey, 1);
              },
            });
            registry.setSessionPath(id, started.sessionPath);
            try {
              writeParentCatalog(pi, ctx, {
                childId: id,
                sessionPath: started.sessionPath,
                mode: "continuable",
                label: catalogLabel(task),
              });
            } catch (e) {
              await disposeActivation(id, "rollback");
              throw e;
            }
            transferOne();
            return {
              content: [{ type: "text", text: spawnedText }],
              details: {
                agentId: id,
                sessionPath: started.sessionPath,
                mode: "continuable",
                status: "running",
                ...(chosenModel ? { model: chosenModel } : {}),
                ...thinkingOf(id),
                ...forkDetails(params.fork, seedMessages),
              },
            };
          } catch (e) {
            inflight.delete(id);
            registry.finish(id, {
              status: "error",
              error: String((e as Error)?.message ?? e),
              exitCode: -1,
            });
            throw e;
          }
        }

        startBackground();
        transferOne();
        return {
          content: [{ type: "text", text: spawnedText }],
          details: { agentId: id, status: "running", ...(chosenModel ? { model: chosenModel } : {}), ...thinkingOf(id) },
        };
      }

      if (list.length === 1) {
        const { task } = list[0];
        const selection = selectionOf(list[0]);
        assertCanStart(list[0], selection);
        const layer = selection.layer;
        const chosenModel = selection.model;
        const id = SubAgentRegistry.genId();
        if (selection.thinkingLevel) requestedThinking.set(id, selection.thinkingLevel);
        registry.create({
          id,
          task,
          profile: profileJson,
          model: chosenModel ?? null,
          parentId: parentSid ?? null, depth: childDepth,
        });
        // 用户在等待期间发话就把它转到后台（detach.ts）；转后台之后这一轮被打断不再连带取消它。
        const linked = detachableSignal(signal);
        const controller = registerInflight(id, linked.signal);
        const parentPath = parentSessionPath(ctx);
        const workspace = currentWorkspaceContext()?.workspace ?? ctx.cwd;
        const fg = new ForegroundRun({
          parentSessionId: parentSid ?? "",
          deliver: (notice) => deliverSettlement(pi, ctx, parentPath, workspace, notice, spawner),
          unlinkAbort: linked.unlink,
        });
        let seenThinkingLevel: string | undefined;
        let seenSessionPath: string | undefined;
        let detached = false;
        try {
          fg.started(id);
          const running = runSubagent(ctx.cwd, task, id, {
            projectCwd: projectCwd(ctx),
            parentSessionPath: parentSessionPath(ctx),
            model: chosenModel,
            systemPrompt: layer.systemPrompt,
            backend: layer.backend,
            tools: layer.tools,
            env: profileEnv,
            mcp: profile.mcp,
            timeoutMs: limits.timeoutMs,
            thinkingLevel: selection.thinkingLevel,
            seedMessages,
            depth: childDepth,
            signal: controller.signal,
            onUpdate: (u) => {
              // 写 transcript（registry 内部截断；progress 也 bump updatedAt → 保留 stuck detection 心跳）：
              // 让从 Bot 菜单点开「运行中的前台单任务」也能像主对话内联一样实时回放（兜底视图读 registry）。
              registry.progress(id, u.transcript);
              if (u.thinkingLevel && u.thinkingLevel !== seenThinkingLevel) {
                seenThinkingLevel = u.thinkingLevel;
                registry.setThinkingLevel(id, u.thinkingLevel);
              }
              if (u.sessionPath) seenSessionPath = u.sessionPath;
              // 转后台之后这次工具调用已经返回，不再往它身上推进度；界面改跟注册表。
              if (onUpdate && !fg.detached) {
                onUpdate({
                  content: [{ type: "text", text: u.text }],
                  details: u.sessionPath
                    ? { streaming: true, agentId: id, sessionPath: u.sessionPath, ...thinkingOf(id) }
                    : {
                        streaming: true,
                        transcriptTail: tailLines(u.transcript, LIVE_TRANSCRIPT_TAIL),
                      },
                });
              }
            },
          });
          const outcome = await waitOrDetach(running, {
            enabled: !nestedCall,
            hasPendingInput: () => steerWaiting(ctx),
          });
          if (outcome.detached) {
            detached = true;
            keepReservations = true;
            fg.detach();
            // 结束时照前台的规矩记账，再由 ForegroundRun 发结算通知；名额占到它结束为止。
            void running
              .catch((e: unknown) => ({
                ok: false,
                output: "",
                exitCode: -1,
                error: String((e as Error)?.message ?? e),
                transcript: "",
                sessionPath: undefined as string | undefined,
                stopReason: controller.signal.aborted ? ("aborted" as const) : ("error" as const),
                diagnostic: String((e as Error)?.message ?? e),
              }))
              .then((r) => {
                try {
                  registry.finish(
                    id,
                    r.ok
                      ? { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript }
                      : {
                          status: controller.signal.aborted ? "cancelled" : "error",
                          output: r.output,
                          error: r.error,
                          exitCode: r.exitCode,
                          transcript: r.transcript,
                        },
                  );
                  if (r.ok) writeOneShotCatalog(pi, ctx, { childId: id, sessionPath: r.sessionPath, label: catalogLabel(task) });
                } catch {
                  /* 记账出错不能挡住通知 */
                } finally {
                  inflight.delete(id);
                  releaseOne();
                }
                fg.finished(id, r);
              });
            return {
              content: [{ type: "text", text: detachedSingleText(id) }],
              details: {
                agentId: id,
                ...(seenSessionPath ? { sessionPath: seenSessionPath } : {}),
                status: "running",
                detached: true,
                ...(chosenModel ? { model: chosenModel } : {}),
                ...thinkingOf(id),
              },
            };
          }
          const r = outcome.value;
          fg.finished(id, r);
          if (!r.ok) {
            const aborted = controller.signal.aborted;
            registry.finish(id, {
              status: aborted ? "cancelled" : "error",
              output: r.output,
              error: r.error,
              exitCode: r.exitCode,
              transcript: r.transcript,
            });
            // 超时被杀或模型报错但已产出实质内容：保留「已写部分」返回（附中断原因），而不是抛错把成果丢掉。
            if (!aborted && r.partial && r.output.trim()) {
              const partialText = `${r.output}\n\n_(未正常结束：${r.error ?? "timeout"}；以上为已产出部分)_`;
              return {
                content: [{ type: "text", text: partialText }],
                details: subagentDetails(id, r, {
                  partial: true,
                  transcript: r.sessionPath ? undefined : tailLines(r.transcript, TRANSCRIPT_CAP),
                  // 和正常完成一样写实际路由与档位：否则卡片只能退回参数里的 cheap / strong 别名。
                  ...(chosenModel ? { model: chosenModel } : {}),
                  ...thinkingOf(id),
                }),
              };
            }
            throw new Error(`sub-agent failed (exit ${r.exitCode}): ${r.error ?? "unknown error"}`);
          }
          registry.finish(id, { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript });
          writeOneShotCatalog(pi, ctx, { childId: id, sessionPath: r.sessionPath, label: catalogLabel(task) });
          return {
            content: [{ type: "text", text: `${coercionNote()}${r.output || "(no output)"}` }],
            details: subagentDetails(id, r, {
              transcript: r.sessionPath ? undefined : tailLines(r.transcript, TRANSCRIPT_CAP),
              ...(chosenModel ? { model: chosenModel } : {}),
              ...thinkingOf(id),
              ...forkDetails(params.fork, seedMessages),
            }),
          };
        } finally {
          // 转后台的那份由它结束时自己收尾。
          if (!detached) {
            inflight.delete(id);
            releaseOne();
            linked.unlink();
          }
        }
      }

      const slots: Array<{
        task: string;
        ok: boolean;
        output: string;
        error?: string;
        partial?: boolean;
        agentId?: string;
        sessionPath?: string;
        stopReason?: SubagentStopReason;
        model?: string;
        settled?: boolean;
      }> = list.map((t) => ({ task: t.task, ok: false, output: "", model: t.model }));
      // 档案显式 limits.maxConcurrency 仍可收紧。默认一次把本次 tasks 全部拉起来：
      // 固定 4 路会让第 5 个一直排在队列里，会话列表却已经按参数画出 5 行。
      const concurrency = Math.max(1, limits.maxConcurrency ?? list.length);
      // 用户在等待期间发话：已经结束的照常返回，还在跑的转到后台（detach.ts）。
      const linkedAll = detachableSignal(signal);
      const groupParentPath = parentSessionPath(ctx);
      const groupWorkspace = currentWorkspaceContext()?.workspace ?? ctx.cwd;
      const fgAll = new ForegroundRun({
        parentSessionId: parentSid ?? "",
        deliver: (notice) => deliverSettlement(pi, ctx, groupParentPath, groupWorkspace, notice, spawner),
        unlinkAbort: linkedAll.unlink,
      });
      const publishLive = () => {
        // 转后台之后这次工具调用已经返回，不再往它身上推进度。
        if (fgAll.detached) return;
        onUpdate?.({
          content: [{ type: "text", text: "并行子代理运行中" }],
          details: {
            mode: "parallel",
            streaming: true,
            count: slots.length,
            results: slots.map((s) => ({
              task: s.task,
              ...(s.agentId ? { agentId: s.agentId } : {}),
              ...(s.sessionPath ? { sessionPath: s.sessionPath } : {}),
              ...(s.model ? { model: s.model } : {}),
              ...thinkingOf(s.agentId),
              ...(s.settled
                ? { ok: s.ok, status: s.ok ? "done" : "error" }
                : { status: s.sessionPath ? "running" : "starting" }),
            })),
          },
        });
      };
      const runOne = async (i: number): Promise<void> => {
        const t = list[i];
        let id: string | undefined;
        let settledAs: Pick<SubagentResult, "stopReason" | "output" | "sessionPath" | "diagnostic"> | undefined;
        try {
          const selection = selectionOf(t);
          assertCanStart(t, selection);
          const layer = selection.layer;
          const subId = SubAgentRegistry.genId();
          id = subId;
          const chosenModel = selection.model;
          if (selection.thinkingLevel) requestedThinking.set(subId, selection.thinkingLevel);
          registry.create({
            id: subId,
            task: t.task,
            profile: profileJson,
            model: chosenModel ?? null,
            parentId: parentSid ?? null, depth: childDepth,
          });
          slots[i] = { ...slots[i], task: t.task, agentId: subId, model: chosenModel };
          publishLive();
          fgAll.started(subId);
          const controller = registerInflight(subId, linkedAll.signal);
          const r = await runSubagent(ctx.cwd, t.task, subId, {
            projectCwd: projectCwd(ctx),
            parentSessionPath: parentSessionPath(ctx),
            model: chosenModel,
            systemPrompt: layer.systemPrompt,
            backend: layer.backend,
            tools: layer.tools,
            env: profileEnv,
            mcp: profile.mcp,
            timeoutMs: limits.timeoutMs,
            thinkingLevel: selection.thinkingLevel,
            depth: childDepth,
            signal: controller.signal,
            onUpdate: (u) => {
              registry.progress(subId, u.transcript);
              if (!u.sessionPath || slots[i]?.sessionPath === u.sessionPath) return;
              registry.setSessionPath(subId, u.sessionPath, u.thinkingLevel);
              slots[i] = { ...slots[i], task: t.task, agentId: subId, sessionPath: u.sessionPath };
              publishLive();
            },
          }).finally(() => inflight.delete(subId));
          registry.finish(
            subId,
            r.ok
              ? { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript }
              : {
                  status: controller.signal.aborted ? "cancelled" : "error",
                  output: r.output,
                  error: r.error,
                  exitCode: r.exitCode,
                  transcript: r.transcript,
                },
          );
          slots[i] = {
            task: t.task,
            ok: r.ok,
            output: r.output,
            error: r.error,
            partial: r.partial,
            agentId: subId,
            sessionPath: r.sessionPath,
            stopReason: r.stopReason,
            model: chosenModel,
            settled: true,
          };
          publishLive();
          if (r.ok) {
            writeOneShotCatalog(pi, ctx, { childId: subId, sessionPath: r.sessionPath, label: catalogLabel(t.task) });
          }
          settledAs = r;
        } catch (e) {
          // 单个任务异常（如未知 agent、registry 写入失败）不应 reject 整个 Promise.all 而遗弃其它
          // 正在运行的兄弟任务：就地记为该任务的失败结果，其余 worker 照常跑完。
          const msg = String((e as Error)?.message ?? e);
          if (id) finishQuietly(registry, id, { status: "error", error: msg, exitCode: -1 });
          slots[i] = { task: t.task, ok: false, output: "", error: msg, agentId: id, settled: true };
          publishLive();
          settledAs = { stopReason: "error", output: "", diagnostic: msg };
        } finally {
          releaseOne();
          // 转后台之后靠它发结算通知，上面哪一步出错都要走到。
          if (id && fgAll.isRunning(id)) {
            fgAll.finished(id, settledAs ?? { stopReason: "error", output: "", diagnostic: "sub-agent ended without a result" });
          }
        }
      };
      // 滑动窗口并发：concurrency 个 worker 各自从队列取下一个任务，单个卡住只占一个槽位——不再像
      // 「分批 + Promise.all」那样被批内最慢/卡住的一个拖住，导致后续任务永远不开始。
      publishLive();
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        for (let i = nextIndex++; i < list.length; i = nextIndex++) {
          await runOne(i);
        }
      };
      const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => worker());
      const all = Promise.all(workers);
      const outcome = await waitOrDetach(all, { enabled: !nestedCall, hasPendingInput: () => steerWaiting(ctx) });
      // 那一刻其实都已经结束、只差收尾的，照常等完返回。
      const moving = outcome.detached && slots.some((s) => !s.settled || fgAll.isRunning(s.agentId));
      if (moving) {
        keepReservations = true;
        fgAll.detach();
        // 还没轮到的任务由 worker 在后台接着起；全部结束后把没用上的预占名额还掉。
        const releaseLeft = () => {
          if (slotsLeft > 0) releaseReserved(sessionKey, slotsLeft);
          slotsLeft = 0;
        };
        void all.then(releaseLeft, releaseLeft);
        return detachedParallelResult(slots, fgAll, thinkingOf);
      }
      if (outcome.detached) await all;
      linkedAll.unlink();

      const body = slots
        .map((r, i) => {
          const head = `## Sub-agent ${i + 1}${r.ok ? "" : " (failed)"}`;
          if (r.ok) return `${head}\n\n${r.output || "(no output)"}`;
          // 失败但已产出部分内容（超时 / 模型报错）：保留已写部分 + 中断原因，而不是丢成纯 Error。
          if (r.partial && r.output.trim()) {
            return `${head}\n\n${r.output}\n\n_(未正常结束：${r.error ?? "timeout"}；以上为已产出部分)_`;
          }
          return `${head}\n\nError: ${r.error}`;
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: `${coercionNote()}${body}` }],
        details: {
          mode: "parallel",
          count: slots.length,
          failed: slots.filter((r) => !r.ok).length,
          results: slots.map((r) => ({
            task: r.task,
            ok: r.ok,
            output: r.output,
            error: r.error,
            agentId: r.agentId,
            sessionPath: r.sessionPath,
            stopReason: r.stopReason,
            ...(r.model ? { model: r.model } : {}),
            ...thinkingOf(r.agentId),
          })),
        },
      };
      } finally {
        if (!keepReservations && slotsLeft > 0) releaseReserved(sessionKey, slotsLeft);
      }
    },
  });

  registerAdjacentTools(pi);
  registerListAgents(pi);
  // 直接父会话 id 与 spawn 时登记的 parentSessionId 一致（拿不到会话 id 时都是空串）。
  registerWaitAgent(pi, {
    parentKey: (ctx) => parentSessionId(ctx) ?? "",
    labelOf: (cwd, childId) => {
      try {
        const task = getRegistry(cwd).get(childId)?.task;
        return task ? catalogLabel(task) : undefined;
      } catch {
        return undefined;
      }
    },
  });

  // Periodic stuck reaping across all open registries (unref'd so it never keeps
  // the process alive). Lazy reaping on list/status covers on-demand cases.
  const stuckTimer = setInterval(() => {
    forEachRegistry((reg) => reapStuck(reg));
  }, 60000);
  stuckTimer.unref?.();
}
