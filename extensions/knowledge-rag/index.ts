// knowledge-rag: a local knowledge base / RAG extension for Pi.
//
// Tools (LLM-callable):
//   kb_search  - semantic/keyword search over the project knowledge base
//   kb_add     - index a file or inline text into the knowledge base
// Command:
//   /kb stats | /kb add <path> | /kb clear
//
// Storage lives at <cwd>/.pi/knowledge/default.json so it is project-scoped
// and survives restarts. Embeddings are optional (see embedding.ts / README).

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveEmbeddingConfig } from "./embedding.js";
import { KnowledgeStore } from "./store.js";
import { getConfig } from "../_shared/runtime-config.js";

const MAX_RESULT_CHARS = 8000;
const autoInject = () => (getConfig("KB_AUTO_INJECT") ?? "1") !== "0";
const autoInjectTopK = () => Number(getConfig("KB_AUTO_TOPK") ?? "3") || 3;
const AUTO_INJECT_MAX_CHARS = 6000;

export default function (pi: ExtensionAPI) {
  let store: KnowledgeStore | undefined;
  let storePath = "";

  const ensureStore = (cwd: string): KnowledgeStore => {
    if (!store) {
      storePath = join(cwd, ".pi", "knowledge", "default.db");
      store = new KnowledgeStore(storePath);
      store.load();
    }
    return store;
  };

  pi.on("session_start", async (_event, ctx) => {
    ensureStore(ctx.cwd);
  });

  // Auto-RAG: retrieve relevant snippets for the user's prompt and inject them
  // as extra context before the agent loop runs. Toggle off with KB_AUTO_INJECT=0.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!autoInject()) return undefined;
    const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
    if (!prompt) return undefined;

    const kb = ensureStore(ctx.cwd);
    const config = await resolveEmbeddingConfig(ctx.modelRegistry);
    const hits = await kb.search(prompt, autoInjectTopK(), config).catch(() => []);
    if (!hits.length) return undefined;

    let body = "";
    for (let i = 0; i < hits.length; i++) {
      const block = `[#${i + 1}] (source: ${hits[i].chunk.source})\n${hits[i].chunk.text}`;
      if (body.length + block.length > AUTO_INJECT_MAX_CHARS) break;
      body += (body ? "\n\n---\n\n" : "") + block;
    }
    if (!body) return undefined;

    return {
      message: {
        customType: "knowledge-rag",
        content: `# Knowledge base context (auto-retrieved for this prompt)\n\n${body}`,
        display: true,
      },
    };
  });

  pi.registerTool({
    name: "kb_search",
    label: "Knowledge Search",
    description:
      "Search the project's local knowledge base for relevant snippets. " +
      "Call this before answering questions about indexed docs, specs, decisions or code notes.",
    promptSnippet: "Search the local knowledge base (RAG) for relevant context before answering.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      topK: Type.Optional(Type.Number({ description: "Max snippets to return (default 5)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const kb = ensureStore(ctx.cwd);
      const config = await resolveEmbeddingConfig(ctx.modelRegistry);
      const hits = await kb.search(params.query, params.topK ?? 5, config, signal ?? undefined);

      if (!hits.length) {
        return {
          content: [{ type: "text", text: "No matching entries in the knowledge base." }],
          details: { mode: config.enabled ? "semantic" : "keyword", hits: [] },
        };
      }

      const mode = config.enabled ? "semantic" : "keyword";
      let body = "";
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        const block = `[#${i + 1}] (source: ${h.chunk.source}, score: ${h.score.toFixed(3)})\n${h.chunk.text}`;
        if (body.length + block.length > MAX_RESULT_CHARS) break;
        body += (body ? "\n\n---\n\n" : "") + block;
      }

      return {
        content: [{ type: "text", text: `Top ${hits.length} result(s) [${mode}]:\n\n${body}` }],
        details: {
          mode,
          hits: hits.map((h) => ({ source: h.chunk.source, score: Number(h.score.toFixed(4)) })),
        },
      };
    },
  });

  pi.registerTool({
    name: "kb_add",
    label: "Knowledge Add",
    description:
      "Index a file or inline text into the project's knowledge base (chunked, then embedded if a key is configured). " +
      "Re-indexing the same source replaces its previous chunks.",
    parameters: Type.Object({
      source: Type.String({ description: "Identifier for this document (e.g. file path or a title)" }),
      path: Type.Optional(Type.String({ description: "Read content from this file (relative to cwd or absolute)" })),
      text: Type.Optional(Type.String({ description: "Inline text content (use instead of path)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const kb = ensureStore(ctx.cwd);

      let text = params.text ?? "";
      if (params.path) {
        const abs = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
        text = readFileSync(abs, "utf8");
      }
      if (!text.trim()) {
        throw new Error("Provide non-empty 'text' or a readable 'path'.");
      }

      const config = await resolveEmbeddingConfig(ctx.modelRegistry);
      const chunks = await kb.addDocument(params.source, text, config, signal ?? undefined);

      return {
        content: [
          {
            type: "text",
            text: `Indexed "${params.source}" into ${chunks} chunk(s) (${config.enabled ? `embedded: ${config.model}` : "keyword-only"}).`,
          },
        ],
        details: { source: params.source, chunks, embedded: config.enabled },
      };
    },
  });

  pi.registerCommand("kb", {
    description: "Manage the knowledge base: /kb stats | /kb add <path> | /kb clear",
    handler: async (args, ctx) => {
      const kb = ensureStore(ctx.cwd);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "stats";

      if (sub === "stats") {
        const s = kb.stats();
        ctx.ui.notify(
          `KB: ${s.chunks} chunk(s) from ${s.sources} source(s). model=${s.model ?? "(keyword)"}. store=${storePath}`,
          "info",
        );
        return;
      }

      if (sub === "clear") {
        kb.clear();
        ctx.ui.notify("Knowledge base cleared.", "info");
        return;
      }

      if (sub === "add") {
        const p = parts.slice(1).join(" ");
        if (!p) {
          ctx.ui.notify("Usage: /kb add <path>", "warn");
          return;
        }
        const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
        const config = await resolveEmbeddingConfig(ctx.modelRegistry);
        const chunks = await kb.addDocument(p, readFileSync(abs, "utf8"), config);
        ctx.ui.notify(`Indexed ${p} into ${chunks} chunk(s).`, "success");
        return;
      }

      ctx.ui.notify("Usage: /kb stats | /kb add <path> | /kb clear", "warn");
    },
  });
}
