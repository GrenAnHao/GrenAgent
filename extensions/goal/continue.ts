import type { AgentSettledEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearGoalTurnMarks, occupyGoalRound, occupiedGoalRound, releaseGoalRound, revokeGoalRound } from "./auth.js";
import { getCompactionActivity, getCompactionContextRevision, subscribeCompactionActivity } from "../_shared/compaction-activity.js";
import { buildGoalRoundPrompt } from "./prompt.js";
import {
  getActivation,
  nextRevision,
  pushStatus,
  readSnapshot,
  setActivation,
  sessionIdOf,
  writeEvent,
} from "./session.js";
import type { GoalPauseReason, GoalSnapshot } from "./types.js";
import { clearGoalOwnerUnavailable, getGoalOwnerStoppedAt, setGoalOwnerUnavailable } from "./status.js";

type Stop = { stopReason?: string };
type FinalOutcome = "success" | "request-error" | "user" | "runtime-error";
const runStops = new Map<string, Stop[]>();
const runOwners = new Map<string, string | null>();
const endedRuns = new Map<string, { roundId: string | null; stops: Stop[] }>();

/** SDK run start is the ownership boundary; never infer an old settlement from current pending. */
export function recordGoalRunStart(sessionId: string): void {
  runOwners.set(sessionId, occupiedGoalRound(sessionId)?.roundId ?? null);
}

/** A goal created by a human-authorized model tool begins with its own captured condition. */
export function enrollCreatedGoalInRun(sessionId: string, snapshot: GoalSnapshot): void {
  if (!runOwners.has(sessionId) || runOwners.get(sessionId) !== null) return;
  const ref = occupyGoalRound(sessionId, {
    goalId: snapshot.goalId, runNumber: snapshot.runNumber,
    conditionRevision: snapshot.conditionRevision, round: snapshot.roundsStarted,
  });
  if (ref) runOwners.set(sessionId, ref.roundId);
}
const unavailable = new Map<string, string>();
interface PendingGoalPause {
  goalId: string;
  kind: GoalPauseReason["code"];
  /** The status owner's stop instant, never the later repair time. */
  stoppedAt: string;
  /** Kept so a repaired crash pause is still provable after a later reopen. */
  confirmedLoss?: { ownerEpoch: string; roundId: string; sequence: number };
}
const pendingPauses = new Map<string, PendingGoalPause>();
// Provider/runtime diagnostics can contain URLs, credentials or raw responses.
// Persist only fixed explanations; keep diagnostic text out of Goal JSONL.
const GOAL_PAUSE_SUMMARIES: Record<GoalPauseReason["code"], string> = {
  "request-error": "最终请求失败，请检查连接或供应商设置。",
  "runtime-error": "运行器未能完成本轮，请检查会话状态。",
  user: "用户已停止本轮。",
  "max-rounds": "已达到本批次轮次上限。",
};
const compactionWaiters = new Map<string, () => void>();
const compactionFailures = new Map<string, string>();
export function recordGoalCompactionFailure(sessionId: string, message: string): void {
  compactionFailures.set(sessionId, message);
}

function finalOutcome(stops: Stop[], aborted: boolean): FinalOutcome {
  if (aborted) return "user";
  // agent_end may fire for temporary errors followed by SDK retry/compaction.
  const last = stops.at(-1)?.stopReason;
  if (last === "error") return "request-error";
  if (last === "aborted") return "user";
  return last ? "success" : "runtime-error";
}

export function decideGoalContinuation(input: {
  snapshot: GoalSnapshot | undefined;
  activation: "armed" | "disarmed";
  assistantStops: Stop[];
  alreadyNotifiedMaxRounds?: boolean;
}): { action: "none" | "reenter" | "max-rounds"; nextRound?: number } {
  const { snapshot, activation, assistantStops } = input;
  if (!snapshot || snapshot.status !== "active" || activation !== "armed") {
    return { action: "none" };
  }
  if (assistantStops.at(-1)?.stopReason === "aborted" || assistantStops.at(-1)?.stopReason === "error") {
    return { action: "none" };
  }
  if (snapshot.runRoundsStarted >= snapshot.maxRounds) return { action: "max-rounds" };
  return { action: "reenter", nextRound: snapshot.roundsStarted + 1 };
}

