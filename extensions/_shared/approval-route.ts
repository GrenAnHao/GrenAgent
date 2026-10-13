// 子代理的审批路由：子会话没有自己的界面，需要人批准时把请求一层层转给父会话，直到有界面的顶层会话。
// 按会话文件路径登记（会话文件全局唯一）：
// - 顶层会话（有界面的主会话）登记 top 路由，用它自己的 ctx.ui.select 问人；
// - 子会话登记 child 路由，只记父会话路径和自己的身份，请求经过时把身份加进 chain；
// - worker 进程里找不到父会话（父会话在宿主进程），交给 upstream（经 RPC 回宿主再查）。
// 每次请求最多等 SUBAGENT_APPROVAL_TIMEOUT_MS（默认 60 秒，从子代理发出请求算起）；设 0 不转发，
// 子代理的审批照旧由主进程固定拒绝。

import { getConfig } from "./runtime-config.js";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

export interface ApprovalAsker {
  agentId: string;
  label: string;
}

export interface ApprovalRequest {
  title: string;
  options: string[];
  /** 经过的子代理，从发起请求的那个开始，越往后离顶层越近。 */
  chain: ApprovalAsker[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export type ApprovalOutcome =
  | { outcome: "answered"; choice: string }
  | { outcome: "timeout" | "cancelled" | "unavailable" };

/** 顶层会话的界面：只用到 select。opts 里的 subagents / timeout 由 Electron 宿主转给渲染层。 */
export interface ApprovalUi {
  select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
}

/** worker 进程里的出口：本进程查不到的会话路径交给宿主（经 RPC），能不能问到人也问宿主。 */
export interface ApprovalUpstream {
  ask: (sessionPath: string, request: ApprovalRequest) => Promise<ApprovalOutcome>;
  reachable: (sessionPath: string) => Promise<boolean>;
}

type Route =
  | { kind: "top"; ui: ApprovalUi }
  | { kind: "child"; parentSessionPath: string | undefined; asker: ApprovalAsker };

const routes = new Map<string, Route>();
let upstream: ApprovalUpstream | undefined;

const UNAVAILABLE: ApprovalOutcome = { outcome: "unavailable" };
const LABEL_MAX = 24;

function register(sessionPath: string, route: Route): () => void {
  routes.set(sessionPath, route);
  return () => {
    if (routes.get(sessionPath) === route) routes.delete(sessionPath);
  };
}

/** 有界面的顶层会话登记自己，子代理的请求最终由它问人。 */
export function registerTopApprovalRoute(sessionPath: string, ui: ApprovalUi): () => void {
  return register(sessionPath, { kind: "top", ui });
}

/** 子会话登记自己：请求转给父会话路径，经过时把这个子代理加进 chain。 */
export function registerChildApprovalRoute(input: {
  sessionPath: string;
  parentSessionPath: string | undefined;
  agentId: string;
  label: string;
}): () => void {
  return register(input.sessionPath, {
    kind: "child",
    parentSessionPath: input.parentSessionPath,
    asker: { agentId: input.agentId, label: input.label },
  });
}

/** worker 进程里：本进程查不到的会话路径交给宿主。 */
export function setApprovalUpstream(next: ApprovalUpstream | undefined): void {
  upstream = next;
}

/** 0 表示不转发（子代理审批由主进程固定拒绝）。非法值按默认。 */
export function subagentApprovalTimeoutMs(): number {
  const raw = getConfig("SUBAGENT_APPROVAL_TIMEOUT_MS")?.trim();
  if (!raw) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_APPROVAL_TIMEOUT_MS;
}

/**
 * 从这个会话路径往上能不能走到一个能问人的地方。本进程查不到的（worker 里的父会话在宿主）问 upstream：
 * 宿主那边父会话可能没有界面、已经关掉，或者设置成了 0，不能一概当成能问。
 * 本进程就能答的同步返回（宿主进程里总是这样），只有要问宿主时才是 Promise。
 */
function reachable(sessionPath: string | undefined): boolean | Promise<boolean> {
  const seen = new Set<string>();
  let path = sessionPath;
  while (path && !seen.has(path)) {
    seen.add(path);
    const route = routes.get(path);
    if (!route) return upstream ? upstream.reachable(path).catch(() => false) : false;
    if (route.kind === "top") return true;
    path = route.parentSessionPath;
  }
  return false;
}

/** 这个子会话现在能不能把审批交给人：没关掉，且往上走得到顶层会话。 */
export async function canRequestApproval(childSessionPath: string | undefined): Promise<boolean> {
  if (!childSessionPath || subagentApprovalTimeoutMs() <= 0) return false;
  const route = routes.get(childSessionPath);
  return route?.kind === "child" && reachable(route.parentSessionPath);
}

/**
 * 派子代理时：父会话（调用者）能不能替子代理问人。决定子代理的委派声明用哪一版；宿主回答 worker 的询问也用它。
 * 宿主进程里同步返回，派子代理不因此多等一拍。
 */
export function canForwardApproval(parentSessionPath: string | undefined): boolean | Promise<boolean> {
  return subagentApprovalTimeoutMs() > 0 && reachable(parentSessionPath);
}

function chainText(chain: ApprovalAsker[]): string {
  const names = [...chain].reverse().map((a) => {
    const label = a.label.length > LABEL_MAX ? `${a.label.slice(0, LABEL_MAX)}…` : a.label;
    return label ? `${label}（${a.agentId}）` : a.agentId;
  });
  return names.length ? `子代理 ${names.join(" › ")} ` : "";
}

async function askTop(ui: ApprovalUi, request: ApprovalRequest): Promise<ApprovalOutcome> {
  if (request.signal?.aborted) return { outcome: "cancelled" };
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  // 界面不理 signal 时（例如别的宿主的实现）也不能一直等：到点或撤回就不再等它的回答。
  const given = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  try {
    const opts = {
      signal: controller.signal,
      timeout: request.timeoutMs,
      // 渲染层据此标出是哪个子代理、父会话这一轮结束时不丢这条请求。顶层在前。
      subagents: [...request.chain].reverse(),
    };
    const choice = await Promise.race([ui.select(`${chainText(request.chain)}${request.title}`, request.options, opts), given]);
    if (typeof choice === "string") return { outcome: "answered", choice };
    // 界面自己的计时器可能先到：按已经过去的时间判超时。
    if (timedOut || Date.now() - started >= request.timeoutMs) return { outcome: "timeout" };
    return { outcome: "cancelled" };
  } catch {
    return { outcome: "cancelled" };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

/** 把请求交给 sessionPath 那个会话：顶层就问人，子会话就继续往上转。宿主处理 worker 的转发也用它。 */
export async function forwardApproval(sessionPath: string | undefined, request: ApprovalRequest): Promise<ApprovalOutcome> {
  // 发出之前就被撤回（子代理在判定期间被打断）：不再弹卡片。
  if (request.signal?.aborted) return { outcome: "cancelled" };
  const seen = new Set<string>();
  let path = sessionPath;
  let current = request;
  while (path && !seen.has(path)) {
    seen.add(path);
    const route = routes.get(path);
    if (!route) return upstream ? upstream.ask(path, current) : UNAVAILABLE;
    if (route.kind === "top") return askTop(route.ui, current);
    current = { ...current, chain: [...current.chain, route.asker] };
    path = route.parentSessionPath;
  }
  return UNAVAILABLE;
}

/** 子会话里需要人批准时调用：带上自己的身份，最多等 SUBAGENT_APPROVAL_TIMEOUT_MS。 */
export async function requestApproval(
  childSessionPath: string | undefined,
  input: { title: string; options: string[]; signal?: AbortSignal },
): Promise<ApprovalOutcome> {
  const timeoutMs = subagentApprovalTimeoutMs();
  if (!childSessionPath || timeoutMs <= 0) return UNAVAILABLE;
  const route = routes.get(childSessionPath);
  if (route?.kind !== "child") return UNAVAILABLE;
  return forwardApproval(route.parentSessionPath, {
    title: input.title,
    options: input.options,
    chain: [route.asker],
    timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export function __resetApprovalRoutesForTest(): void {
  routes.clear();
  upstream = undefined;
}
