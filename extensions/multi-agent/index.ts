// multi-agent: delegate work to isolated pi sub-agents (separate processes,
// each with its own context window). Single task or several in parallel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { parentModelSpec, resolveSubagentModel, spawnPiAgent, type AgentResult } from "./runner.js";
import { canUseEmbeddedSubagent, runEmbeddedSubagent, startContinuableEmbedded } from "./embedded-runner.js";
import { assertRouteAllowed, assertThinkingLevel, isThinkingLevel, readModelSelectionPolicy, routeOf, THINKING_LEVELS } from "./model-selection.js";
import { availableModels, registerListSubagentModels } from "./list-models-tool.js";
import type { SubagentStopReason } from "./assistant-output.js";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import { jobs } from "../jobs/service.js";
import type { JobOutcome } from "../jobs/types.js";
import { closedStringField, normalizeTasks, spawnHasWork } from "./tasks.js";
import { getApprovalPolicy } from "../_shared/approval.js";
import { resolveProfile, profileToModel, profileToEnv, profileLimits, type ProfileInput } from "./capability.js";
import { discoverAgents, inferNamedAgentProfile, resolveAgent, suggestAgent, withBuiltinDefaults, type AgentScope } from "./agents.js";
import { createWorktree, worktreeDiff } from "./worktree.js";
import { SubAgentRegistry, type SubAgentRow } from "./registry.js";
import { cancelSubAgent } from "./cancel.js";
import { forEachRegistry, getRegistry, inflight } from "./controlPlane.js";
import { getConfig } from "../_shared/runtime-config.js";
import { tailLines, LIVE_TRANSCRIPT_TAIL, TRANSCRIPT_CAP } from "./transcript-tail.js";
import { registerWorkflows } from "./workflows.js";
import { registerAdjacentTools } from "./adjacent-tools.js";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { disposeActivation, getActivation } from "./activation.js";
import { establishCatalogChild, foldCatalogFromEntries } from "./catalog.js";
import { emitCatalogChanged } from "./catalog-events.js";
import { completedPrefix } from "./fork-seed.js";
import { withDelegationScope } from "../_shared/delegation-scope.js";
import { assertDepthAllowed, childDepthOf } from "./depth.js";
import { adoptSpawnBatch, appendSpawnDelta, rekeySpawnTool, rememberSpawnTool, type EarlyBatch, type EarlySlot } from "./parallel-early.js";

type SubagentRunResult = AgentResult & { sessionPath?: string; stopReason?: SubagentStopReason; structured?: unknown };

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