export function recordRunStopReasons(sessionId: string, messages: unknown): void {
  const list = Array.isArray(messages) ? messages : [];
  const stops: Stop[] = [];
  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const rec = message as { role?: unknown; stopReason?: unknown };
    if (rec.role !== "assistant") continue;
    stops.push({
      stopReason: typeof rec.stopReason === "string" ? rec.stopReason : undefined,
    });
  }
  const all = [...(runStops.get(sessionId) ?? []), ...stops];
  runStops.set(sessionId, all);
  endedRuns.set(sessionId, { roundId: runOwners.get(sessionId) ?? null, stops: all });
}

export function takeRunStopReasons(sessionId: string): Stop[] {
  const stops = runStops.get(sessionId) ?? [];
  runStops.delete(sessionId);
  return stops;
}

export function __resetGoalContinueForTest(): void {
  runStops.clear();
  runOwners.clear();
  endedRuns.clear();
  unavailable.clear();
  pendingPauses.clear();
  compactionFailures.clear();
  for (const unsubscribe of compactionWaiters.values()) unsubscribe();
  compactionWaiters.clear();
}

export function goalRunUnavailable(sessionId: string): string | undefined { return unavailable.get(sessionId); }

export function hasPendingGoalPause(sessionId: string): boolean { return pendingPauses.has(sessionId); }

/** A trusted control commit is the only caller allowed to lift the pause latch. */
export function clearGoalRunUnavailable(sessionId: string): void {
  unavailable.delete(sessionId);
  pendingPauses.delete(sessionId);
  clearGoalOwnerUnavailable(sessionId);
}

/**
 * A trusted resume repairs a failure pause whose append previously failed. The
 * pause keeps the original failure kind and the status owner's stop instant, so
 * the wait before the human resume is not counted as run time. If the pause
 * already reached disk (or the Goal ended another way) nothing is appended
 * twice. Failure keeps the caller unavailable.
 */
export function commitPendingGoalPause(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  const sessionId = sessionIdOf(ctx);
  const pending = pendingPauses.get(sessionId);
  if (!pending) return true;
  const snapshot = readSnapshot(ctx);
  if (!snapshot || snapshot.goalId !== pending.goalId || snapshot.status !== "active") {
    // Never pause a newer Goal; a non-active Goal already has its durable stop.
    pendingPauses.delete(sessionId);
    return true;
  }
  const reason: GoalPauseReason = { code: pending.kind, message: GOAL_PAUSE_SUMMARIES[pending.kind] };
  try {
    const written = writeEvent(pi, ctx, {
      kind: "pause", goalId: snapshot.goalId, revision: nextRevision(snapshot),
      at: pending.stoppedAt, payload: { pauseReason: reason,
        ...(pending.confirmedLoss ? { confirmedLoss: pending.confirmedLoss } : {}) },
    });
    if (!written || written.status !== "paused" || written.revision !== nextRevision(snapshot) ||
      written.pauseReason?.code !== pending.kind) throw new Error("GOAL_WRITE_FAILED");
    pendingPauses.delete(sessionId);
    return true;
  } catch {
    return false;
  }
}

export function clearGoalRunState(sessionId: string): void {
  runStops.delete(sessionId);
  runOwners.delete(sessionId);
  endedRuns.delete(sessionId);
  unavailable.delete(sessionId);
  pendingPauses.delete(sessionId);
  clearGoalOwnerUnavailable(sessionId);
  compactionFailures.delete(sessionId);
  compactionWaiters.get(sessionId)?.();
  compactionWaiters.delete(sessionId);
  const occupied = occupiedGoalRound(sessionId);
  if (occupied) releaseGoalRound(sessionId, occupied.roundId);
  clearGoalTurnMarks(sessionId);
}

export interface GoalFailureReport {
  kind: GoalPauseReason["code"];
  message?: string;
  /** Host capture, when available. Never let old work pause a newer runner. */
  roundId?: string;
  goalId?: string;
  runNumber?: number;
  conditionRevision?: number;
  /** The original process-loss fence, recorded with the actual new-owner pause. */
  confirmedLoss?: { ownerEpoch: string; roundId: string; sequence: number };
}
export interface GoalFailureResult { persisted: boolean; snapshot?: GoalSnapshot; error?: string; skipped?: boolean }

