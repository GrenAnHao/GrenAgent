// multi-agent: delegate work to isolated pi sub-agents (separate processes,
// each with its own context window). Single task or several in parallel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnPiAgent } from "./runner.js";
import { normalizeTasks, spawnHasWork } from "./tasks.js";
import { getApprovalPolicy } from "../_shared/approval.js";
import { sandboxAvailable } from "../_shared/sandbox-gate.js";
import { resolveProfile, profileToModel, profileToEnv, profileLimits, type ProfileInput } from "./capability.js";
import { discoverAgents, resolveAgent, suggestAgent, withBuiltinDefaults, type AgentScope } from "./agents.js";
import { createWorktree, worktreeDiff } from "./worktree.js";
import { SubAgentRegistry, type SubAgentRow } from "./registry.js";
import { cancelSubAgent, installCancelWatcher } from "./cancel.js";
import { getConfig } from "../_shared/runtime-config.js";
import { registerWorkflows } from "./workflows.js";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MAX_CONCURRENCY = 4;

// 子代理 `--mode json` 的 stdout 随消息呈 O(n^2) 膨胀。运行中若把全量 transcript 每帧经 IPC
// 推给前端，会压垮 IPC 反序列化 + state 存储（卡爆/OOM）。故运行中只推尾部定长片段供实时预览，
// 完整 transcript 仅终态返回一次；终态也设上限，防极端超大串写进 session 后重开历史再次卡爆。
const LIVE_TRANSCRIPT_TAIL = 65536; // 运行中实时预览 transcript 尾部上限（字符）
const TRANSCRIPT_CAP = 4_000_000; // 终态完整 transcript 上限（字符）

/** 取尾部至多 maxLen 字符，并丢弃因截断产生的首个半行，保持 JSONL 行完整。 */
function tailLines(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(s.length - maxLen);
  const nl = cut.indexOf("\n");
  return nl >= 0 ? cut.slice(nl + 1) : cut;
}

// Background sub-agent control plane (pull model): one sqlite registry + a map of
// in-flight AbortControllers per cwd. Lives across tool calls inside the long-lived
// sidecar so `wait`/`status`/`cancel` can read/drive background spawns.
const registries = new Map<string, SubAgentRegistry>();
const inflight = new Map<string, AbortController>();

function getRegistry(cwd: string): SubAgentRegistry {
  let reg = registries.get(cwd);
  if (!reg) {
    reg = new SubAgentRegistry(join(cwd, ".pi", "subagents", "registry.db"));
    reg.load();
    reg.reapOrphans(); // rows left "running" by a previous process are dead
    registries.set(cwd, reg);
    // installCancelWatcher is idempotent per cwd (UI/Rust append cancel-requests.jsonl).
    installCancelWatcher(cwd, (agentId) => cancelSubAgent(agentId, reg!, inflight));
  }
  return reg;
}

