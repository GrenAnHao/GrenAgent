// session-search: keyword search over past project sessions via SessionManager.list,
// which already exposes allMessagesText per session (no manual index needed for MVP).
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { rankSessions } from "./rank.js";

const enabled = () => (getConfig("HISTORY_SEARCH_ENABLED") ?? "1") !== "0";
const snippetChars = () => Number(getConfig("HISTORY_SEARCH_MAX_CHARS") ?? "300") || 300;

export default function (pi: ExtensionAPI) {
  if (!enabled()) return;

  pi.registerTool({
    name: "history_search",
    label: "Search History",
    description:
      "Search past conversation sessions in this project for a keyword. Returns matching sessions with snippets. " +
      "Use to recall what was done before in this repo.",
    parameters: Type.Object({
      query: Type.String({ description: "Keyword(s) to search for in past sessions" }),
      topK: Type.Optional(Type.Number({ description: "Max sessions to return (default 5)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const infos = await SessionManager.list(ctx.cwd).catch(() => []);
      const hits = rankSessions(infos, params.query ?? "", params.topK ?? 5, snippetChars());
      if (!hits.length) {
        return { content: [{ type: "text", text: "No matching sessions." }], details: { hits: [] } };
      }
      const body = hits.map((h, i) => `${i + 1}. [${h.id}] (${h.modified}) ${h.snippet}`).join("\n");
      return {
        content: [{ type: "text", text: `Found ${hits.length} session(s):\n${body}` }],
        details: { hits },
      };
    },
  });

  pi.registerCommand("history", {
    description: "搜索/列出历史会话：/history [关键词]",
    handler: async (args, ctx) => {
      const infos = await SessionManager.list(ctx.cwd).catch(() => []);
      const q = args.trim();
      if (!q) {
        const recent = [...infos].sort((a, b) => +new Date(b.modified) - +new Date(a.modified)).slice(0, 10);
        ctx.ui.notify(
          recent.length
            ? recent.map((i) => `[${i.id}] ${(i.firstMessage ?? "").slice(0, 60)}`).join("\n")
            : "无历史会话。",
          "info",
        );
        return;
      }
      const hits = rankSessions(infos, q, 10, snippetChars());
      ctx.ui.notify(
        hits.length ? hits.map((h, i) => `${i + 1}. [${h.id}] ${h.snippet}`).join("\n") : "无匹配会话。",
        "info",
      );
    },
  });
}
