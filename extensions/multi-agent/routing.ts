import { resolveCliModel } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import type { RouteModel } from "./model-selection.js";

export const ULTRA_MODEL_KEYS = {
  scout: "ULTRA_SUBAGENT_MODEL_SCOUT",
  worker: "ULTRA_SUBAGENT_MODEL_WORKER",
  planner: "ULTRA_SUBAGENT_MODEL_PLANNER",
  reviewer: "ULTRA_SUBAGENT_MODEL_REVIEWER",
} as const;
export const ULTRA_DEFAULT_MODEL_KEY = "ULTRA_SUBAGENT_MODEL";
export const ULTRA_ALLOWLIST_KEY = "ULTRA_SUBAGENT_MODEL_ALLOWLIST";
type ConfigReader = (key: string) => string | undefined;
const clean = (value: string | undefined) => value?.trim() || undefined;
export const routeLabel = (model: { provider?: string; id?: string } | undefined) =>
  model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;

export function ultraAlias(route: string, read: ConfigReader = getConfig): string | undefined {
  if (route === "cheap") return clean(read(ULTRA_MODEL_KEYS.scout)) ?? clean(read(ULTRA_DEFAULT_MODEL_KEY));
  if (route === "strong") return clean(read(ULTRA_MODEL_KEYS.worker)) ?? clean(read(ULTRA_DEFAULT_MODEL_KEY));
  return clean(route);
}

export function ultraConfiguredRoutes(read: ConfigReader = getConfig): Set<string> {
  return new Set([ULTRA_DEFAULT_MODEL_KEY, ...Object.values(ULTRA_MODEL_KEYS)].map((key) => clean(read(key))).filter((v): v is string => Boolean(v)));
}

export function ultraAllowlist(read: ConfigReader = getConfig): Set<string> {
  const raw = clean(read(ULTRA_ALLOWLIST_KEY));
  if (!raw) return new Set();
  let values: unknown;
  try { values = JSON.parse(raw); } catch { throw new Error(`Ultra ${ULTRA_ALLOWLIST_KEY} 必须是模型路由 JSON 数组`); }
  if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`Ultra ${ULTRA_ALLOWLIST_KEY} 必须是非空模型标识组成的 JSON 数组`);
  }
  return new Set(values.map((value: string) => value.trim()));
}

/** Use the SDK reference parser, including ids containing '/', ':', and legacy bare names. */
export function catalogModel(raw: string, models: readonly RouteModel[], fuzzy = false): RouteModel | undefined {
  const exact = models.find((model) => routeLabel(model) === raw);
  if (exact) return exact;
  const candidates = fuzzy ? models : models.filter((model) => model.id.toLowerCase() === raw.toLowerCase());
  if (!candidates.length) return undefined;
  const resolved = resolveCliModel({ cliModel: raw, modelRuntime: {
    getModels: () => candidates,
    hasConfiguredAuth: () => true,
  } as never });
  // The SDK may synthesize a custom provider id. Ultra only accepts catalog models.
  return resolved.model ? models.find((model) => routeLabel(model) === routeLabel(resolved.model)) : undefined;
}

export function routingError(location: string, agent: string | undefined, source: string, value: string | undefined, reason: string): Error {
  return new Error(`${location} · agent="${agent || "default"}" · ${source}${value ? `="${value}"` : ""}：${reason}`);
}

export interface ResolvedUltraRoute {
  model: string;
  source: string;
}

export function resolveUltraRoute(input: {
  model?: string;
  agent?: string;
  location: string;
  parent?: { provider?: string; id?: string };
  available: readonly RouteModel[];
  read?: ConfigReader;
}): ResolvedUltraRoute {
  const read = input.read ?? getConfig;
  const explicit = clean(input.model);
  const roleKey = ULTRA_MODEL_KEYS[input.agent as keyof typeof ULTRA_MODEL_KEYS];
  const role = roleKey ? clean(read(roleKey)) : undefined;
  const fallback = clean(read(ULTRA_DEFAULT_MODEL_KEY));
  const source = explicit ? "model (Ultra)" : role ? roleKey! : fallback ? ULTRA_DEFAULT_MODEL_KEY : "父会话实际模型 (Ultra)";
  const raw = explicit ? ultraAlias(explicit, read) : role ?? fallback ?? routeLabel(input.parent);
  if (!raw) throw routingError(input.location, input.agent, source, explicit, "Ultra 模型无法解析；请配置 Ultra 默认/角色模型或使用已有主会话模型");
  const target = catalogModel(raw, input.available);
  if (!target) throw routingError(input.location, input.agent, source, raw, "Ultra 模型当前不可用，请检查供应商、认证及模型标识");
  const route = routeLabel(target)!;
  if (explicit) {
    const authorized = new Set([...ultraConfiguredRoutes(read), ...ultraAllowlist(read), routeLabel(input.parent)]
      .filter((value): value is string => Boolean(value))
      .map((value) => routeLabel(catalogModel(value, input.available)) ?? value));
    if (!authorized.has(route)) throw routingError(input.location, input.agent, source, explicit, `Ultra 路由 ${route} 不在 Ultra 配置或授权白名单中`);
  }
  return { model: route, source };
}
