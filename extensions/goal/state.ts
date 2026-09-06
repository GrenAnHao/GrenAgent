import type { GoalSnapshot, GoalStatus } from "./contracts.js";
export type { GoalSnapshot, GoalStatus } from "./contracts.js";

export interface GoalState {
  condition: string;
  react: number;
  /** 暂停中：agent_end 时不裁判、不重入，目标挂起直到 resume。 */
  paused: boolean;
}

export const DEFAULT_MAX_ROUNDS = 256;

export type GoalTransition =
  | { type: "pause"; reason?: string; revision?: number }
  | { type: "resume"; revision?: number }
  | { type: "judge_pass"; revision: number }
  | { type: "judge_fail"; revision: number };

const statuses = new Set<GoalStatus>(["active", "paused", "disarmed", "judging", "blocked", "complete", "error", "cleared"]);

function stateError(code: string): Error {
  return new Error(code);
}

export function assertRevision(expected: Pick<GoalSnapshot, "goalId" | "revision">, actual: Pick<GoalSnapshot, "goalId" | "revision">): void {
  if (expected.goalId !== actual.goalId || expected.revision !== actual.revision) throw stateError("VERSION_CONFLICT");
}

export function validateMaxRounds(value: number | undefined): number {
  const maxRounds = value ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isSafeInteger(maxRounds) || maxRounds <= 0) throw stateError("INVALID_MAX_ROUNDS");
  return maxRounds;
}

export function transition(snapshot: GoalSnapshot, event: GoalTransition): GoalSnapshot {
  if (!statuses.has(snapshot.status)) throw stateError("INVALID_STATE");
  validateMaxRounds(snapshot.maxRounds);
  if (event.revision !== undefined && event.revision !== snapshot.revision) throw stateError("VERSION_CONFLICT");
  let status: GoalStatus;
  if (snapshot.status === "active" && event.type === "pause") status = "paused";
  else if (snapshot.status === "paused" && event.type === "resume") status = "active";
  else if (snapshot.status === "judging" && event.type === "judge_pass") status = "complete";
  else if (snapshot.status === "judging" && event.type === "judge_fail") status = "paused";
  else throw stateError("INVALID_TRANSITION");
  return {
    ...snapshot,
    status,
    revision: snapshot.revision + 1,
    updatedAt: new Date().toISOString(),
    blockage: status === "active" && snapshot.status === "paused" && snapshot.blockage
      ? { ...snapshot.blockage, consecutiveRounds: 0 }
      : snapshot.blockage,
  };
}

interface CustomEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

/**
 * Restore goal state from session entries: take the LAST custom entry with
 * customType "goal". A null/empty data (written on /goal clear) yields undefined.
 */
export function restoreFromEntries(entries: CustomEntryLike[]): GoalState | undefined {
  const entry = entries.filter((e) => e.type === "custom" && e.customType === "goal").pop();
  const data = entry?.data as Partial<GoalState> | null | undefined;
  if (data && typeof data.condition === "string" && data.condition.length > 0) {
    return { condition: data.condition, react: Number(data.react) || 0, paused: data.paused === true };
  }
  return undefined;
}
