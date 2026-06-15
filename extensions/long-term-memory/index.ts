// long-term-memory: durable memory for the Pi coding agent, with two scopes
// (project: <cwd>/.pi/memory/memory.db, global: ~/.pi/agent/memory.db) and
// optional auto-capture of explicit "记住: ..." / "remember: ..." statements.
//
// Tools (LLM-callable):
//   memory_save({ text, category?, scope? })  - persist a memory
//   memory_recall({ query, topK? })           - recall across both scopes
// Command:
//   /memory list | /memory forget <id> | /memory clear [project|global|all]
//
// Each prompt auto-recalls relevant memories (both scopes) and injects them.

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AppliedOp, type AskFn, consolidate, extractFacts } from "./consolidate.js";
import { type EmbeddingConfig, resolveEmbeddingConfig } from "./embedding.js";
import { askMemoryLlm, resolveMemoryModel } from "./llm.js";
import { type MemoryHit, MemoryStore, type RecallFilters } from "./store.js";

const AUTO_INJECT = (process.env.MEMORY_AUTO_INJECT ?? "1") !== "0";
const AUTO_INJECT_TOPK = Number(process.env.MEMORY_AUTO_TOPK ?? "5") || 5;
const AUTO_INJECT_MAX_CHARS = 4000;
const AUTO_CAPTURE = (process.env.MEMORY_AUTO_CAPTURE ?? "1") !== "0";
const AUTO_EXTRACT = (process.env.MEMORY_EXTRACT ?? "0") !== "0";
const SMART = (process.env.MEMORY_SMART ?? "1") !== "0";
const SMART_NOTICE = (process.env.MEMORY_SMART_NOTICE ?? "1") !== "0";
const MEMORY_MODEL = process.env.MEMORY_MODEL;

type ScopedHit = MemoryHit & { scope: "project" | "global" };

function messageToText(m: unknown): string {
  const obj = (m ?? {}) as { role?: string; content?: unknown; message?: { role?: string; content?: unknown } };
  const role = obj.role ?? obj.message?.role ?? "";
  const content = obj.content ?? obj.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return text ? `${role}: ${text}` : "";
}

