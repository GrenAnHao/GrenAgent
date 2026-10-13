// 漏网错误（不被 await 的异步工作抛出、落到进程级 uncaughtException / unhandledRejection 的错误）归到具体子代理。
// 子代理每一轮开始的地方进入 runAsChild：这一轮里派生出的定时器、回调、promise 都带着它（AsyncLocalStorage，
// 进程级处理器里也读得到）。agent-host 的全局处理器据此找到子代理，交给它登记的处理器，按 error 结算
// （重新设计第 3 节建议 2）。worker 进程只托管一个子会话，它的漏网错误经 RPC 转过来，直接带上子代理 id。
// 不复用 WorkspaceContext：那份管配置；这里在子代理去唤起别的会话（结算通知、send_message）时要离开子代理，时机不一样。
// 进程级共享的资源（MCP 连接等）要在 outsideChild 里建，否则它以后的回调都带着第一个碰到它的子代理。

import { AsyncLocalStorage } from "node:async_hooks";

const owner = new AsyncLocalStorage<string>();
const handlers = new Map<string, (error: unknown) => void>();

/** unhandledRejection 之后等多久还没被接住，才当漏网错误。 */
export const LATE_HANDLE_GRACE_MS = 1000;
const pendingRejections = new Map<Promise<unknown>, ReturnType<typeof setTimeout>>();

/**
 * unhandledRejection 不马上当错误：常见写法是先起一个 promise、等别的、再 await 它，这期间 Node 已经报过
 * unhandledRejection，随后接住时又报 rejectionHandled。等 graceMs，期间被接住（rejectionWasHandled）就不算。
 * 归属在报出来的那一刻取（处理器里读得到出错那一刻的身份）。
 */
export function trackUnhandledRejection(
  reason: unknown,
  promise: Promise<unknown>,
  report: (reason: unknown, childId: string | undefined) => void,
  graceMs: number = LATE_HANDLE_GRACE_MS,
): void {
  const childId = currentChild();
  const timer = setTimeout(() => {
    pendingRejections.delete(promise);
    report(reason, childId);
  }, graceMs);
  timer.unref?.();
  pendingRejections.set(promise, timer);
}

/** 进程的 rejectionHandled：迟一点被接住的，撤销。 */
export function rejectionWasHandled(promise: Promise<unknown>): void {
  const timer = pendingRejections.get(promise);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingRejections.delete(promise);
}

/** 以这个子代理的身份跑 fn：它派生出的异步工作里漏出来的错误都算这个子代理的。 */
export function runAsChild<T>(childId: string, fn: () => T): T {
  return owner.run(childId, fn);
}

/** 离开子代理的身份跑 fn：子代理去唤起别的会话时用，那个会话这一轮的错误不算它的。 */
export function outsideChild<T>(fn: () => T): T {
  return owner.exit(fn);
}

export function currentChild(): string | undefined {
  return owner.getStore();
}

/** 子代理在跑时登记处理器；返回的函数只撤掉这一次登记。 */
export function onLeakedError(childId: string, handler: (error: unknown) => void): () => void {
  handlers.set(childId, handler);
  return () => {
    if (handlers.get(childId) === handler) handlers.delete(childId);
  };
}

export interface LeakAttribution {
  childId: string;
  /** 子代理正在跑，错误交给了它（会按 error 结算）。false：它已经结算、停在驻留池里，只记日志。 */
  handled: boolean;
}

/**
 * 进程级处理器调用：归到 childId（缺省取当前身份），交给它登记的处理器。
 * 没有归属（主会话、不在任何子代理里）返回 undefined，调用方照旧只记日志。
 */
export function reportLeakedError(error: unknown, childId: string | undefined = currentChild()): LeakAttribution | undefined {
  if (!childId) return undefined;
  const handler = handlers.get(childId);
  if (!handler) return { childId, handled: false };
  try {
    handler(error);
  } catch (handlerError) {
    // 处理器自己出错不能再变成漏网错误。
    console.error(`[multi-agent] sub-agent ${childId}: leaked-error handler failed`, handlerError);
  }
  return { childId, handled: true };
}

/** 写进结算诊断的那一行。 */
export function leakedErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `uncaught error: ${message}`;
}

export function __resetLeakOwnerForTest(): void {
  handlers.clear();
  for (const timer of pendingRejections.values()) clearTimeout(timer);
  pendingRejections.clear();
}
