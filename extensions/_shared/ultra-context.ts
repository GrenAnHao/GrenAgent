// 子代理路由域（ordinary / ultra）的判定与传递。
//
// 域在 spawn 时固定：根会话按自己的模式判定，子会话按落盘的 subagent_meta.routingMode（或进程 env 标记）判定，
// 之后父会话切到别的模式也不会改变已经建好的子会话。旧子会话没有标记，按 ordinary。
//
// 只放非敏感域标记（一个字符串），不进日志、不写全量配置或凭据。这个标记只决定选模来源，
// 不授予执行权限，也不替代 Ask / Plan / safety。

import { getAgentMode } from "../agent-mode/modes.js";
import { currentWorkspaceContext, runInWorkspace, type WorkspaceContext } from "./workspace-context.js";

/** 子代理配置 / env 里的内部键。不是用户设置项。 */
export const ROUTING_MODE_KEY = "PI_SUBAGENT_ROUTING_MODE";

export type RoutingMode = "ultra" | "ordinary";

type ModeSource = { cwd?: string; sessionManager?: { getSessionId?: () => string; getEntries?: () => unknown[] } };

/** 冷恢复 / 驻留时用来搭子会话自己的 ALS：只在这里补域键，不碰模型、档位或权限。 */
export interface RoutingContextBase {
  workspace: string;
  cwd: string;
  config?: Readonly<Record<string, string>>;
}

function isRoutingMode(value: unknown): value is RoutingMode {
  return value === "ultra" || value === "ordinary";
}

/** 内部键的取值：Ultra 域写 ultra，其余写 ordinary。 */
export function routingContextEnv(ultra: boolean): Record<string, string> {
  return { [ROUTING_MODE_KEY]: ultra ? "ultra" : "ordinary" };
}

/** 配置里已经固定的域；没有（或不是合法值）时 undefined。 */
export function routingModeFromConfig(
  config: Readonly<Record<string, string | undefined>> | undefined,
): RoutingMode | undefined {
  const value = config?.[ROUTING_MODE_KEY];
  return isRoutingMode(value) ? value : undefined;
}

/** 进程 env 里的域标记；worker 后端由宿主写进派生配置，会经 getConfig 读到。 */
export function routingModeFromEnv(): RoutingMode | undefined {
  const value = process.env[ROUTING_MODE_KEY];
  return isRoutingMode(value) ? value : undefined;
}

/** 子会话 JSONL 里的域：旧子会话没有标记，视 ordinary。 */
export function routingModeFromMeta(meta: Record<string, unknown> | undefined): RoutingMode {
  const value = meta?.routingMode;
  return isRoutingMode(value) ? value : "ordinary";
}

/**
 * 当前上下文已经固定下来的域。只在真的子代理上下文里生效（ALS origin=subagent，或进程自身就是子代理）：
 * 根会话的 ALS / env 里即使带着这个键，也不是它的域，根会话只能由真实 AgentMode 决定。
 */
export function pinnedRoutingMode(): RoutingMode | undefined {
  const als = currentWorkspaceContext();
  if (als?.origin === "subagent") {
    const pinned = routingModeFromConfig(als.config);
    if (pinned) return pinned;
  }
  return routingModeFromEnv();
}

/** 在子会话的域里跑：SDK 扩展初始化、prompt/followUp 都按这个域读配置，而不是父会话当下可能已经切走的 ALS。 */
const DOMAIN_METHODS = new Set(["prompt", "sendCustomMessage", "bindExtensions"]);

/**
 * 把会话的 prompt / sendCustomMessage / bindExtensions 包进这个子会话自己的域上下文再执行。
 * 其余成员原样转发（绑定到原对象，避免代理改变 this）。共享同一份 context，后续每条消息都不跟着父会话变。
 * 只包投递面（收件箱、wake:false 投递），宿主拿到的会话对象保持原样。
 */
export function bindRoutingDomain<T extends object>(target: T, ctx: WorkspaceContext): T {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      if (bound.has(prop)) return bound.get(prop);
      const wrapped = DOMAIN_METHODS.has(String(prop))
        ? (...args: unknown[]) => runInWorkspace(ctx, () => Reflect.apply(value, t, args))
        : value.bind(t);
      bound.set(prop, wrapped);
      return wrapped;
    },
  });
}

/**
 * 按域搭子会话的 ALS 上下文：键集与调用方原来的上下文一致（不改变既有的审批 / 安全 / 运行时配置继承），
 * 只把域键换成这个子会话自己固定的那一份。父会话后来切了模式也不会改到它。
 */
export function routingWorkspaceContext(mode: RoutingMode, base: RoutingContextBase): WorkspaceContext {
  return {
    origin: "subagent",
    workspace: base.workspace,
    cwd: base.cwd,
    config: {
      ...(currentWorkspaceContext()?.config ?? {}),
      ...(base.config ?? {}),
      ...routingContextEnv(mode === "ultra"),
    },
  };
}

/** 把已经固定下来的域写回一个长期存活的上下文（worker 里 resume 之后每条 RPC 都用它）；其余键不动。 */
export function withRoutingMode(ctx: WorkspaceContext, mode: RoutingMode): WorkspaceContext {
  return { ...ctx, config: { ...ctx.config, ...routingContextEnv(mode === "ultra") } };
}

function safeEntries(source: ModeSource | undefined): unknown[] {
  try {
    const entries = source?.sessionManager?.getEntries?.();
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function safeSessionId(source: ModeSource | undefined): string | undefined {
  try {
    const id = source?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 最后一条 subagent_meta（只读这里要用的字段，不依赖 multi-agent 模块）。 */
export function lastRoutingMeta(entries: readonly unknown[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const item = entry as { type?: string; customType?: string; data?: unknown } | undefined;
    if (item?.type !== "custom" || item.customType !== "subagent_meta") continue;
    if (item.data && typeof item.data === "object") found = item.data as Record<string, unknown>;
  }
  return found;
}

/** 这个进程自己就是子代理（CLI / worker 后端），没有会话条目可看。 */
function isSubagentProcess(): boolean {
  return process.env.PI_IS_SUBAGENT === "1";
}

/**
 * 当前上下文是否属于 Ultra 路由域。
 * - 有 subagent_meta 的会话：meta.routingMode 说了算；旧子会话没有这个标记就是 ordinary，
 *   不继承父会话当下可能已经切到 Ultra 的标记。
 * - 没有 SDK 会话对象的子代理上下文（进程内孙代理、worker 进程）：沿用上下文已固定的域。
 * - 提供了 SDK 会话对象但没有子代理元数据时，按该根会话自身模式判定，不能被投递方 ALS 污染。
 * - 其余根会话也只看真实 AgentMode，切 Ultra 的唯一入口是模式。
 */
export function isUltraRouting(ctx?: ModeSource): boolean {
  const meta = lastRoutingMeta(safeEntries(ctx));
  if (meta) return isRoutingMode(meta.routingMode) && meta.routingMode === "ultra";
  const als = currentWorkspaceContext();
  if (!ctx?.sessionManager && (als?.origin === "subagent" || isSubagentProcess())) {
    return pinnedRoutingMode() === "ultra";
  }
  // 模式表取不到（宿主还没接入 / 上下文已失效）时按 ordinary：域标记只会少给，不会多给。
  try {
    return (getAgentMode(ctx?.cwd, safeSessionId(ctx)) as string) === "ultra";
  } catch {
    return false;
  }
}
