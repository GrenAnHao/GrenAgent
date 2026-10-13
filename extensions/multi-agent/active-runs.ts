// 正在跑的子代理（任何后端、前台或后台）：同时活跃上限 + 诊断用的清单（重新设计第 6 节，照 DSH maxActiveSubagents）。
// 超过上限就排队，不拒绝。只有顶层会话派的子代理（深度 1）排队：嵌套的子代理如果也排队，8 个子代理各等一个孙代理的名额
// 就会互相卡死，所以更深的只登记、不等。冷恢复续聊（send_message）不经过这里。

import { getConfig } from "../_shared/runtime-config.js";

export const DEFAULT_MAX_ACTIVE = 8;

export interface ActiveRun {
  childId: string;
  backend: string;
  depth: number;
  startedAt: number;
}

const active = new Map<string, ActiveRun>();
const waiters: Array<() => void> = [];

export function maxActiveSubagents(): number {
  const n = Number(getConfig("SUBAGENT_MAX_ACTIVE") ?? "");
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_ACTIVE;
}

function wakeOne(): void {
  waiters.shift()?.();
}

/** 等到有名额再登记；返回的函数释放名额（可重复调用）。启动前被取消的直接抛错。 */
export async function acquireActiveSlot(
  run: { childId: string; backend: string; depth?: number },
  signal?: AbortSignal,
): Promise<() => void> {
  const depth = run.depth ?? 1;
  if (depth <= 1) {
    while (queuedCount() >= maxActiveSubagents()) {
      if (signal?.aborted) throw new Error("sub-agent was cancelled while waiting for an active slot");
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (signal?.aborted) throw new Error("sub-agent was cancelled while waiting for an active slot");
  }
  const entry: ActiveRun = { childId: run.childId, backend: run.backend, depth, startedAt: Date.now() };
  active.set(run.childId, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (active.get(run.childId) === entry) active.delete(run.childId);
    if (depth <= 1) wakeOne();
  };
}

/** 计入上限的（顶层会话派的）子代理数。 */
function queuedCount(): number {
  let n = 0;
  for (const run of active.values()) if (run.depth <= 1) n += 1;
  return n;
}

export function activeRuns(): ActiveRun[] {
  return [...active.values()];
}

export function __resetActiveRunsForTest(): void {
  active.clear();
  waiters.length = 0;
}