function statusText(row: SubAgentRow): string {
  const parts = [`agent ${row.id}: ${row.status}`, `Task: ${row.task}`];
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
  // Workflow slash-commands (/implement, /scout-and-plan, /implement-and-review)
  // + seed default named agents (scout/planner/reviewer/worker).
  registerWorkflows(pi);

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Sub-agent",
    description:
      "Delegate a task to an isolated sub-agent (a separate pi process with its own context window). " +
      "Modes: `task` (single) | `tasks` (parallel) | `chain` (sequential, with {previous} placeholder). " +
      "`agent` picks a named agent (system prompt + tools + model) from ~/.pi/agent/agents/*.md. " +
      "Returns the sub-agent output(s).",
    promptGuidelines: [
      "Use spawn_agent to parallelize independent sub-tasks or to isolate a large exploration from the main context.",
      "Each sub-agent starts fresh — include all context it needs in the task text.",
      "Use `agent` for a specialized role (e.g. scout/planner/reviewer); use `chain` to pipe one step's output into the next via {previous}.",
      "Prefer scout for broad fan-out; do simple single-file lookups yourself.",
    ],
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "A single task for one sub-agent" })),
      model: Type.Optional(Type.String({ description: "Model (provider/id) for `task`. Omit → SUBAGENT_MODEL or main default." })),
      tasks: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({
              task: Type.String(),
              model: Type.Optional(Type.String()),
              agent: Type.Optional(Type.String()),
            }),
          ]),
          { description: "Multiple tasks in parallel; each item may be a string or { task, model, agent }." },
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
            task: Type.String(),
            agent: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
          }),
          { description: "Sequential steps; each step's task may contain {previous} (replaced by the prior step's output)." },
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
                  Type.Union([Type.Literal("process"), Type.Literal("worktree"), Type.Literal("sandbox")]),
                ),
                model: Type.Optional(Type.String()),
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
      agentId: Type.Optional(
        Type.String({ description: "Sub-agent id for status/wait/cancel (from a prior background spawn)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action ?? "run";
      const registry = getRegistry(ctx.cwd);

      // Recursion guard: a sub-agent (spawned with PI_IS_SUBAGENT=1) may not spawn
      // its own sub-agents. Only the top-level agent can create sub-agents.
      if ((action === "run" || action === "spawn") && process.env.PI_IS_SUBAGENT === "1") {
        throw new Error("子代理禁止再启动子代理（嵌套 spawn 已被拦截）");
      }

      if (action === "status" || action === "wait" || action === "cancel" || action === "list" || action === "remove") {
        // Lazy stuck reaping so status/list reflect reality even without the timer.
        reapStuck(registry);

        if (action === "list") {
          const rows = registry.list();
          const body = rows.length
            ? rows.map((x) => `${x.id}  [${x.status}]  ${x.model ?? "-"}  ${x.task}`).join("\n")
            : "(no sub-agents)";
          return {
            content: [{ type: "text", text: body }],
            details: {
              count: rows.length,
              agents: rows.map((x) => ({ agentId: x.id, status: x.status, task: x.task, model: x.model })),
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
          return { content: [{ type: "text", text: `removed ${id}` }], details: { agentId: id, removed: true } };
        }
        if (action === "cancel") {
          if (row.status === "running") cancelSubAgent(id, registry, inflight);
          const out = registry.get(id) ?? row;
          return { content: [{ type: "text", text: statusText(out) }], details: { agentId: out.id, status: out.status } };
        }
        if (action === "wait" && row.status === "running") {
          const capMs = (Number(getConfig("SUBAGENT_TIMEOUT_MS") ?? "120000") || 120000) + 30000;
          await waitForTerminal(registry, id, signal ?? null, capMs);
        }
        const out = registry.get(id) ?? row;
        return {
          content: [{ type: "text", text: statusText(out) }],
          details: { agentId: out.id, status: out.status, exitCode: out.exitCode },
        };
      }

      const list = normalizeTasks(params);
      const hasChain = (params.chain?.length ?? 0) > 0;
      if (!spawnHasWork(params)) throw new Error("provide `task`, `tasks`, or `chain`");

      const profile = resolveProfile(params.profile as ProfileInput | undefined);
      const wantSandbox = profile.isolation === "sandbox";
      if (wantSandbox && (hasChain || list.length !== 1)) {
        throw new Error("sandbox 隔离仅支持单任务（不支持并行 tasks / chain）");
      }
      const wantWorktree = profile.isolation === "worktree";
      // chain has its own worktree guard below; only the single/parallel path is gated here.
      if (wantWorktree && !hasChain && list.length !== 1) {
        throw new Error("worktree 隔离仅支持单任务（不支持并行 tasks）");
      }
      const profileModel = profileToModel(profile, getConfig);
      const profileEnv: Record<string, string> = params.profile ? profileToEnv(profile) : {};
      // 子代理继承 owner 审批策略，但把 `full` 下调为 `auto`：自主 spawn 的子代理对用户可见性低，
      // 不应连 safety 的危险命令确认 / 受保护路径拦截（⑤）都跳过。能力硬限（① readonly/deny）与
      // owner 自身会话不受影响——这里只收紧"模型自动起的子代理"。headless 下 ask 仍在 safety 内
      // 降级为 auto 行为（不全拦），故 auto 是安全且足够的下限。
      const ownerPolicy = getApprovalPolicy();
      profileEnv.APPROVAL_POLICY = ownerPolicy === "full" ? "auto" : ownerPolicy;
      const limits = profileLimits(profile);
      // sandbox 档：可用则让子代理 code-exec/sandbox_sh 走 WSL2 沙箱（safety 禁内置 bash）；
      // 不可用则回退 process 隔离（profileEnv 的 deny/readonly 仍生效），并标记 isolationDowngraded
      // 在结果里告知调用方/用户隔离强度被降级，而非误以为仍在 sandbox 内执行。
      let isolationDowngraded = false;
      if (wantSandbox) {
        if (await sandboxAvailable()) profileEnv.SANDBOX_ENABLE = "on";
        else isolationDowngraded = true;
      }
      const downgradeNote = "\n\n---\n注意：请求了 sandbox 隔离，但当前环境不可用（WSL2 未就绪），已回退到进程隔离执行。";

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

      // Chain mode: run steps sequentially; each step's {previous} is replaced by
      // the prior step's output. Stops at the first failing step.
      if (params.chain && params.chain.length > 0) {
        if (action === "spawn") throw new Error("chain 暂不支持后台 spawn（请用 action:run）");
        if (wantWorktree) throw new Error("worktree 隔离暂不支持 chain（请用非隔离档案）");
        const steps = params.chain;
        const chainResults: Array<{ step: number; agent?: string; task: string; ok: boolean; output: string; error?: string }> = [];
        let previous = "";
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const taskText = step.task.replace(/\{previous\}/g, previous);
          const stepAgent = step.agent ?? params.agent;
          const layer = agentLayer(stepAgent);
          const id = SubAgentRegistry.genId();
          registry.create({
            id,
            task: taskText,
            profile: params.profile ? JSON.stringify(profile) : null,
            model: step.model ?? layer.model ?? profileModel ?? null,
          });
          const r = await spawnPiAgent(ctx.cwd, taskText, {
            model: step.model ?? layer.model ?? profileModel,
            systemPrompt: layer.systemPrompt,
            tools: layer.tools,
            env: profileEnv,
            mcp: profile.mcp,
            timeoutMs: limits.timeoutMs,
            signal: signal ?? undefined,
            onUpdate: () => registry.touch(id),
          });
          registry.finish(
            id,
            r.ok
              ? { status: "done", output: r.output, exitCode: r.exitCode }
              : { status: signal?.aborted ? "cancelled" : "error", output: r.output, error: r.error, exitCode: r.exitCode },
          );
          chainResults.push({ step: i + 1, agent: stepAgent, task: taskText, ok: r.ok, output: r.output, error: r.error });
          if (!r.ok) {
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1}${stepAgent ? ` (${stepAgent})` : ""}: ${r.error ?? "failed"}` }],
              details: { mode: "chain", stoppedAt: i + 1, results: chainResults },
              isError: true,
            };
          }
          previous = r.output;
        }
        const last = chainResults[chainResults.length - 1];
        return {
          content: [{ type: "text", text: last.output || "(no output)" }],
          details: { mode: "chain", results: chainResults },
        };
      }

      if (action === "spawn") {
        if (list.length !== 1) throw new Error("background spawn 仅支持单任务");
        if (wantWorktree) throw new Error("background spawn 暂不支持 worktree 隔离（请用 action:run）");
        const { task, model, agent } = list[0];
        const layer = agentLayer(agent);
        const id = SubAgentRegistry.genId();
        const chosenModel = model ?? layer.model ?? profileModel;
        registry.create({
          id,
          task,
          profile: params.profile ? JSON.stringify(profile) : null,
          model: chosenModel ?? null,
        });
        const controller = new AbortController();
        inflight.set(id, controller);
        // Detached: keeps running after this tool call returns; the handler writes
        // the terminal state to the registry, which `wait`/`status` then read.
        void spawnPiAgent(ctx.cwd, task, {
          model: chosenModel,
          systemPrompt: layer.systemPrompt,
          tools: layer.tools,
          env: profileEnv,
          mcp: profile.mcp,
          timeoutMs: limits.timeoutMs,
          signal: controller.signal,
          onUpdate: () => registry.touch(id), // heartbeat → stuck detection
        })
          .then((r) =>
            registry.finish(
              id,
              r.ok
                ? { status: "done", output: r.output, exitCode: r.exitCode }
                : {
                    status: controller.signal.aborted ? "cancelled" : "error",
                    output: r.output,
                    error: r.error,
                    exitCode: r.exitCode,
                  },
            ),
          )
          .catch((e) => registry.finish(id, { status: "error", error: String((e as Error)?.message ?? e), exitCode: -1 }))
          .finally(() => inflight.delete(id));
        return {
          content: [
            {
              type: "text",
              text:
                `Background sub-agent started. agentId: ${id}\nUse spawn_agent({ action: "wait", agentId: "${id}" }) to await, or "status" / "cancel".` +
                (isolationDowngraded ? downgradeNote : ""),
            },
          ],
          details: { agentId: id, status: "running", ...(isolationDowngraded ? { isolationDowngraded: true } : {}) },
        };
      }

      if (list.length === 1) {
        const { task, model, agent } = list[0];
        const layer = agentLayer(agent);
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
          profile: params.profile ? JSON.stringify(profile) : null,
          model: model ?? layer.model ?? profileModel ?? null,
        });
        try {
          const r = await spawnPiAgent(runCwd, task, {
            model: model ?? layer.model ?? profileModel,
            systemPrompt: layer.systemPrompt,
            tools: layer.tools,
            env: profileEnv,
            mcp: profile.mcp,
            timeoutMs: limits.timeoutMs,
            signal: signal ?? undefined,
            onUpdate: (u) => {
              registry.touch(id); // heartbeat → stuck detection
              if (onUpdate) {
                onUpdate({
                  content: [{ type: "text", text: u.text }],
                  // 运行中只推尾部截断的 transcript（定长），完整版终态再给一次；
                  // 避免 O(n^2) 全量串每帧经 IPC → 前端卡爆/OOM。
                  details: { streaming: true, transcriptTail: tailLines(u.transcript, LIVE_TRANSCRIPT_TAIL) },
                });
              }
            },
          });
          if (!r.ok) {
            registry.finish(id, {
              status: signal?.aborted ? "cancelled" : "error",
              output: r.output,
              error: r.error,
              exitCode: r.exitCode,
            });
            throw new Error(`sub-agent failed (exit ${r.exitCode}): ${r.error ?? "unknown error"}`);
          }
          const diff = wt ? await worktreeDiff(wt.dir) : undefined;
          registry.finish(id, { status: "done", output: r.output, exitCode: r.exitCode });
          const baseText = wt
            ? `${r.output || "(no output)"}\n\n---\n### Diff (isolated worktree)\n\n${diff?.trim() ? "```diff\n" + diff + "\n```" : "(no file changes)"}`
            : r.output || "(no output)";
          const text = isolationDowngraded ? baseText + downgradeNote : baseText;
          return {
            content: [{ type: "text", text }],
            details: {
              agentId: id,
              exitCode: r.exitCode,
              transcript: tailLines(r.transcript, TRANSCRIPT_CAP),
              isolated: !!wt,
              diff,
              ...(isolationDowngraded ? { isolationDowngraded: true } : {}),
            },
          };
        } finally {
          if (wt) await wt.cleanup();
        }
      }

      const results: Array<{ task: string; ok: boolean; output: string; error?: string }> = [];
      const concurrency = Math.max(1, limits.maxConcurrency ?? MAX_CONCURRENCY);
      for (let i = 0; i < list.length; i += concurrency) {
        const batch = list.slice(i, i + concurrency);
        const settled = await Promise.all(
          batch.map(async (t) => {
            const layer = agentLayer(t.agent);
            const id = SubAgentRegistry.genId();
            registry.create({
              id,
              task: t.task,
              profile: params.profile ? JSON.stringify(profile) : null,
              model: t.model ?? layer.model ?? profileModel ?? null,
            });
            const r = await spawnPiAgent(ctx.cwd, t.task, {
              model: t.model ?? layer.model ?? profileModel,
              systemPrompt: layer.systemPrompt,
              tools: layer.tools,
              env: profileEnv,
              mcp: profile.mcp,
              timeoutMs: limits.timeoutMs,
              signal: signal ?? undefined,
              onUpdate: () => registry.touch(id),
            });
            registry.finish(
              id,
              r.ok
                ? { status: "done", output: r.output, exitCode: r.exitCode }
                : { status: signal?.aborted ? "cancelled" : "error", output: r.output, error: r.error, exitCode: r.exitCode },
            );
            return r;
          }),
        );
        settled.forEach((r, j) => results.push({ task: batch[j].task, ok: r.ok, output: r.output, error: r.error }));
      }

      const body = results
        .map(
          (r, i) =>
            `## Sub-agent ${i + 1}${r.ok ? "" : " (failed)"}\nTask: ${r.task}\n\n${r.ok ? r.output || "(no output)" : `Error: ${r.error}`}`,
        )
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: body }],
        details: {
          mode: "parallel",
          count: results.length,
          failed: results.filter((r) => !r.ok).length,
          results: results.map((r) => ({ task: r.task, ok: r.ok, output: r.output, error: r.error })),
        },
      };
    },
  });

  // Periodic stuck reaping across all open registries (unref'd so it never keeps
  // the process alive). Lazy reaping on list/status covers on-demand cases.
  const stuckTimer = setInterval(() => {
    for (const reg of registries.values()) reapStuck(reg);
  }, 60000);
  stuckTimer.unref?.();
}