/** Shared terminal closure for SDK settlement and host preparation/post-run catches. */
export function reportGoalRunFailure(
  pi: ExtensionAPI, ctx: ExtensionContext, failure: GoalFailureReport,
): GoalFailureResult {
  const sessionId = sessionIdOf(ctx);
  const snapshot = readSnapshot(ctx);
  if (!snapshot || snapshot.status !== "active") return { persisted: true, snapshot, skipped: true };
  const occupied = occupiedGoalRound(sessionId);
  if (failure.roundId && occupied?.roundId !== failure.roundId) return { persisted: true, snapshot, skipped: true };
  if (failure.goalId && failure.goalId !== snapshot.goalId) return { persisted: true, snapshot, skipped: true };
  if (failure.runNumber !== undefined && failure.runNumber !== snapshot.runNumber) return { persisted: true, snapshot, skipped: true };
  if (failure.conditionRevision !== undefined && failure.conditionRevision !== snapshot.conditionRevision) return { persisted: true, snapshot, skipped: true };
  if (!failure.roundId && occupied && failure.goalId) return { persisted: true, snapshot, skipped: true }; // Never borrow a newly issued runner.
  revokeGoalRound(sessionId);
  // Disarm *before* writing. A failed append must not leave a runnable Goal.
  setActivation(sessionId, "disarmed");
  const reason: GoalPauseReason = { code: failure.kind, message: GOAL_PAUSE_SUMMARIES[failure.kind] };
  try {
    const written = writeEvent(pi, ctx, {
      kind: "pause", goalId: snapshot.goalId, revision: nextRevision(snapshot),
      at: new Date().toISOString(), payload: { pauseReason: reason,
        ...(failure.confirmedLoss ? { confirmedLoss: failure.confirmedLoss } : {}) },
    });
    if (!written || written.status !== "paused" || written.revision !== nextRevision(snapshot)) throw new Error("GOAL_WRITE_FAILED");
    unavailable.delete(sessionId);
    pendingPauses.delete(sessionId);
    clearGoalOwnerUnavailable(sessionId);
    pushStatus(ctx);
    return { persisted: true, snapshot: written };
  } catch {
    unavailable.set(sessionId, "GOAL_PAUSE_NOT_PERSISTED");
    setGoalOwnerUnavailable(sessionId, "GOAL_PAUSE_NOT_PERSISTED");
    // Keep the original kind and the stop instant for the trusted repair.
    pendingPauses.set(sessionId, { goalId: snapshot.goalId, kind: failure.kind,
      stoppedAt: getGoalOwnerStoppedAt(sessionId) ?? new Date().toISOString(),
      ...(failure.confirmedLoss ? { confirmedLoss: failure.confirmedLoss } : {}) });
    try { pushStatus(ctx); } catch { /* surface the failure in the return value */ }
    ctx.ui.notify("Goal 已停止，但暂停记录未保存；请重新读取会话。", "error");
    return { persisted: false, snapshot, error: "GOAL_PAUSE_NOT_PERSISTED" };
  }
}

export function pauseAtGoalLimit(pi: ExtensionAPI, ctx: ExtensionContext): GoalFailureResult {
  const result = reportGoalRunFailure(pi, ctx, { kind: "max-rounds" });
  if (result.persisted && result.snapshot?.pauseReason?.code === "max-rounds") ctx.ui.notify("已达轮次上限", "warning");
  return result;
}

