import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { routeOf, supportedThinkingLevels, type ModelSelectionPolicy, type RouteModel } from "./model-selection.js";

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
      "Omit `provider` to list every authorized route.",
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "Only list routes of this provider id." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const filter = typeof params.provider === "string" ? params.provider.trim() : "";
      const rows = availableModels(ctx as never)
        .filter((m) => policy.allowlist.has(routeOf(m)))
        .filter((m) => !filter || m.provider === filter)
        .map((m) => `${routeOf(m)} — ${m.name ?? m.id}；思考档：${supportedThinkingLevels(m).join("/")}`);
      return {
        content: [{ type: "text", text: rows.length ? rows.join("\n") : "白名单内暂无可用模型" }],
        details: {},
      };
    },
  });
}
