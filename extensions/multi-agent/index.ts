// multi-agent: delegate work to isolated pi sub-agents (separate processes,
// each with its own context window). Single task or several in parallel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnPiAgent } from "./runner.js";
import { normalizeTasks } from "./tasks.js";
import { resolveProfile, profileToModel, profileToEnv, type ProfileInput } from "./capability.js";
import { createWorktree, worktreeDiff } from "./worktree.js";
import { SubAgentRegistry, type SubAgentRow } from "./registry.js";
import { getConfig } from "../_shared/runtime-config.js";
import { join } from "node:path";

const MAX_CONCURRENCY = 4;

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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Sub-agent",
    description:
      "Delegate a task to an isolated sub-agent (a separate pi process with its own context window). " +
      "Provide `task` for one, or `tasks` for several run in parallel. Returns the sub-agent output(s).",
    promptGuidelines: [
      "Use spawn_agent to parallelize independent sub-tasks or to isolate a large exploration from the main context.",
      "Each sub-agent starts fresh — include all context it needs in the task text.",
    ],
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "A single task for one sub-agent" })),
      model: Type.Optional(Type.String({ description: "Model (provider/id) for `task`. Omit → SUBAGENT_MODEL or main default." })),
      tasks: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({ task: Type.String(), model: Type.Optional(Type.String()) }),
          ]),
          { description: "Multiple tasks in parallel; each item may be a string or { task, model }." },
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
          ],
          { description: "run (default, blocking) | spawn (background, returns agentId) | status | wait | cancel" },
        ),
      ),
      agentId: Type.Optional(
        Type.String({ description: "Sub-agent id for status/wait/cancel (from a prior background spawn)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action ?? "run";
      const registry = getRegistry(ctx.cwd);

      if (action === "status" || action === "wait" || action === "cancel") {
        const id = params.agentId?.trim();
        if (!id) throw new Error(`action '${action}' requires agentId`);
        const row = registry.get(id);
        if (!row) throw new Error(`unknown agentId: ${id}`);
        if (action === "cancel") {
          if (row.status === "running") {
            inflight.get(id)?.abort();
            registry.finish(id, { status: "cancelled", exitCode: -1 });
          }
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
      if (!list.length) throw new Error("provide `task` or `tasks`");

      const profile = resolveProfile(params.profile as ProfileInput | undefined);
      if (profile.isolation === "sandbox") {
        throw new Error("isolation 'sandbox' 尚未支持（规划于 P4）；当前支持 process | worktree");
      }
      const wantWorktree = profile.isolation === "worktree";
      if (wantWorktree && list.length !== 1) {
        throw new Error("worktree 隔离仅支持单任务（不支持并行 tasks）");
      }
      const profileModel = profileToModel(profile, getConfig);
      const profileEnv = params.profile ? profileToEnv(profile) : {};

      if (action === "spawn") {
        if (list.length !== 1) throw new Error("background spawn 仅支持单任务");
        if (wantWorktree) throw new Error("background spawn 暂不支持 worktree 隔离（请用 action:run）");
        const { task, model } = list[0];
        const id = SubAgentRegistry.genId();
        const chosenModel = model ?? profileModel;
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
        void spawnPiAgent(ctx.cwd, task, { model: chosenModel, env: profileEnv, signal: controller.signal })
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
              text: `Background sub-agent started. agentId: ${id}\nUse spawn_agent({ action: "wait", agentId: "${id}" }) to await, or "status" / "cancel".`,
            },
          ],
          details: { agentId: id, status: "running" },
        };
      }

      if (list.length === 1) {
        const { task, model } = list[0];
        const wt = wantWorktree ? await createWorktree(ctx.cwd) : null;
        if (wantWorktree && !wt && getConfig("ISOLATE_FALLBACK") !== "1") {
          throw new Error(
            "无法隔离：当前目录非 git 仓库或无提交。请改用非隔离档案、先 git init + 初始提交，或设 ISOLATE_FALLBACK=1 降级。",
          );
        }
        const runCwd = wt?.dir ?? ctx.cwd;
        try {
          const r = await spawnPiAgent(runCwd, task, {
            model: model ?? profileModel,
            env: profileEnv,
            signal: signal ?? undefined,
            onUpdate: onUpdate
              ? (u) =>
                  onUpdate({
                    content: [{ type: "text", text: u.text }],
                    details: { streaming: true, transcript: u.transcript },
                  })
              : undefined,
          });
          if (!r.ok) throw new Error(`sub-agent failed (exit ${r.exitCode}): ${r.error ?? "unknown error"}`);
          const diff = wt ? await worktreeDiff(wt.dir) : undefined;
          const text = wt
            ? `${r.output || "(no output)"}\n\n---\n### Diff (isolated worktree)\n\n${diff?.trim() ? "```diff\n" + diff + "\n```" : "(no file changes)"}`
            : r.output || "(no output)";
          return {
            content: [{ type: "text", text }],
            details: { exitCode: r.exitCode, transcript: r.transcript, isolated: !!wt, diff },
          };
        } finally {
          if (wt) await wt.cleanup();
        }
      }

      const results: Array<{ task: string; ok: boolean; output: string; error?: string }> = [];
      for (let i = 0; i < list.length; i += MAX_CONCURRENCY) {
        const batch = list.slice(i, i + MAX_CONCURRENCY);
        const settled = await Promise.all(
          batch.map((t) =>
            spawnPiAgent(ctx.cwd, t.task, {
              model: t.model ?? profileModel,
              env: profileEnv,
              signal: signal ?? undefined,
            }),
          ),
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
        details: { count: results.length, failed: results.filter((r) => !r.ok).length },
      };
    },
  });
}
