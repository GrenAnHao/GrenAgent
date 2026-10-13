// list_agents（照 DSH listChildren / Codex list_agents）：列出调用者自己派过的直接子代理。
// 名单来自父会话 JSONL 里的子代理目录（subagent_catalog），重启后照样列得出来；状态只报 running / inactive，
// 由运行时状态投影（活着的 Activation、后台登记、正在跑的前台运行）。inactive 的可续聊子代理仍能 send_message（冷恢复）。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolPrompt } from "../_shared/toolPrompt.js";
import { getActivation } from "./activation.js";
import { activeRuns } from "./active-runs.js";
import { foldCatalogFromEntries, type SubagentCatalogEntry } from "./catalog.js";
import { runningChildrenOf } from "./child-runs.js";

export type ListedAgentStatus = "running" | "inactive";

export interface ListedAgent {
  childId: string;
  status: ListedAgentStatus;
  mode: SubagentCatalogEntry["mode"];
  label: string;
  sessionPath: string;
  createdAt: number;
}

type Ctx = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

function catalogEntries(ctx: Ctx): SubagentCatalogEntry[] {
  try {
    const sm = ctx.sessionManager as { buildContextEntries?: () => unknown; getEntries?: () => unknown };
    const entries = (sm.buildContextEntries?.() ?? sm.getEntries?.() ?? []) as Array<Record<string, unknown>>;
    return foldCatalogFromEntries(Array.isArray(entries) ? entries : []).entries;
  } catch {
    return [];
  }
}

export function listChildren(ctx: Ctx): ListedAgent[] {
  let sessionId = "";
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch {
    /* 拿不到会话 id 时只按 Activation 判断 */
  }
  const running = new Set<string>([...runningChildrenOf(sessionId), ...activeRuns().map((r) => r.childId)]);
  const seen = new Set<string>();
  const out: ListedAgent[] = [];
  for (const entry of catalogEntries(ctx)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push({
      childId: entry.id,
      status: running.has(entry.id) || getActivation(entry.id) ? "running" : "inactive",
      mode: entry.mode,
      label: entry.label,
      sessionPath: entry.sessionPath,
      createdAt: entry.createdAt,
    });
  }
  return out;
}

export function formatListedAgents(agents: readonly ListedAgent[]): string {
  if (agents.length === 0) return "You have not started any sub-agents in this session.";
  return agents
    .map((a) => {
      const note = a.mode === "one-shot" ? " (one-shot: cannot receive messages)" : "";
      return `${a.childId}  [${a.status}]  ${a.label}${note}`;
    })
    .join("\n");
}

export function registerListAgents(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "list_agents",
    label: "List Sub-agents",
    description:
      "List the sub-agents this session started, from the session's own sub-agent catalog (so it survives restarts). " +
      "Each is marked running or inactive. An inactive continuable sub-agent can still receive send_message; it is resumed from its log. " +
      "One-shot sub-agents (from action \"run\") cannot receive messages.",
    ...toolPrompt("List the sub-agents you started and whether each is running.", [
      "Use list_agents to find a child's id before send_message or interrupt_agent; it lists only your own direct children.",
    ]),
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const agents = listChildren(ctx);
      return {
        content: [{ type: "text", text: formatListedAgents(agents) }],
        details: { agents },
      };
    },
  });
}
