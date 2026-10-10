import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ROUTE_ALIASES,
  resolveRouteAlias,
  routeOf,
  supportedThinkingLevels,
  type ModelSelectionPolicy,
  type RouteModel,
} from "./model-selection.js";

export function availableModels(ctx: { modelRegistry?: { getAvailable?: () => unknown } }): RouteModel[] {
  try {
    const list = ctx.modelRegistry?.getAvailable?.();
    return Array.isArray(list) ? (list as RouteModel[]) : [];
  } catch {
    return [];
  }
}

export function registerListSubagentModels(pi: ExtensionAPI, policy: ModelSelectionPolicy): void {
  if (!policy.enabled) return;
  pi.registerTool({
    name: "list_subagent_models",
    label: "List Sub-agent Models",
    description:
      "List the model routes you may pick for a sub-agent (`spawn_agent` `model`), with each route's supported thinking levels. " +
      "Also lists the `cheap` / `strong` aliases the user configured and the route each one resolves to. " +
      "Omit `provider` to list every authorized route.",
    promptSnippet: "List authorized model routes for spawn_agent.",
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "Only list routes of this provider id." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const filter = typeof params.provider === "string" ? params.provider.trim() : "";
      const avail = availableModels(ctx as never);
      const allow = policy.allowlist;
      const rows = avail
        .filter((m) => allow.has(routeOf(m)))
        .filter((m) => !filter || m.provider === filter)
        .map((m) => `${routeOf(m)} — ${m.name ?? m.id}；思考档：${supportedThinkingLevels(m).join("/")}`);
      for (const alias of ROUTE_ALIASES) {
        const route = resolveRouteAlias(alias);
        if (!route) continue;
        if (filter && route.slice(0, Math.max(route.indexOf("/"), 0)) !== filter) continue;
        const m = avail.find((x) => routeOf(x) === route);
        const what = m ? `${m.name ?? m.id}；思考档：${supportedThinkingLevels(m).join("/")}` : "当前不可用";
        rows.push(`${alias} → ${route} — ${what}（别名，不受白名单限制；直接写 model: "${alias}"）`);
      }
      return {
        content: [{ type: "text", text: rows.length ? rows.join("\n") : "白名单内暂无可用模型" }],
        details: {},
      };
    },
  });
}
