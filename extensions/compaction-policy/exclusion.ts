// 用户驱动的上下文排除：把任意消息移出「喂给 LLM 的上下文」（不删盘）。
// 按消息 timestamp 排除——AgentMessage 无稳定 id 但有 timestamp，桌面从会话条目即可拿到，
// 避免 entry-id 与 context 消息的脆弱关联。

export interface ExclusionOp {
  op: "add" | "remove";
  /** 被排除消息的 timestamp（毫秒）。 */
  ts: number;
}

export interface ContextExclusionPulse extends ExclusionOp {
  rev: number;
}

export function contextExclusionConfigKey(workspace: string): string {
  return `CONTEXT_EXCLUSION_OP:${workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}`;
}

export function parseContextExclusionPulse(raw: string | undefined): ContextExclusionPulse | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as { op?: unknown; ts?: unknown; rev?: unknown };
    if (parsed.op !== "add" && parsed.op !== "remove") return undefined;
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) return undefined;
    if (typeof parsed.rev !== "number" || !Number.isFinite(parsed.rev)) return undefined;
    return { op: parsed.op, ts: parsed.ts, rev: parsed.rev };
  } catch {
    return undefined;
  }
}

export function shouldApplyContextExclusionPulse(
  pulse: ContextExclusionPulse,
  lastRev: number,
  excluded: Set<number>,
): { apply: boolean; nextRev: number } {
  if (pulse.rev <= lastRev) return { apply: false, nextRev: lastRev };
  const alreadyApplied = pulse.op === "add" ? excluded.has(pulse.ts) : !excluded.has(pulse.ts);
  return { apply: !alreadyApplied, nextRev: pulse.rev };
}

export function buildExclusionSet(ops: ExclusionOp[]): Set<number> {
  const set = new Set<number>();
  for (const o of ops) {
    if (o.op === "add") set.add(o.ts);
    else set.delete(o.ts);
  }
  return set;
}

/** 过滤掉 timestamp 命中排除集的消息；无 timestamp 的消息一律保留。空集时原样返回（不拷贝）。 */
export function filterExcludedByTs<T extends { timestamp?: number }>(messages: T[], excluded: Set<number>): T[] {
  if (excluded.size === 0) return messages;
  return messages.filter((m) => typeof m.timestamp !== "number" || !excluded.has(m.timestamp));
}