export async function onAgentSettled(
  _event: AgentSettledEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  const sessionId = sessionIdOf(ctx);
  const ended = endedRuns.get(sessionId);
  if (!ended) return; // Duplicate or stale settled: no run-end evidence to consume.
  endedRuns.delete(sessionId);
  runOwners.delete(sessionId);
  const assistantStops = takeRunStopReasons(sessionId);
  const occupied = occupiedGoalRound(sessionId);
  if (ended.roundId !== null && occupied?.roundId !== ended.roundId) return;
  const settledId = ended.roundId ?? undefined;
  const snapshot = readSnapshot(ctx);
  const staleRunner = !!occupied && settledId !== undefined && (!snapshot || snapshot.goalId !== occupied.goalId ||
    snapshot.runNumber !== occupied.runNumber || snapshot.conditionRevision !== occupied.conditionRevision);
  clearGoalTurnMarks(sessionId, settledId);
  if (staleRunner) {
    if (getActivation(sessionId) === "armed") await startArmedGoalRound(pi, ctx);
    return;
  }
  // The running prompt predates a Goal created mid-turn; its settlement
  // cannot release the newly queued Goal runner or count as its response.
  if (ended.roundId === null && occupied) return;
  const activeCompaction = getCompactionActivity(sessionId);
  if (activeCompaction) {
    if (!compactionWaiters.has(sessionId)) {
      const operationId = activeCompaction.operationId;
      const previousContextRevision = getCompactionContextRevision(sessionId);
      const unsubscribe = subscribeCompactionActivity(sessionId, (activity) => {
        if (activity?.operationId === operationId) return;
        unsubscribe();
        compactionWaiters.delete(sessionId);
        // The compaction retry is itself part of the old run; only a confirmed
        // final SDK settlement may launch a new one. Do not guess from an abort.
        if (!activity && !getCompactionActivity(sessionId) && !occupiedGoalRound(sessionId)) {
          const failed = compactionFailures.get(sessionId);
          compactionFailures.delete(sessionId);
          if (failed) reportGoalRunFailure(pi, ctx, { kind: "request-error", message: failed });
          else if (getCompactionContextRevision(sessionId) > previousContextRevision
            && (finalOutcome(assistantStops, _event.aborted) === "success"
              || activeCompaction.origin === "policy-auto" || activeCompaction.origin === "sdk-threshold"
              || activeCompaction.origin === "sdk-overflow")) {
            void startArmedGoalRound(pi, ctx);
          }
          // Only a committed compaction advances contextRevision; an abort alone
          // never proves recovery. A real SDK retry may also settle afterward.
        }
      });
      compactionWaiters.set(sessionId, unsubscribe);
    }
    return;
  }
  if (getActivation(sessionId) !== "armed" || unavailable.has(sessionId)) return;
  const current = readSnapshot(ctx);
  if (!current || current.status !== "active") return;
  const compactionFailure = compactionFailures.get(sessionId);
  compactionFailures.delete(sessionId);
  const outcome = compactionFailure ? "request-error" : finalOutcome(assistantStops, _event.aborted);
  if (outcome !== "success") {
    reportGoalRunFailure(pi, ctx, { kind: outcome, message: compactionFailure });
    return;
  }
  await startArmedGoalRound(pi, ctx);
}

export async function startArmedGoalRound(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const snapshot = readSnapshot(ctx);
  const sessionId = sessionIdOf(ctx);
  const activation = getActivation(sessionId);
  if (unavailable.has(sessionId) || occupiedGoalRound(sessionId) || getCompactionActivity(sessionId)) return;
  const decision = decideGoalContinuation({ snapshot, activation, assistantStops: [] });
  if (decision.action === "max-rounds" && snapshot) {
    pauseAtGoalLimit(pi, ctx);
    return;
  }
  if (decision.action === "reenter" && snapshot) {
    await reenterGoalRound(pi, ctx, snapshot);
  }
}

export async function reenterGoalRound(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: GoalSnapshot,
): Promise<void> {
  const sessionId = sessionIdOf(ctx);
  if (unavailable.has(sessionId) || occupiedGoalRound(sessionId) || getCompactionActivity(sessionId)) return;
  const current = readSnapshot(ctx);
  if (!current || current.goalId !== snapshot.goalId || current.revision !== snapshot.revision ||
    current.status !== "active" || getActivation(sessionId) !== "armed") return;
  if (current.runRoundsStarted >= current.maxRounds) { pauseAtGoalLimit(pi, ctx); return; }
  const folded = writeEvent(pi, ctx, {
    kind: "round", goalId: current.goalId, revision: nextRevision(current),
    at: new Date().toISOString(),
    payload: { round: current.roundsStarted + 1, runNumber: current.runNumber, runRound: current.runRoundsStarted + 1 },
  });
  if (!folded || folded.revision !== nextRevision(current)) return;
  const ref = occupyGoalRound(sessionId, {
    goalId: folded.goalId, runNumber: folded.runNumber,
    conditionRevision: folded.conditionRevision, round: folded.roundsStarted,
  });
  if (!ref) return;

  await pi.sendMessage(
    {
      customType: "goal-round",
      content: buildGoalRoundPrompt({
        condition: folded.condition,
        round: folded.roundsStarted,
        maxRounds: folded.maxRounds,
      }),
      display: false,
      details: {
        goalId: folded.goalId,
        revision: folded.revision,
        round: folded.roundsStarted,
        runNumber: folded.runNumber,
        runRound: folded.runRoundsStarted,
      },
    },
    { triggerTurn: true },
  );
  pushStatus(ctx);
}
