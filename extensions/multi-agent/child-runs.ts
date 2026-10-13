// 在后台跑着的子代理（按直接父会话 id 归组）。进程内可续聊的 Activation 和 worker 后台运行都在这里登记，
// wait_agent 在这里等结算，Activation 在这里查自己还有没有活着的子代理（结算要等它们先结束）。
// 只在进程内，agent-host 重启即清空（重启后的子代理按需冷恢复，见重新设计笔记第 3 节）。

import type { SubagentStopReason } from "./assistant-output.js";

export interface ChildSettlement {
  childId: string;
  parentSessionId: string;
  stopReason: SubagentStopReason;
}

/** settled 缺省表示子代理没有结算就离开了（回滚、删除时被静默），不发通知，wait_agent 也不算它。 */
export interface ChildRunEvent {
  childId: string;
  parentSessionId: string;
  settled?: ChildSettlement;
}

const running = new Map<string, string>();
const listeners = new Set<(event: ChildRunEvent) => void>();

function emit(event: ChildRunEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      /* 一个监听方出错不影响别的 */
    }
  }
}

export function markChildRunning(childId: string, parentSessionId: string): void {
  running.set(childId, parentSessionId);
}

export function markChildSettled(settlement: ChildSettlement): void {
  running.delete(settlement.childId);
  emit({ childId: settlement.childId, parentSessionId: settlement.parentSessionId, settled: settlement });
}

export function markChildGone(childId: string): void {
  const parentSessionId = running.get(childId);
  if (parentSessionId === undefined) return;
  running.delete(childId);
  emit({ childId, parentSessionId });
}

export function runningChildrenOf(parentSessionId: string): string[] {
  const out: string[] = [];
  for (const [childId, parent] of running) if (parent === parentSessionId) out.push(childId);
  return out;
}

export function hasRunningChildren(parentSessionId: string): boolean {
  for (const parent of running.values()) if (parent === parentSessionId) return true;
  return false;
}

const silenced = new Set<string>();

/** 父会话要被删除：这个子代理结束时不发通知（替代原来 one-shot job 的 jobs.markReported）。 */
export function silenceChild(childId: string): void {
  if (running.has(childId)) silenced.add(childId);
}

/** 结算时取出静默标记；取过即清。 */
export function takeSilenced(childId: string): boolean {
  return silenced.delete(childId);
}

export function onChildRunEvent(listener: (event: ChildRunEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetChildRunsForTest(): void {
  running.clear();
  silenced.clear();
}
