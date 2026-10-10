// 子级模型路由授权：用户白名单 + 实时目录交集；thinking_level 校验。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getConfig } from "../_shared/runtime-config.js";
import { profileToModel } from "./capability.js";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelSelectionPolicy {
  /** 工厂加载时定下来：决定 spawn_agent 有没有 model 字段、是否注册发现工具。工具 schema 之后改不了，所以只对新会话生效。 */
  enabled: boolean;
  /** 每次访问都重读设置：白名单增删对已打开的会话立即生效；开关被关掉时视为空。 */
  readonly allowlist: ReadonlySet<string>;
}

/** 档案别名：解析到设置里的「子代理便宜 / 强模型」，不受白名单约束。 */
export const ROUTE_ALIASES = ["cheap", "strong"] as const;
export type RouteAlias = (typeof ROUTE_ALIASES)[number];

export function isRouteAlias(value: string): value is RouteAlias {
  return (ROUTE_ALIASES as readonly string[]).includes(value);
}

/** cheap / strong → 当前设置里的路由；字面路由原样返回。解析不出（继承父模型、两个键都空）返回 undefined。 */
export function resolveRouteAlias(route: string): string | undefined {
  return profileToModel({ model: route }, getConfig);
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

function selectionSwitchOn(): boolean {
  const sw = getConfig("SUBAGENT_MODEL_SELECTION")?.trim().toLowerCase();
  return sw === "1" || sw === "true";
}

function liveAllowlist(): Set<string> {
  return selectionSwitchOn() ? parseAllowlist(getConfig("SUBAGENT_MODEL_ALLOWLIST")) : new Set();
}

export function readModelSelectionPolicy(): ModelSelectionPolicy {
  const enabled = liveAllowlist().size > 0;
  return {
    enabled,
    get allowlist() {
      return liveAllowlist();
    },
  };
}

export function routeOf(m: RouteModel): string {
  return `${m.provider}/${m.id}`;
}

export function assertRouteAllowed(route: string, policy: ModelSelectionPolicy, available: readonly RouteModel[]): void {
  if (isRouteAlias(route)) {
    // 别名是用户配好的默认，不查白名单与目录；解析不出来要明说，不能悄悄落到父模型。
    if (!resolveRouteAlias(route)) throw new Error(`别名 ${route} 没有对应模型（设置 → 子代理未配置，或策略为继承父模型）`);
    return;
  }
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
