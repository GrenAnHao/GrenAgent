// 子级模型路由授权：用户白名单 + 实时目录交集；thinking_level 校验。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getConfig } from "../_shared/runtime-config.js";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelSelectionPolicy {
  enabled: boolean;
  allowlist: Set<string>;
}

export interface RouteModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function readModelSelectionPolicy(): ModelSelectionPolicy {
  const sw = getConfig("SUBAGENT_MODEL_SELECTION")?.trim().toLowerCase();
  const allowlist = parseAllowlist(getConfig("SUBAGENT_MODEL_ALLOWLIST"));
  const enabled = (sw === "1" || sw === "true") && allowlist.size > 0;
  return { enabled, allowlist };
}

export function routeOf(m: RouteModel): string {
  return `${m.provider}/${m.id}`;
}

export function assertRouteAllowed(route: string, policy: ModelSelectionPolicy, available: readonly RouteModel[]): void {
  if (!policy.allowlist.has(route)) throw new Error(`路由 ${route} 不在授权白名单`);
  if (!available.some((m) => routeOf(m) === route)) throw new Error(`路由 ${route} 当前不可用`);
}

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

export function assertThinkingLevel(level: string, model: RouteModel): void {
  if (!isThinkingLevel(level)) throw new Error(`thinking_level 无效：${level}（可选 ${THINKING_LEVELS.join("/")}）`);
  if (level === "off") return;
  if (!model.reasoning) throw new Error(`模型 ${routeOf(model)} 不支持思考档`);
  if (model.thinkingLevelMap && model.thinkingLevelMap[level] === null) {
    throw new Error(`模型 ${routeOf(model)} 不支持思考档 ${level}`);
  }
}

/** 一个模型可用的思考档：无 reasoning 只有 off；有则去掉 map 里标 null 的。 */
export function supportedThinkingLevels(model: RouteModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((l) => model.thinkingLevelMap?.[l] !== null);
}
