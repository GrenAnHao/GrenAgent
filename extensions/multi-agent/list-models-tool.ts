import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isUltraRouting } from "../_shared/ultra-context.js";
import { resolveSubagentModel } from "./runner.js";
import { catalogModel, routeLabel, ultraAlias, ultraAllowlist, ultraConfiguredRoutes } from "./routing.js";
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
  // Always present: the same session may switch between Agent and Ultra.
  pi.registerTool({
    name: "list_subagent_models",
    label: "List Sub-agent Models",
    description:
      "List the model routes you may pick for a sub-agent (`spawn_agent` `model`), with each route's supported thinking levels. " +
      "Also lists the `cheap` / `strong` aliases the user configured and the route each one resolves to. " +
      "When ordinary self-selection is off it still lists the default route sub-agents will use, so `thinking_level` can be checked against it. " +
      "Omit `provider` to list every authorized route.",
    promptSnippet: "List authorized model routes for spawn_agent.",
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "Only list routes of this provider id." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const filter = typeof params.provider === "string" ? params.provider.trim() : "";
      const avail = availableModels(ctx as never);
      const ultra = isUltraRouting(ctx);
      if (!ultra && !policy.enabled) {
        // 自选关闭时白名单不存在，但子代理仍会跑在一条默认路由上。只丢一句「未开启」会让父模型对
        // 这条路由的思考档完全不知情，只能照别家的默认档去猜（曾因此写死模型中不存在的 medium）。
        const fallback = resolveSubagentModel() ?? routeLabel(ctx.model);
        const rows = [fallback, ...ROUTE_ALIASES.map((alias) => resolveRouteAlias(alias))]
          .filter((route): route is string => Boolean(route))
          .filter((route, index, all) => all.indexOf(route) === index)
          .filter((route) => !filter || route.slice(0, Math.max(route.indexOf("/"), 0)) === filter)
          .map((route) => {
            const m = catalogModel(route, avail);
            if (!m) return `${route} — 当前不可用`;
            return `${routeOf(m)} — ${m.name ?? m.id}；思考档：${supportedThinkingLevels(m).join("/")}`;
          });
        const head = "普通子代理模型自选未开启；省略 model 使用普通默认配置。";
        return {
          content: [{ type: "text", text: rows.length ? `${head}\n\n${rows.join("\n")}` : head }],
          details: {},
        };
      }
      let allow: ReadonlySet<string>;
      try {
        allow = ultra
          ? new Set([...ultraAllowlist(), ...ultraConfiguredRoutes(), routeLabel(ctx.model)]
            .filter((value): value is string => Boolean(value))
            .map((value) => routeLabel(catalogModel(value, avail)) ?? value))
          : policy.allowlist;
      } catch (error) {
        return { content: [{ type: "text", text: String((error as Error).message) }], details: {}, isError: true };
      }
      const rows = avail
        .filter((m) => allow.has(routeOf(m)))
        .filter((m) => !filter || m.provider === filter)
        .map((m) => `${routeOf(m)} — ${m.name ?? m.id}；思考档：${supportedThinkingLevels(m).join("/")}${m.contextWindow ? `；上下文：${m.contextWindow}` : ""}`);
      for (const alias of ROUTE_ALIASES) {
        const route = ultra ? ultraAlias(alias) : resolveRouteAlias(alias);
        if (!route) continue;
        if (filter && route.slice(0, Math.max(route.indexOf("/"), 0)) !== filter) continue;
        const m = catalogModel(route, avail);
        const what = m ? `${m.name ?? m.id}；思考档：${supportedThinkingLevels(m).join("/")}` : "当前不可用";
        rows.push(`${alias} → ${m ? routeLabel(m) : route} — ${what}（${ultra ? "Ultra 角色配置别名" : "别名，不受白名单限制"}；直接写 model: "${alias}"）`);
      }
      return {
        content: [{ type: "text", text: rows.length ? rows.join("\n") : "白名单内暂无可用模型" }],
        details: {},
      };
    },
  });
}
