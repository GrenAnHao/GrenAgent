// multi-agent: delegate work to pi sub-agents, each with its own context window.
// Single task, several in parallel, or a chain. Execution goes through manager.ts,
// which picks the in-process or worker backend.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
import { assertRouteAllowed, assertThinkingLevel, isThinkingLevel, readModelSelectionPolicy, resolveRouteAlias, routeOf, THINKING_LEVELS } from "./model-selection.js";
import { availableModels, registerListSubagentModels } from "./list-models-tool.js";
import type { SubagentStopReason } from "./assistant-output.js";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import { projectCwd } from "../_shared/session-cwd.js";
import { closedStringField, normalizeTasks, spawnHasWork } from "./tasks.js";
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
import { adoptSpawnBatch, appendSpawnDelta, rekeySpawnTool, rememberSpawnTool, type EarlyBatch, type EarlySlot } from "./parallel-early.js";

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
// 可继续的子代理要等收尾、没有后续消息才释放。进程内状态，sidecar 重启清零。
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

function tryReserveOne(sessionKey: string): boolean {
  const max = sessionCap();
  if (max <= 0) return true;
  const already = sessionSpawnCount.get(sessionKey) ?? 0;
  if (already + 1 > max) return false;
  sessionSpawnCount.set(sessionKey, already + 1);
  return true;
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
  const omittedModel = {} as ReturnType<typeof modelField>;
  const maybeModel = (desc: string) => (modelPolicy.enabled ? modelField(desc) : omittedModel);
  const thinkingLevelField = {
    thinking_level: Type.Optional(
      Type.Union(
        THINKING_LEVELS.map((l) => Type.Literal(l)),
        { description: "Thinking level for the child model; only levels listed by `list_subagent_models` for that route." },
      ),
    ),
  };
  const maybeThinkingLevel = () => (modelPolicy.enabled ? thinkingLevelField : ({} as typeof thinkingLevelField));

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
  // 而不是仅靠 spawn_agent 懒触发 getRegistry。否则 sidecar 重启后只要主代理不再 spawn，遗留的
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

  const launchEarly = (
    ctx: Parameters<typeof sessionSpawnKey>[0] & { model?: { provider?: string; id?: string } },
    batch: EarlyBatch,
    index: number,
    task: { task: string; model?: string; agent?: string },
  ): Promise<void> => {
    const sessionKey = sessionSpawnKey(ctx);
    const slot: EarlySlot = { task: task.task, ok: false, output: "", settled: false, model: task.model };
    batch.slots[index] = slot;
    if (!tryReserveOne(sessionKey)) {
      slot.settled = true;
      slot.error = "已达单会话子代理上限";
      return Promise.resolve();
    }
    const controller = new AbortController();
    batch.abortors.push(controller);
    const id = SubAgentRegistry.genId();
    slot.agentId = id;
    // 和其余前台路径一样登记进 inflight：转到后台以后，界面上的取消和卡死回收只能从这里够到它。
    inflight.set(id, controller);
    const profileName = closedStringField(batch.raw, "profile");
    const profile = resolveProfile(typeof profileName === "string" ? (profileName as ProfileInput) : undefined);
    const profileEnv = profileToEnv(profile);
    const ownerPolicy = getApprovalPolicy();
    profileEnv.APPROVAL_POLICY = ownerPolicy === "full" || ownerPolicy === "workspace" ? "auto" : ownerPolicy;
    const depth = childDepthOf(ctx as never);
    profileEnv.SUBAGENT_DEPTH = String(depth);
    const chosenModel = pickSubagentModel(task.model, undefined, profileToModel(profile, getConfig), ctx.model);
    slot.model = chosenModel;
    let systemPrompt: string | undefined;
    let tools: string[] | undefined;
    let backend: "worker" | "in-process" | undefined;
    if (task.agent) {
      try {
        const found = resolveAgent(withBuiltinDefaults(discoverAgents(ctx.cwd, "user").agents), task.agent);
        systemPrompt = found?.systemPrompt;
        tools = found?.tools;
        backend = found?.backend;
      } catch {
        /* 命名档案解析失败留给 execute 路径记失败 */
      }
    }
    const registry = getRegistry(projectCwd(ctx));
    registry.create({
      id,
      task: task.task,
      profile: JSON.stringify(profile),
      model: chosenModel ?? null,
      parentId: parentSessionId(ctx),
      depth,
    });
    return runSubagent(ctx.cwd, task.task, id, {
      projectCwd: projectCwd(ctx),
      parentSessionPath: parentSessionPath(ctx),
      model: chosenModel,
      systemPrompt,
      tools,
      backend,
      env: profileEnv,
      timeoutMs: profileLimits(profile).timeoutMs,
      depth,
      signal: controller.signal,
      onUpdate: (u) => {
        registry.progress(id, u.transcript);
        if (u.sessionPath) {
          registry.setSessionPath(id, u.sessionPath, u.thinkingLevel);
          slot.sessionPath = u.sessionPath;
        }
      },
    }).then((r) => {
      slot.ok = r.ok;
      slot.output = r.output;
      slot.error = r.error;
      slot.partial = r.partial;
      slot.sessionPath = r.sessionPath;
      slot.stopReason = r.stopReason;
      slot.settled = true;
      // 父回合中止（abortEarly）记 cancelled，和其余路径一致；否则注册表里分不出是被停还是自己失败。
      finishQuietly(registry, id, r.ok
        ? { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript }
        : {
            status: controller.signal.aborted ? "cancelled" : "error",
            output: r.output,
            error: r.error,
            exitCode: r.exitCode,
            transcript: r.transcript,
          });
    }, (e: unknown) => {
      const msg = String((e as Error)?.message ?? e);
      slot.ok = false;
      slot.error = msg;
      slot.settled = true;
      finishQuietly(registry, id, { status: "error", error: msg, exitCode: -1 });
    }).finally(() => {
      inflight.delete(id);
      releaseReserved(sessionKey, 1);
      // 转后台之后靠它发结算通知，前面记账出错也要走到。
      try {
        batch.onSettled?.(slot);
      } catch {
        /* 通知出错不能让这一项的 Promise 失败，连累整组 */
      }
    });
  };

  pi.on("message_update", (event, ctx) => {
    if (process.env.PI_IS_SUBAGENT === "1") return;
    const ame = event.assistantMessageEvent as {
      type?: string;
      toolName?: string;
      contentIndex?: number;
      id?: string;
      delta?: string;
      toolCall?: { id?: string; name?: string };
    };
    if (ame.type === "toolcall_start" && ame.toolName === "spawn_agent" && typeof ame.contentIndex === "number") {
      rememberSpawnTool(ame.contentIndex, ame.id || `idx:${ame.contentIndex}`);
      return;
    }
    if (ame.type === "toolcall_end" && ame.toolCall?.name === "spawn_agent" && typeof ame.contentIndex === "number" && ame.toolCall.id) {
      rekeySpawnTool(ame.contentIndex, ame.toolCall.id);
      return;
    }
    if (ame.type !== "toolcall_delta" || typeof ame.contentIndex !== "number" || typeof ame.delta !== "string") return;
    const noted = appendSpawnDelta(ame.contentIndex, ame.delta);
    if (!noted) return;
    if (closedStringField(noted.batch.raw, "profile") === null) return;
    for (let i = noted.batch.runs.length; i < noted.tasks.length; i++) {
      const task = noted.tasks[i];
      if (!task) continue;
      noted.batch.runs.push(launchEarly(ctx, noted.batch, i, task));
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
      ...(modelPolicy.enabled
        ? [
            "开启自选路由时先调用 list_subagent_models，只用它列出的路由。它列出的 cheap / strong 别名可直接写进 model：省钱的调研用 cheap，难任务用 strong。",
            "fork: true 时换模型会失去父前缀缓存，非必要不换。",
          ]
        : []),
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
      const registry = getRegistry(projectCwd(ctx));

      // 模型策略「禁用子代理」：直接拒绝 run/spawn（status/list/cancel/remove 仍可用于善后历史任务）。
      if ((action === "run" || action === "spawn") && getConfig("SUBAGENT_MODE")?.trim() === "disabled") {
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
      const explicitRoutes: string[] = [];
      if (typeof params.model === "string" && params.model.trim()) explicitRoutes.push(params.model.trim());
      for (const t of params.tasks ?? []) {
        if (typeof t === "object" && typeof t.model === "string" && t.model.trim()) explicitRoutes.push(t.model.trim());
      }
      for (const s of params.chain ?? []) {
        if (typeof s.model === "string" && s.model.trim()) explicitRoutes.push(s.model.trim());
      }
      const profileModel =
        params.profile && typeof params.profile === "object"
          ? (params.profile as { model?: unknown }).model
          : undefined;
      const inlineProfileModel = typeof profileModel === "string" ? profileModel.trim() : "";
      const thinkingLevelRaw = (params as { thinking_level?: unknown }).thinking_level;
      const thinkingLevel = typeof thinkingLevelRaw === "string" ? thinkingLevelRaw.trim() : "";
      if (!modelPolicy.enabled) {
        if (explicitRoutes.length > 0 || inlineProfileModel || thinkingLevel) {
          return {
            content: [{ type: "text", text: "子代理路由选择未开启（设置 → 子代理 → 允许模型自选路由）" }],
            details: {},
            isError: true,
          };
        }
      } else {
        const avail = availableModels(ctx as never);
        try {
          for (const route of explicitRoutes) assertRouteAllowed(route, modelPolicy, avail);
          if (inlineProfileModel && inlineProfileModel !== "cheap" && inlineProfileModel !== "strong") {
            assertRouteAllowed(inlineProfileModel, modelPolicy, avail);
          }
          if (thinkingLevel) {
            const targetRaw = explicitRoutes[0] ?? inlineProfileModel;
            const target = targetRaw ? resolveRouteAlias(targetRaw) : undefined;
            const model = avail.find((m) => routeOf(m) === target) ?? avail.find((m) => routeOf(m) === (parentModelSpec(ctx.model) ?? ""));
            if (!model) throw new Error("thinking_level 需要一个可解析的目标模型");
            assertThinkingLevel(thinkingLevel, model);
          }
        } catch (e) {
          return { content: [{ type: "text", text: String((e as Error).message ?? e) }], details: {}, isError: true };
        }
      }
      const thinkingOf = (id: string | undefined): { thinkingLevel?: string } => {
        const level = runningThinkingLevel(registry, id, thinkingLevel);
        return level ? { thinkingLevel: level } : {};
      };
      const hasChain = (params.chain?.length ?? 0) > 0;
      if (!spawnHasWork(params)) throw new Error("provide `task`, `tasks`, or `chain`");

      // 单会话最大子代理数（0/空＝不限）。预占在实际 spawn 前，防止先并发再统计绕过上限。
      // 流式阶段已经开工的并行任务各自占过名额，这里只补还没启动的。
      const sessionKey = sessionSpawnKey(ctx);
      const earlyBatch = adoptSpawnBatch(toolCallId);
      const earlyStarted = earlyBatch?.runs.length ?? 0;
      const maxPerSession = sessionCap();
      const requested = Math.max(0, (hasChain ? params.chain?.length ?? 0 : list.length) - earlyStarted);
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
      if (maxPerSession > 0 && earlyStarted === 0 && requested > 0) {
        const already = sessionSpawnCount.get(sessionKey) ?? 0;
        if (already + requested > maxPerSession) {
          throw new Error(
            `已达单会话子代理上限（${maxPerSession}）：当前占用 ${already} 个，本次又请求 ${requested} 个。` +
              `已完成且无需继续的子代理会释放名额。可在「设置 → 子代理」调大「单会话最大子代理数」。`,
          );
        }
        sessionSpawnCount.set(sessionKey, already + requested);
        slotsLeft = requested;
      } else if (maxPerSession > 0 && requested > 0) {
        const already = sessionSpawnCount.get(sessionKey) ?? 0;
        const room = Math.max(0, maxPerSession - already);
        const take = Math.min(room, requested);
        if (take > 0) sessionSpawnCount.set(sessionKey, already + take);
        slotsLeft = take;
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
      ): { systemPrompt?: string; tools?: string[]; model?: string; backend?: "worker" | "in-process" } => {
        const n = name?.trim();
        if (!n) return {};
        const a = resolveAgent(discovered, n);
        if (!a) {
          const avail = discovered.map((x) => x.name).join(", ") || "none";
          if (discovered.length === 0) {
            // 一个 agent 都没发现，多为冷启动 seed 时机 / agentDir 偏移：打印运行时真实路径，
            // 便于下次复现时直接拿到 sidecar 实际的 getAgentDir 与目录内容。
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
        return { systemPrompt: a.systemPrompt, tools: a.tools, model: a.model, ...(a.backend ? { backend: a.backend } : {}) };
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
      const profileModel = profileToModel(profile, getConfig);
      // 显式 profile 与按命名角色推断的 profile 都要落到 env + registry，否则 UI 一律显示「工作」、
      // 只读档的 SAFETY_READONLY / deny 也不会生效。
      const profileEnv: Record<string, string> = profileToEnv(profile);
      // 子代理继承 owner 审批策略，但把 `full` / `workspace` 下调为 `auto`：自主 spawn 的子代理
      // 对用户可见性低，不应连 safety 的危险命令确认 / 受保护路径拦截（④）都跳过。能力硬限
      // （① readonly/deny）与 owner 自身会话不受影响——这里只收紧"模型自动起的子代理"。
      // headless 下 ask 仍在 safety 内降级为 auto 行为（不全拦），故 auto 是安全且足够的下限。
      const ownerPolicy = getApprovalPolicy();
      profileEnv.APPROVAL_POLICY = ownerPolicy === "full" || ownerPolicy === "workspace" ? "auto" : ownerPolicy;
      profileEnv.SUBAGENT_DEPTH = String(childDepth);
      const limits = profileLimits(profile);
      const profileJson = JSON.stringify(profile);

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
          const named = step.agent ?? params.agent;
          try {
            return pickSubagentModel(step.model, agentLayer(named).model, profileModel, ctx.model);
          } catch {
            return pickSubagentModel(step.model, undefined, profileModel, ctx.model);
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
          const layer = agentLayer(stepAgent);
          const chosenModel = pickSubagentModel(step.model, layer.model, profileModel, ctx.model);
          const id = SubAgentRegistry.genId();
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
            thinkingLevel: thinkingLevel || undefined,
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
          content: [{ type: "text", text: last?.output || "(no output)" }],
          details: { mode: "chain", results: finishedChainResults() },
        };
      }

      if (action === "spawn") {
        if (list.length !== 1) throw new Error("background spawn 仅支持单任务");
        const { task, model, agent } = list[0];
        const layer = agentLayer(agent);
        const id = SubAgentRegistry.genId();
        const chosenModel = pickSubagentModel(model, layer.model, profileModel, ctx.model);
        const parentPath = parentSessionPath(ctx);
        const workspace = currentWorkspaceContext()?.workspace ?? ctx.cwd;
        const spawnedText =
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
            thinkingLevel: thinkingLevel || undefined,
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
              thinkingLevel: isThinkingLevel(thinkingLevel) ? thinkingLevel : undefined,
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
        const { task, model, agent } = list[0];
        const layer = agentLayer(agent);
        const chosenModel = pickSubagentModel(model, layer.model, profileModel, ctx.model);
        const id = SubAgentRegistry.genId();
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
            thinkingLevel: thinkingLevel || undefined,
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
            content: [{ type: "text", text: r.output || "(no output)" }],
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
      }> = list.map((t, i) => earlyBatch?.slots[i] ?? { task: t.task, ok: false, output: "", model: t.model });
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
        if (maxPerSession > 0 && earlyStarted > 0 && i >= earlyStarted + slotsLeft) {
          slots[i] = { task: t.task, ok: false, output: "", error: "已达单会话子代理上限", settled: true };
          publishLive();
          return;
        }
        let id: string | undefined;
        let settledAs: Pick<SubagentResult, "stopReason" | "output" | "sessionPath" | "diagnostic"> | undefined;
        try {
          const layer = agentLayer(t.agent);
          const subId = SubAgentRegistry.genId();
          id = subId;
          const chosenModel = pickSubagentModel(t.model, layer.model, profileModel, ctx.model);
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
            thinkingLevel: thinkingLevel || undefined,
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
          if (i >= earlyStarted) releaseOne();
          // 转后台之后靠它发结算通知，上面哪一步出错都要走到。
          if (id && fgAll.isRunning(id)) {
            fgAll.finished(id, settledAs ?? { stopReason: "error", output: "", diagnostic: "sub-agent ended without a result" });
          }
        }
      };
      // 滑动窗口并发：concurrency 个 worker 各自从队列取下一个任务，单个卡住只占一个槽位——不再像
      // 「分批 + Promise.all」那样被批内最慢/卡住的一个拖住，导致后续任务永远不开始。
      if (earlyBatch) {
        const abortEarly = () => {
          for (const controller of earlyBatch.abortors) controller.abort();
        };
        if (linkedAll.signal.aborted) abortEarly();
        else linkedAll.signal.addEventListener("abort", abortEarly, { once: true });
        // 流式阶段已经开工的那几个：还在跑的记进这次前台 run，结束时经它（转后台后发通知）。
        for (const slot of earlyBatch.slots) if (slot?.agentId && !slot.settled) fgAll.started(slot.agentId);
        earlyBatch.onSettled = (slot) => {
          if (slot.agentId && fgAll.isRunning(slot.agentId)) {
            fgAll.finished(slot.agentId, {
              stopReason: (slot.stopReason as SubagentStopReason | undefined) ?? (slot.ok ? "completed" : "error"),
              output: slot.output,
              sessionPath: slot.sessionPath,
              diagnostic: slot.ok ? undefined : slot.error,
            });
          }
        };
      }
      publishLive();
      let nextIndex = earlyStarted;
      const worker = async (): Promise<void> => {
        for (let i = nextIndex++; i < list.length; i = nextIndex++) {
          await runOne(i);
        }
      };
      const workers = Array.from({ length: Math.min(concurrency, Math.max(0, list.length - earlyStarted)) }, () => worker());
      const all = Promise.all([...(earlyBatch?.runs ?? []), ...workers]);
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
        content: [{ type: "text", text: body }],
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