function mapStop(r: SubagentRunResult, aborted: boolean): JobOutcome {
  // killed 只留给外部取消（job_kill / 界面取消 / 会话关闭）。子代理自己超时被 abort 算 failed，
  // 否则父代理和界面都以为是有人把它停了。
  const timedOut = /\b(idle|startup|hard) timeout\b/.test(r.error ?? "");
  const status = aborted || (r.stopReason === "aborted" && !timedOut) ? "killed" : r.ok ? "completed" : "failed";
  return { status, output: r.output, ...(r.error ? { error: r.error } : {}) };
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

/** Embedded session child (Electron sidecar) or subprocess fallback (CLI / worktree / Tauri). */
async function executeSubagent(
  cwd: string,
  task: string,
  agentId: string,
  profile: ReturnType<typeof resolveProfile>,
  opts: Parameters<typeof spawnPiAgent>[2] & { parentSessionPath?: string; seedMessages?: unknown[] },
): Promise<SubagentRunResult> {
  const systemPrompt = withDelegationScope(opts.systemPrompt);
  if (canUseEmbeddedSubagent(profile)) {
    return runEmbeddedSubagent({
      cwd,
      task,
      agentId,
      parentSessionPath: opts.parentSessionPath,
      model: opts.model,
      systemPrompt,
      tools: opts.tools,
      env: opts.env,
      mcp: opts.mcp,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onUpdate: opts.onUpdate,
      seedMessages: opts.seedMessages,
      thinkingLevel: opts.thinkingLevel as ThinkingLevel | undefined,
      depth: opts.depth,
      outputSchema: opts.outputSchema,
    });
  }
  const r = await spawnPiAgent(cwd, task, { ...opts, systemPrompt });
  const stopReason: SubagentStopReason = opts.signal?.aborted ? "aborted" : r.ok ? "completed" : "error";
  return { ...r, stopReason };
}

function subagentDetails(
  id: string,
  r: SubagentRunResult,
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

function cleanModel(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

/** explicit spawn model → named agent → profile → SUBAGENT_MODEL → parent session model. */
function pickSubagentModel(
  explicit: string | undefined,
  layerModel: string | undefined,
  profileModel: string | undefined,
  parent: { provider?: string; id?: string } | undefined,
): string | undefined {
  return (
    cleanModel(explicit) ??
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

// Poll the registry until the row leaves "running" (a background spawn's detached
// handler writes the terminal state) or the cap/abort fires.
async function waitForTerminal(reg: SubAgentRegistry, id: string, signal: AbortSignal | null, capMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    const row = reg.get(id);
    if (!row || row.status !== "running") return;
    if (signal?.aborted) return;
    await new Promise((res) => setTimeout(res, 250));
  }
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

  // Workflow slash-commands (/implement, /scout-and-plan, /implement-and-review)
  // + seed default named agents (scout/planner/reviewer/worker).
  registerWorkflows(pi);

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
      getRegistry(ctx.cwd);
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
    if (task.agent) {
      try {
        const found = resolveAgent(withBuiltinDefaults(discoverAgents(ctx.cwd, "user").agents), task.agent);
        systemPrompt = found?.systemPrompt;
        tools = found?.tools;
      } catch {
        /* 命名档案解析失败留给 execute 路径记失败 */
      }
    }
    const registry = getRegistry(ctx.cwd);
    registry.create({
      id,
      task: task.task,
      profile: JSON.stringify(profile),
      model: chosenModel ?? null,
      parentId: parentSessionId(ctx),
      depth,
    });
    return executeSubagent(ctx.cwd, task.task, id, profile, {
      parentSessionPath: parentSessionPath(ctx),
      model: chosenModel,
      systemPrompt,
      tools,
      env: profileEnv,
      timeoutMs: profileLimits(profile).timeoutMs,
      depth,
      signal: controller.signal,
      onUpdate: (u) => {
        registry.progress(id, u.transcript);
        if (u.sessionPath) {
          registry.setSessionPath(id, u.sessionPath);
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
      registry.finish(id, r.ok
        ? { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript }
        : { status: "error", output: r.output, error: r.error, exitCode: r.exitCode, transcript: r.transcript });
    }).catch((e: unknown) => {
      const msg = String((e as Error)?.message ?? e);
      slot.ok = false;
      slot.error = msg;
      slot.settled = true;
      registry.finish(id, { status: "error", error: msg, exitCode: -1 });
    }).finally(() => releaseReserved(sessionKey, 1));
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
      "Delegate a task to an isolated sub-agent (a separate pi process with its own context window). " +
      "Modes: `task` (single) | `tasks` (parallel) | `chain` (sequential, with {previous} placeholder). " +
      "`agent` picks a named agent (system prompt + tools + model) from ~/.pi/agent/agents/*.md: " +
      "scout/ask/reviewer are read-only, planner is restricted-write, worker is writable. " +
      "`profile` (explore|planner|executor|reviewer|default) sets filesystem/MCP/isolation; omitted profile still follows the named agent. " +
      "Pass `title` as the short card name (one clause, at most 24 characters); the sub-agent still receives the full task text. " +
      "Returns the sub-agent output(s).",
    promptSnippet: "Delegate a task to an isolated sub-agent.",
    promptGuidelines: [
      "Use spawn_agent 时每次都带 title：一句任务名，不超过 24 字，用用户当前语言。单任务写在顶层；并行 tasks 和链式 chain 的每一项各自带 title。title 只做卡片名，完整要求仍写在 task。",
      "Use spawn_agent to parallelize independent sub-tasks or to isolate a large exploration from the main context.",
      "Each sub-agent starts fresh — include all context it needs in the task text.",
      "Use `agent` for a specialized role: scout/ask (readonly recon), planner, reviewer, worker (writable). Use `chain` to pipe one step's output into the next via {previous}.",
      "Omit `profile` and the named role still selects explore/planner/reviewer/default. For an unnamed read-only child pass `profile: \"explore\"`.",
      "Prefer scout for broad fan-out; do simple single-file lookups yourself.",
      "After a background spawn settles you will receive a notice; do not wait just to collect the conclusion.",
      "子任务要接着当前对话往下做时用 fork: true；要隔离探索时不要开。",
      ...(modelPolicy.enabled
        ? [
            "开启自选路由时先调用 list_subagent_models，只用它列出的路由。",
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
      ...maybeModel("Model route (provider/id) for `task`. Must come from `list_subagent_models`; omit to use the configured default."),
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
              ...maybeModel("Model route for this task; must come from `list_subagent_models`."),
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
            ...maybeModel("Model route for this step; must come from `list_subagent_models`."),
          }),
          { description: "Sequential steps; each step's task may contain {previous} (replaced by the prior step's output). Pass title on each step." },
        ),
      ),
      profile: Type.Optional(
        Type.Union(
          [
            Type.String({ description: "Preset profile: explore | planner | executor | reviewer | default" }),
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
                isolation: Type.Optional(
                  Type.Union([Type.Literal("process"), Type.Literal("worktree")]),
                ),
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
            Type.Literal("wait"),
            Type.Literal("cancel"),
            Type.Literal("list"),
            Type.Literal("remove"),
          ],
          {
            description:
              "run (default, blocking) | spawn (background, returns agentId) | status | wait | cancel | list (all sub-agents) | remove (delete a record)",
          },
        ),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("one-shot"), Type.Literal("continuable")], {
          description:
            'Only with action "spawn": "continuable" (default) keeps the child resident for send_message; "one-shot" runs once as a background job, collect with job_output.',
        }),
      ),
      agentId: Type.Optional(
        Type.String({ description: "Sub-agent id for status/wait/cancel (from a prior background spawn)." }),
      ),
      fork: Type.Optional(
        Type.Boolean({ description: "When true, seed the child with the parent session's completed turns." }),
      ),
      ...maybeThinkingLevel(),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action ?? "run";
      const registry = getRegistry(ctx.cwd);

      // 模型策略「禁用子代理」：直接拒绝 run/spawn（status/list/cancel/remove 仍可用于善后历史任务）。
      if ((action === "run" || action === "spawn") && getConfig("SUBAGENT_MODE")?.trim() === "disabled") {
        throw new Error(
          "子代理已被禁用（设置 → 子代理 → 模型策略 = 禁用子代理）。如需使用请改为「继承父模型」或「选定模型」。",
        );
      }

      if (action === "status" || action === "wait" || action === "cancel" || action === "list" || action === "remove") {
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

        if ((action === "wait" || action === "status") && row?.jobId) {
          const caller = parentSessionId(ctx) ?? ctx.cwd;
          const capMs = action === "wait"
            ? (Number(getConfig("SUBAGENT_TIMEOUT_MS") ?? "300000") || 300000) + 30000
            : 0;
          const r = await jobs.read(row.jobId, caller, { wait: action === "wait", timeoutMs: capMs });
          const fresh = registry.get(id) ?? row;
          const head = `agent ${fresh.id}: ${fresh.status}`;
          return {
            content: [{ type: "text", text: r.text ? `${head}\n\n${r.text}` : head }],
            details: {
              agentId: fresh.id,
              jobId: row.jobId,
              status: fresh.status,
              exitCode: fresh.exitCode,
              task: fresh.task,
              ...(fresh.error ? { error: fresh.error } : {}),
            },
          };
        }
        if (action === "cancel" && row?.jobId) {
          try {
            jobs.kill(row.jobId, parentSessionId(ctx) ?? ctx.cwd, "spawn_agent cancel");
          } catch {
            /* 非 owner / 已终：仍走下面的 registry cancel */
          }
        }

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
        if (action === "wait" && row.status === "running") {
          const capMs = (Number(getConfig("SUBAGENT_TIMEOUT_MS") ?? "300000") || 300000) + 30000;
          await waitForTerminal(registry, id, signal ?? null, capMs);
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
            const target = explicitRoutes[0] ?? inlineProfileModel;
            const model = avail.find((m) => routeOf(m) === target) ?? avail.find((m) => routeOf(m) === (parentModelSpec(ctx.model) ?? ""));
            if (!model) throw new Error("thinking_level 需要一个可解析的目标模型");
            assertThinkingLevel(thinkingLevel, model);
          }
        } catch (e) {
          return { content: [{ type: "text", text: String((e as Error).message ?? e) }], details: {}, isError: true };
        }
      }
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
      const agentLayer = (name: string | undefined): { systemPrompt?: string; tools?: string[]; model?: string } => {
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
        return { systemPrompt: a.systemPrompt, tools: a.tools, model: a.model };
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
        if (!canUseEmbeddedSubagent(profile)) throw new Error("fork 需要 Electron 进程内子会话");
      }
      const seedMessages = params.fork ? completedPrefix(parentLeafMessages(ctx), toolCallId) : [];
      const wantWorktree = profile.isolation === "worktree";
      // chain has its own worktree guard below; only the single/parallel path is gated here.
      if (wantWorktree && !hasChain && list.length !== 1) {
        throw new Error("worktree 隔离仅支持单任务（不支持并行 tasks）");
      }
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
        if (wantWorktree) throw new Error("worktree 隔离暂不支持 chain（请用非隔离档案）");
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
          const r = await executeSubagent(ctx.cwd, taskText, id, profile, {
            parentSessionPath: parentSessionPath(ctx),
            model: chosenModel,
            systemPrompt: layer.systemPrompt,
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
              registry.setSessionPath(id, u.sessionPath);
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
        if (wantWorktree) throw new Error("background spawn 暂不支持 worktree 隔离（请用 action:run）");
        const { task, model, agent } = list[0];
        const layer = agentLayer(agent);
        const id = SubAgentRegistry.genId();
        const chosenModel = pickSubagentModel(model, layer.model, profileModel, ctx.model);
        const parentPath = parentSessionPath(ctx);
        const workspace = currentWorkspaceContext()?.workspace ?? ctx.cwd;
        const spawnedText = `Background sub-agent started. agentId: ${id}\nUse spawn_agent({ action: "wait", agentId: "${id}" }) to await, or "status" / "cancel".`;
        const spawnMode = params.mode === "one-shot" ? "one-shot" : "continuable";
        const startOneShotJob = (): { jobId: string } => {
          registry.create({ id, task, profile: profileJson, model: chosenModel ?? null, parentId: parentSid ?? null, depth: childDepth });
          const controller = new AbortController();
          inflight.set(id, controller);
          const jobId = jobs.start({
            kind: "subagent",
            label: catalogLabel(task),
            owner: parentSid ?? ctx.cwd,
            workspace,
            run: () => {
              const done = executeSubagent(ctx.cwd, task, id, profile, {
                parentSessionPath: parentPath,
                model: chosenModel,
                systemPrompt: layer.systemPrompt,
                tools: layer.tools,
                env: profileEnv,
                mcp: profile.mcp,
                timeoutMs: limits.timeoutMs,
                seedMessages,
                depth: childDepth,
                thinkingLevel: thinkingLevel || undefined,
                signal: controller.signal,
                onUpdate: (u) => {
                  if (u.sessionPath) registry.setSessionPath(id, u.sessionPath);
                  registry.progress(id, u.transcript);
                },
              })
                .then((r) => {
                  const aborted = controller.signal.aborted;
                  registry.finish(id, r.ok
                    ? { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript }
                    : { status: aborted ? "cancelled" : "error", output: r.output, error: r.error, exitCode: r.exitCode, transcript: r.transcript });
                  if (r.ok) writeOneShotCatalog(pi, ctx, { childId: id, sessionPath: r.sessionPath, label: catalogLabel(task) });
                  return mapStop(r, aborted);
                })
                .catch((e): JobOutcome => {
                  registry.finish(id, { status: "error", error: String((e as Error)?.message ?? e), exitCode: -1 });
                  return { status: "failed", error: String((e as Error)?.message ?? e) };
                })
                .finally(() => {
                  inflight.delete(id);
                  releaseReserved(sessionKey, 1);
                });
              return { cancel: () => controller.abort(), done };
            },
          });
          registry.setJobId(id, jobId);
          return { jobId };
        };

        if (spawnMode === "one-shot") {
          const { jobId } = startOneShotJob();
          transferOne();
          return {
            content: [{ type: "text", text: `Background one-shot sub-agent started as job ${jobId}. Collect with job_output({ job_id: "${jobId}" }).` }],
            details: { agentId: id, jobId, mode: "one-shot", status: "running", ...(chosenModel ? { model: chosenModel } : {}) },
          };
        }

        if (canUseEmbeddedSubagent(profile)) {
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
            const started = await startContinuableEmbedded({
              cwd: ctx.cwd,
              task,
              agentId: id,
              parentSessionPath: parentPath,
              parentSessionId: parentSid,
              model: chosenModel,
              systemPrompt: withDelegationScope(layer.systemPrompt),
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
                if (u.sessionPath) registry.setSessionPath(id, u.sessionPath);
                registry.progress(id, u.transcript);
              },
              onSettled: (info) => {
                const status =
                  info.stopReason === "aborted" ? "cancelled" : info.stopReason === "error" ? "error" : "done";
                registry.finish(id, {
                  status,
                  output: info.output,
                  exitCode: status === "done" ? 0 : -1,
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

        const { jobId } = startOneShotJob();
        transferOne();
        return {
          content: [{ type: "text", text: `${spawnedText}\nAlso tracked as job ${jobId} (job_output / job_kill).` }],
          details: { agentId: id, jobId, status: "running", ...(chosenModel ? { model: chosenModel } : {}) },
        };
      }

      if (list.length === 1) {
        const { task, model, agent } = list[0];
        const layer = agentLayer(agent);
        const chosenModel = pickSubagentModel(model, layer.model, profileModel, ctx.model);
        const wt = wantWorktree ? await createWorktree(ctx.cwd) : null;
        if (wantWorktree && !wt && getConfig("ISOLATE_FALLBACK") !== "1") {
          throw new Error(
            "无法隔离：当前目录非 git 仓库或无提交。请改用非隔离档案、先 git init + 初始提交，或设 ISOLATE_FALLBACK=1 降级。",
          );
        }
        const runCwd = wt?.dir ?? ctx.cwd;
        const id = SubAgentRegistry.genId();
        registry.create({
          id,
          task,
          profile: profileJson,
          model: chosenModel ?? null,
          parentId: parentSid ?? null, depth: childDepth,
        });
        const controller = registerInflight(id, signal);
        try {
          const r = await executeSubagent(runCwd, task, id, profile, {
            parentSessionPath: parentSessionPath(ctx),
            model: chosenModel,
            systemPrompt: layer.systemPrompt,
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
              if (onUpdate) {
                onUpdate({
                  content: [{ type: "text", text: u.text }],
                  details: u.sessionPath
                    ? { streaming: true, agentId: id, sessionPath: u.sessionPath }
                    : {
                        streaming: true,
                        transcriptTail: tailLines(u.transcript, LIVE_TRANSCRIPT_TAIL),
                      },
                });
              }
            },
          });
          if (!r.ok) {
            const aborted = controller.signal.aborted;
            registry.finish(id, {
              status: aborted ? "cancelled" : "error",
              output: r.output,
              error: r.error,
              exitCode: r.exitCode,
              transcript: r.transcript,
            });
            // 超时被杀但已产出实质内容：保留「已写部分」返回（附截断说明），而不是抛错把成果丢掉。
            if (!aborted && r.partial && r.output.trim()) {
              const partialText = `${r.output}\n\n_(超时截断：${r.error ?? "timeout"}；以上为已产出部分)_`;
              return {
                content: [{ type: "text", text: partialText }],
                details: subagentDetails(id, r, {
                  partial: true,
                  transcript: r.sessionPath ? undefined : tailLines(r.transcript, TRANSCRIPT_CAP),
                }),
              };
            }
            throw new Error(`sub-agent failed (exit ${r.exitCode}): ${r.error ?? "unknown error"}`);
          }
          const diff = wt ? await worktreeDiff(wt.dir) : undefined;
          registry.finish(id, { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript });
          writeOneShotCatalog(pi, ctx, { childId: id, sessionPath: r.sessionPath, label: catalogLabel(task) });
          const text = wt
            ? `${r.output || "(no output)"}\n\n---\n### Diff (isolated worktree)\n\n${diff?.trim() ? "```diff\n" + diff + "\n```" : "(no file changes)"}`
            : r.output || "(no output)";
          return {
            content: [{ type: "text", text }],
            details: subagentDetails(id, r, {
              transcript: r.sessionPath ? undefined : tailLines(r.transcript, TRANSCRIPT_CAP),
              isolated: !!wt,
              diff,
              ...(chosenModel ? { model: chosenModel } : {}),
              ...forkDetails(params.fork, seedMessages),
            }),
          };
        } finally {
          inflight.delete(id);
          releaseOne();
          if (wt) await wt.cleanup();
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
      const publishLive = () => {
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
          const controller = registerInflight(subId, signal);
          const r = await executeSubagent(ctx.cwd, t.task, subId, profile, {
            parentSessionPath: parentSessionPath(ctx),
            model: chosenModel,
            systemPrompt: layer.systemPrompt,
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
              registry.setSessionPath(subId, u.sessionPath);
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
        } catch (e) {
          // 单个任务异常（如未知 agent、registry 写入失败）不应 reject 整个 Promise.all 而遗弃其它
          // 正在运行的兄弟任务：就地记为该任务的失败结果，其余 worker 照常跑完。
          const msg = String((e as Error)?.message ?? e);
          if (id) registry.finish(id, { status: "error", error: msg, exitCode: -1 });
          slots[i] = { task: t.task, ok: false, output: "", error: msg, agentId: id, settled: true };
          publishLive();
        } finally {
          if (i >= earlyStarted) releaseOne();
        }
      };
      // 滑动窗口并发：concurrency 个 worker 各自从队列取下一个任务，单个卡住只占一个槽位——不再像
      // 「分批 + Promise.all」那样被批内最慢/卡住的一个拖住，导致后续任务永远不开始。
      if (signal && earlyBatch) {
        const abortEarly = () => {
          for (const controller of earlyBatch.abortors) controller.abort();
        };
        if (signal.aborted) abortEarly();
        else signal.addEventListener("abort", abortEarly, { once: true });
      }
      publishLive();
      let nextIndex = earlyStarted;
      const worker = async (): Promise<void> => {
        for (let i = nextIndex++; i < list.length; i = nextIndex++) {
          await runOne(i);
        }
      };
      const workers = Array.from({ length: Math.min(concurrency, Math.max(0, list.length - earlyStarted)) }, () => worker());
      await Promise.all([...(earlyBatch?.runs ?? []), ...workers]);

      const body = slots
        .map((r, i) => {
          const head = `## Sub-agent ${i + 1}${r.ok ? "" : " (failed)"}`;
          if (r.ok) return `${head}\n\n${r.output || "(no output)"}`;
          // 失败但已产出部分内容（超时截断）：保留已写部分 + 超时原因，而不是丢成纯 Error。
          if (r.partial && r.output.trim()) {
            return `${head}\n\n${r.output}\n\n_(超时截断：${r.error ?? "timeout"}；以上为已产出部分)_`;
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
          })),
        },
      };
      } finally {
        if (slotsLeft > 0) releaseReserved(sessionKey, slotsLeft);
      }
    },
  });

  registerAdjacentTools(pi);

  // Periodic stuck reaping across all open registries (unref'd so it never keeps
  // the process alive). Lazy reaping on list/status covers on-demand cases.
  const stuckTimer = setInterval(() => {
    forEachRegistry((reg) => reapStuck(reg));
  }, 60000);
  stuckTimer.unref?.();
}
