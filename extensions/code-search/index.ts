// code-search: embedding-based semantic search over project code. Pure extension,
// default OFF (grep covers keywords). Fail-soft when no embedding provider.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { type EmbeddingConfig, embedTexts, resolveEmbedding } from "../_shared/embedding.js";
import { getConfig } from "../_shared/runtime-config.js";
import { topKByCosine } from "../_shared/vector-store.js";
import { chunkText } from "./chunker.js";
import { listCodeFiles } from "./files.js";
import { CodeIndex } from "./store.js";

const enabled = () => (getConfig("CODE_SEARCH_ENABLED") ?? "0") !== "0";
const chunkLines = () => Number(getConfig("CODE_SEARCH_CHUNK_LINES") ?? "60") || 60;
const extSet = () =>
  new Set(
    (getConfig("CODE_SEARCH_EXTS") ?? ".ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.cs,.rb,.php")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

export default function (pi: ExtensionAPI) {
  if (!enabled()) return;

  const cfgFor = (ctx: ExtensionContext): Promise<EmbeddingConfig> =>
    resolveEmbedding(
      ctx.modelRegistry as never,
      getConfig("CODE_EMBED_PROVIDER") ?? getConfig("KB_EMBED_PROVIDER"),
      getConfig("CODE_EMBED_MODEL") ?? getConfig("KB_EMBED_MODEL"),
    );

  const dbPath = (ctx: ExtensionContext) => join(ctx.cwd, ".pi", "code-index", "index.db");

  const reindex = async (ctx: ExtensionContext, cfg: EmbeddingConfig, signal?: AbortSignal): Promise<number> => {
    const idx = new CodeIndex(dbPath(ctx));
    let indexed = 0;
    try {
      for (const file of listCodeFiles(ctx.cwd, extSet())) {
        const mtime = Math.floor(statSync(file).mtimeMs);
        if (idx.mtimeOf(file) === mtime) continue;
        const chunks = chunkText(readFileSync(file, "utf8"), chunkLines());
        if (!chunks.length) continue;
        const vectors = await embedTexts(
          chunks.map((c) => c.text),
          cfg,
          signal,
        );
        idx.replaceFile(
          file,
          mtime,
          chunks.map((c, i) => ({ startLine: c.startLine, endLine: c.endLine, text: c.text, vector: vectors[i] ?? [] })),
        );
        indexed++;
      }
    } finally {
      idx.close();
    }
    return indexed;
  };

  pi.registerTool({
    name: "code_search",
    label: "Code Search",
    description:
      "Semantic (embedding-based) code search over this project. Returns the most relevant code chunks with file:line ranges. " +
      "Complements grep (keyword). Run /code-index rebuild first if the index is empty.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language description of the code to find" }),
      topK: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cfg = await cfgFor(ctx);
      if (!cfg.enabled) {
        return {
          content: [{ type: "text", text: "Code search disabled: configure an embedding provider (CODE_EMBED_PROVIDER / KB_EMBED_PROVIDER)." }],
          details: { hits: [] },
        };
      }
      const idx = new CodeIndex(dbPath(ctx));
      try {
        const rows = idx.all();
        if (!rows.length) {
          return { content: [{ type: "text", text: "Code index is empty. Run /code-index rebuild first." }], details: { hits: [] } };
        }
        const [qv] = await embedTexts([params.query], cfg, signal ?? undefined);
        if (!qv) return { content: [{ type: "text", text: "Failed to embed query." }], details: { hits: [] } };
        const hits = topKByCosine(
          qv,
          rows.map((r) => ({ item: r, vector: r.vector })),
          params.topK ?? 5,
        );
        const body = hits
          .map((h, i) => `${i + 1}. ${h.item.file}:${h.item.startLine}-${h.item.endLine} (score ${h.score.toFixed(3)})`)
          .join("\n");
        return {
          content: [{ type: "text", text: `${hits.length} result(s):\n${body}` }],
          details: {
            hits: hits.map((h) => ({
              file: h.item.file,
              startLine: h.item.startLine,
              endLine: h.item.endLine,
              score: Number(h.score.toFixed(4)),
            })),
          },
        };
      } finally {
        idx.close();
      }
    },
  });

  pi.registerCommand("code-index", {
    description: "重建语义代码索引：/code-index rebuild",
    handler: async (_args, ctx) => {
      const cfg = await cfgFor(ctx);
      if (!cfg.enabled) {
        ctx.ui.notify("未配置 embedding 供应商（CODE_EMBED_PROVIDER / KB_EMBED_PROVIDER），代码搜索不可用。", "warning");
        return;
      }
      try {
        const n = await reindex(ctx, cfg, ctx.signal ?? undefined);
        ctx.ui.notify(`已索引/更新 ${n} 个文件。`, "info");
      } catch (e) {
        ctx.ui.notify(`索引失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