export default function (pi: ExtensionAPI) {
  let projectStore: MemoryStore | undefined;
  let globalStore: MemoryStore | undefined;
  let projectPath = "";
  let globalPath = "";

  const ensureStores = (cwd: string): { project: MemoryStore; global: MemoryStore } => {
    if (!projectStore) {
      projectPath = join(cwd, ".pi", "memory", "memory.db");
      projectStore = new MemoryStore(projectPath);
      projectStore.load();
    }
    if (!globalStore) {
      globalPath = process.env.MEMORY_GLOBAL_DB ?? join(homedir(), ".pi", "agent", "long-term-memory.db");
      globalStore = new MemoryStore(globalPath);
      globalStore.load();
    }
    return { project: projectStore, global: globalStore };
  };

  const recallMerged = async (
    cwd: string,
    query: string,
    topK: number,
    config: EmbeddingConfig,
    filters?: RecallFilters,
  ): Promise<ScopedHit[]> => {
    const { project, global } = ensureStores(cwd);
    const [p, g] = await Promise.all([
      project.recall(query, topK, config, undefined, filters).catch(() => []),
      global.recall(query, topK, config, undefined, filters).catch(() => []),
    ]);
    const tagged: ScopedHit[] = [
      ...p.map((h) => ({ ...h, scope: "project" as const })),
      ...g.map((h) => ({ ...h, scope: "global" as const })),
    ];
    tagged.sort((a, b) => b.score - a.score);

    const merged: ScopedHit[] = [];
    const seen = new Set<string>();
    for (const h of tagged) {
      if (seen.has(h.memory.id)) continue;
      seen.add(h.memory.id);
      merged.push(h);
      if (merged.length >= topK) break;
    }
    return merged;
  };

  type AskCtx = {
    model?: unknown;
    modelRegistry?: { find: (p: string, m: string) => unknown };
    signal?: AbortSignal;
  };
  type SaveCtx = AskCtx & { cwd: string };

  // Bind an AskFn to the current agent model; undefined when no model is available.
  const makeAsk = (ctx: AskCtx): AskFn | undefined => {
    const model = resolveMemoryModel(
      ctx.model as never,
      (ctx.modelRegistry ?? { find: () => undefined }) as never,
      MEMORY_MODEL,
    );
    if (!model) return undefined;
    return (system, user) => askMemoryLlm(model, system, user, ctx.signal);
  };

  const smartSave = async (ctx: SaveCtx, text: string, scope: "project" | "global"): Promise<AppliedOp[]> => {
    const { project, global } = ensureStores(ctx.cwd);
    const store = scope === "global" ? global : project;
    const config = resolveEmbeddingConfig();
    const ask = SMART ? makeAsk(ctx) : undefined;
    if (!ask) {
      // MEMORY_SMART=0 or no model → naive dedup save.
      await store.save(text.trim(), null, config, ctx.signal);
      return [{ op: "ADD", text: text.trim() }];
    }
    return consolidate(store, text, { ask, config, model: MEMORY_MODEL ?? null, signal: ctx.signal });
  };

  const noticeFor = (ops: AppliedOp[]): string | undefined => {
    const changed = ops.filter((o) => o.op === "UPDATE" || o.op === "DELETE");
    if (!changed.length) return undefined;
    return changed
      .map((o) => (o.op === "UPDATE" ? `更新记忆：${o.text}` : `删除过时记忆 (${o.targetId})`))
      .join("\n");
  };

  pi.on("session_start", async (_event, ctx) => {
    ensureStores(ctx.cwd);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
    if (!prompt) return undefined;

    const { project } = ensureStores(ctx.cwd);
    const config = resolveEmbeddingConfig();

    // Auto-capture: explicit "记住: ..." / "remember: ..." statements only (low noise).
    if (AUTO_CAPTURE) {
      const m = prompt.match(/^\s*(?:记住|remember)\s*[:：]\s*(.+)/is);
      const captured = m?.[1]?.trim();
      if (captured) {
        await project.save(captured, "auto", config).catch(() => {});
      }
    }

    if (!AUTO_INJECT) return undefined;

    const hits = await recallMerged(ctx.cwd, prompt, AUTO_INJECT_TOPK, config).catch(() => []);
    if (!hits.length) return undefined;

    let body = "";
    for (const h of hits) {
      const tag = h.memory.category ? `[${h.memory.category}] ` : "";
      const line = `- ${tag}${h.memory.text} (${h.scope})`;
      if (body.length + line.length > AUTO_INJECT_MAX_CHARS) break;
      body += (body ? "\n" : "") + line;
    }
    if (!body) return undefined;

    return {
      message: {
        customType: "long-term-memory",
        content: `# Relevant long-term memory (auto-recalled)\n\n${body}`,
        display: true,
      },
    };
  });

  // Auto-extract: after each turn, pull durable facts from the conversation
  // (in-process LLM, no sub-process) and consolidate them into memory.
  // Off by default (MEMORY_EXTRACT=1 to enable) since it adds an LLM call per turn.
  pi.on("agent_end", async (event, ctx) => {
    if (!AUTO_EXTRACT) return;
    const messages = Array.isArray((event as { messages?: unknown[] })?.messages)
      ? (event as { messages: unknown[] }).messages
      : [];
    const convo = messages.map(messageToText).filter(Boolean).join("\n").slice(0, 12000);
    if (!convo.trim()) return;

    const ask = makeAsk(ctx);
    if (!ask) return; // no model available → skip extraction
    const facts = await extractFacts(ask, convo).catch(() => []);
    for (const fact of facts.slice(0, 10)) {
      await smartSave(ctx, fact, "project").catch(() => {});
    }
  });

  pi.registerTool({
    name: "memory_save",
    label: "Save Memory",
    description:
      "Save a durable long-term memory: a preference, decision, convention, or fact. " +
      "scope 'project' (default) stores it for this repo; scope 'global' stores it across all projects. " +
      "Use whenever the user reveals something worth remembering across sessions.",
    promptGuidelines: [
      "When the user states a lasting preference/decision/convention, call memory_save.",
      "Use scope 'global' for cross-project preferences (e.g. preferred language), 'project' for repo-specific rules.",
      "Keep each memory short and atomic.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "The fact to remember (short, atomic)" }),
      category: Type.Optional(Type.String({ description: "Optional tag: preference | decision | convention | fact" })),
      scope: Type.Optional(Type.String({ description: "'project' (default) or 'global'" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const text = (params.text ?? "").trim();
      if (!text) throw new Error("memory text must be non-empty");

      const scope = params.scope === "global" ? "global" : "project";
      const ops = await smartSave({ ...ctx, signal: signal ?? undefined }, text, scope);
      const summary = ops.map((o) => o.op).join(",");
      if (SMART_NOTICE) {
        const note = noticeFor(ops);
        if (note) ctx.ui.notify(`🧠 ${note}`, "info");
      }
      return {
        content: [{ type: "text", text: `Memory consolidated (${scope}): ${summary}` }],
        details: { scope, ops },
      };
    },
  });

  pi.registerTool({
    name: "memory_recall",
    label: "Recall Memory",
    description: "Recall relevant long-term memories (both project and global scopes) for the given query.",
    parameters: Type.Object({
      query: Type.String({ description: "What to recall about" }),
      topK: Type.Optional(Type.Number({ description: "Max memories to return (default 5)" })),
      categories: Type.Optional(
        Type.Array(Type.String(), { description: "Filter by category (preference/decision/convention/fact)" }),
      ),
      since: Type.Optional(Type.Number({ description: "Only memories created at/after this Unix ms" })),
      until: Type.Optional(Type.Number({ description: "Only memories created at/before this Unix ms" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = resolveEmbeddingConfig();
      const filters: RecallFilters = { categories: params.categories, from: params.since, to: params.until };
      const hits = await recallMerged(ctx.cwd, params.query, params.topK ?? 5, config, filters).catch(() => []);
      if (!hits.length) {
        return { content: [{ type: "text", text: "No relevant memories." }], details: { hits: [] } };
      }
      const body = hits
        .map(
          (h, i) =>
            `${i + 1}. ${h.memory.category ? `[${h.memory.category}] ` : ""}${h.memory.text} (${h.scope}, score ${h.score.toFixed(3)})`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text: `Recalled ${hits.length} memory(ies):\n${body}` }],
        details: { hits: hits.map((h) => ({ id: h.memory.id, scope: h.scope, score: Number(h.score.toFixed(4)) })) },
      };
    },
  });

  pi.registerCommand("memory", {
    description:
      "Manage memory: /memory list | /memory add <text> | /memory forget <id> | /memory clear [project|global|all] | /memory history [id] | /memory rollback <historyId>",
    handler: async (args, ctx) => {
      const { project, global } = ensureStores(ctx.cwd);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "list";

      if (sub === "add") {
        const text = parts.slice(1).join(" ").trim();
        if (!text) {
          ctx.ui.notify("Usage: /memory add <text>", "warn");
          return;
        }
        const ops = await smartSave({ ...ctx, signal: ctx.signal ?? undefined }, text, "project");
        ctx.ui.notify(`Saved (project): ${ops.map((o) => o.op).join(",")}`, "success");
        return;
      }

      if (sub === "promote") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /memory promote <id>", "warn");
          return;
        }
        const m = project.list(1000).find((x) => x.id === id);
        if (!m) {
          ctx.ui.notify(`No project memory ${id}.`, "warn");
          return;
        }
        const config = resolveEmbeddingConfig();
        await global.save(m.text, m.category ?? null, config);
        project.forget(id);
        ctx.ui.notify(`Promoted ${id} to global memory.`, "success");
        return;
      }

      if (sub === "list") {
        const lines = [
          ...project.list(50).map((m) => `[${m.id}] (project${m.category ? `/${m.category}` : ""}) ${m.text}`),
          ...global.list(50).map((m) => `[${m.id}] (global${m.category ? `/${m.category}` : ""}) ${m.text}`),
        ];
        ctx.ui.notify(lines.length ? `${lines.length} memory(ies):\n${lines.join("\n")}` : "No memories stored.", "info");
        return;
      }

      if (sub === "clear") {
        const scope = parts[1] ?? "all";
        if (scope === "project" || scope === "all") project.clear();
        if (scope === "global" || scope === "all") global.clear();
        ctx.ui.notify(`Cleared ${scope} memory.`, "info");
        return;
      }

      if (sub === "forget") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /memory forget <id>", "warn");
          return;
        }
        const ok = project.forget(id) || global.forget(id);
        ctx.ui.notify(ok ? `Forgot memory ${id}.` : `No memory with id ${id}.`, ok ? "success" : "warn");
        return;
      }

      if (sub === "history") {
        const id = parts[1];
        const rows = id ? project.history(id).concat(global.history(id)) : project.history(20).concat(global.history(20));
        const lines = rows
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 30)
          .map(
            (r) =>
              `#${r.historyId} ${r.op} [${r.memoryId}] ${r.oldText ?? "∅"} → ${r.newText ?? "∅"}${r.reason ? ` (${r.reason})` : ""}`,
          );
        ctx.ui.notify(lines.length ? `History:\n${lines.join("\n")}` : "No history.", "info");
        return;
      }

      if (sub === "rollback") {
        const hid = Number(parts[1]);
        if (!Number.isFinite(hid)) {
          ctx.ui.notify("Usage: /memory rollback <historyId>", "warn");
          return;
        }
        const config = resolveEmbeddingConfig();
        const r = (await project.rollback(hid, config)) ?? (await global.rollback(hid, config));
        ctx.ui.notify(r ? `Rolled back to history #${hid} (memory ${r.id}).` : `No history #${hid}.`, r ? "success" : "warn");
        return;
      }

      ctx.ui.notify(
        "Usage: /memory list | /memory add <text> | /memory forget <id> | /memory clear [project|global|all] | /memory history [id] | /memory rollback <historyId>",
        "warn",
      );
    },
  });
}
