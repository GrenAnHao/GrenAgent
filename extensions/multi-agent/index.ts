// multi-agent: delegate work to isolated pi sub-agents (separate processes,
// each with its own context window). Single task or several in parallel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnPiAgent } from "./runner.js";

const MAX_CONCURRENCY = 4;

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
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Multiple tasks to run in parallel" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const single = params.task?.trim();
      const many = (params.tasks ?? []).map((t) => t.trim()).filter(Boolean);
      if (!single && !many.length) throw new Error("provide `task` or `tasks`");

      if (single && !many.length) {
        const r = await spawnPiAgent(ctx.cwd, single, {
          signal: signal ?? undefined,
          onUpdate: onUpdate
            ? (output) => onUpdate({ content: [{ type: "text", text: output }], details: { streaming: true } })
            : undefined,
        });
        if (!r.ok) throw new Error(`sub-agent failed (exit ${r.exitCode}): ${r.error ?? "unknown error"}`);
        return { content: [{ type: "text", text: r.output || "(no output)" }], details: { exitCode: r.exitCode } };
      }

      const tasks = single ? [single, ...many] : many;
      const results: Array<{ task: string; ok: boolean; output: string; error?: string }> = [];
      for (let i = 0; i < tasks.length; i += MAX_CONCURRENCY) {
        const batch = tasks.slice(i, i + MAX_CONCURRENCY);
        const settled = await Promise.all(
          batch.map((t) => spawnPiAgent(ctx.cwd, t, { signal: signal ?? undefined })),
        );
        settled.forEach((r, j) => results.push({ task: batch[j], ok: r.ok, output: r.output, error: r.error }));
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
