import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { foldGoal, readGoalEvent } from './fold.js';
import { projectCwd } from '../_shared/session-cwd.js';
import { buildGoalStatus, getActivation, getGoalOwnerEpoch } from './status.js';
import { clearGoal, createGoal, editGoal, pauseGoal, pushStatus, readSnapshot, restartGoalForControl, resumeGoal, sessionIdOf } from './session.js';
import { occupiedGoalRound, releaseGoalRound, subscribeGoalWorkslot, type GoalRoundRef } from './auth.js';
import { goalOwnerLossPort } from './owner-loss.js';
import type { ConfirmedGoalOwnerLoss, GoalWorkslotNotice } from '../../electron-agent/electron/agentProcess/contract.js';
import { clearGoalRunUnavailable, commitPendingGoalPause, hasPendingGoalPause, reportGoalRunFailure, startArmedGoalRound } from './continue.js';
import { parseGoalControlRequest, type GoalControlAction, type GoalControlReceipt, type GoalControlRequest } from './control-contract.js';
export type { GoalControlRequest, GoalControlReceipt } from './control-contract.js';

type Failure = Parameters<typeof reportGoalRunFailure>[2];
type RunGoalRound = (start: () => Promise<void>) => Promise<void>;
interface OwnerControl {
  epoch: string;
  execute: (request: GoalControlRequest, runRound?: RunGoalRound) => Promise<GoalControlReceipt>;
  fail: (failure: Failure) => ReturnType<typeof reportGoalRunFailure>;
  captureRoundId: () => string | undefined;
  captureFailureFence: () => GoalOwnerFailureFence | undefined;
}
export interface GoalOwnerFailureFence {
  ownerEpoch: string;
  goalId: string;
  runNumber: number;
  conditionRevision: number;
  roundId?: string;
}
const CONTROL_KEY = Symbol.for('gren.goal.owner-controls');
function controls(): Map<string, OwnerControl> {
  const root = globalThis as unknown as Record<symbol, Map<string, OwnerControl> | undefined>;
  return root[CONTROL_KEY] ??= new Map();
}

interface HalfCommit {
  fingerprint: string;
  goalId: string;
  /** Paused revision produced by the repair inside this operation. */
  revisionAfterRepair: number;
}
const halfCommits = new Map<string, Map<string, HalfCommit>>();

export function __resetGoalControlsForTest(): void { controls().clear(); halfCommits.clear(); }

/** Register only from the trusted live extension lifecycle, never from tool input. */
export function registerGoalControl(pi: ExtensionAPI, ctx: ExtensionContext): () => void {
  const sessionId = sessionIdOf(ctx);
  const epoch = getGoalOwnerEpoch(sessionId);
  if (!epoch) throw new Error('GOAL_OWNER_UNAVAILABLE');
  let tail: Promise<unknown> = Promise.resolve();
  const owner: OwnerControl = {
    epoch,
    execute: (request, runRound) => {
      const result = tail.then(() => {
        if (controls().get(sessionId) !== owner || getGoalOwnerEpoch(sessionId) !== epoch) return unavailableGoalControl(sessionId, request);
        return applyControl(pi, ctx, request, epoch);
      });
      tail = result.catch(() => undefined);
      void result.then(async (receipt) => {
        if (receipt.outcome === 'committed' && !receipt.replayed && (request.action === 'resume' || request.action === 'create')) {
          // Dispatch belongs to this owner, not the renderer or the foreground
          // session at the time an acknowledgement arrives.
          const stillOwnsGoal = () => controls().get(sessionId) === owner && getGoalOwnerEpoch(sessionId) === epoch;
          if (!stillOwnsGoal()) return;
          let fence = owner.captureFailureFence();
          const start = async () => {
            if (!stillOwnsGoal()) return;
            const dispatch = startArmedGoalRound(pi, ctx);
            fence = owner.captureFailureFence();
            await dispatch;
          };
          try {
            await (runRound ? runRound(start) : start());
          } catch {
            if (fence && stillOwnsGoal()) reportGoalRunFailure(pi, ctx, { kind: 'runtime-error', ...fence });
          }
        }
      }).catch(() => undefined);
      return result;
    },
    fail: (failure) => {
      // WorkspaceHandle calls this only after its prompt promise has rejected:
      // preparation failed or the accepted run terminated without SDK settled.
      // The error pause revokes authority, but does not normally release the
      // execution slot (SDK settled does that). A rejected prompt has no such
      // settled event, so release only the exact runner captured by this catch.
      const result = reportGoalRunFailure(pi, ctx, failure);
      const released = !!failure.roundId && occupiedGoalRound(sessionId)?.roundId === failure.roundId &&
        releaseGoalRound(sessionId, failure.roundId);
      // An edit between capture and this catch invalidates the old condition,
      // so no pause is written; the terminated prompt is still gone. Release
      // our own slot and let the current active, armed condition dispatch at
      // most one replacement round. The start barrier re-checks any newer
      // slot, human pause, compaction and unavailable latch.
      if (released && result.skipped) {
        const current = readSnapshot(ctx);
        if (current?.status === 'active' && getActivation(sessionId) === 'armed') {
          void startArmedGoalRound(pi, ctx).catch(() => reportGoalRunFailure(pi, ctx, { kind: 'runtime-error' }));
        }
      }
      return result;
    },
    captureRoundId: () => occupiedGoalRound(sessionId)?.roundId,
    captureFailureFence: () => {
      const snapshot = readSnapshot(ctx);
      if (!snapshot || snapshot.status !== 'active') return undefined;
      const roundId = occupiedGoalRound(sessionId)?.roundId;
      return { ownerEpoch: epoch, goalId: snapshot.goalId, runNumber: snapshot.runNumber, conditionRevision: snapshot.conditionRevision,
        ...(roundId ? { roundId } : {}) };
    },
  };
  controls().set(sessionId, owner);
  let sequence = 0;
  let activeNotice: GoalWorkslotNotice | undefined;
  const publish = (ref: GoalRoundRef | undefined) => {
    if (controls().get(sessionId) !== owner) return;
    if (ref) {
      const path = typeof ctx.sessionManager.getSessionFile === 'function' ? ctx.sessionManager.getSessionFile() : undefined;
      if (!path) return; // A missing path is not evidence of a recoverable crash.
      const snapshot = readSnapshot(ctx);
      if (!snapshot || snapshot.status !== 'active' || snapshot.goalId !== ref.goalId ||
        snapshot.runNumber !== ref.runNumber || snapshot.conditionRevision !== ref.conditionRevision) return;
      activeNotice = { workspace: projectCwd(ctx), sessionPath: path, sessionId, ownerEpoch: epoch, goalId: ref.goalId,
        revision: snapshot.revision, runNumber: ref.runNumber, conditionRevision: ref.conditionRevision,
        roundId: ref.roundId, occupied: true, sequence: ++sequence };
      try { goalOwnerLossPort()?.publish(activeNotice); } catch { /* no confirmed ownership evidence */ }
    } else if (activeNotice) {
      try { goalOwnerLossPort()?.publish({ ...activeNotice, occupied: false, sequence: ++sequence }); }
      catch { /* normal settlement remains authoritative in the host */ }
      activeNotice = undefined;
    }
  };
  const unsubscribe = subscribeGoalWorkslot(sessionId, publish);
  const current = occupiedGoalRound(sessionId);
  if (current) publish(current);
  return () => {
    unsubscribe();
    halfCommits.delete(sessionId);
    if (controls().get(sessionId) === owner) {
      if (activeNotice) publish(undefined);
      controls().delete(sessionId);
    }
  };
}

export function unavailableGoalControl(sessionId: string, request: GoalControlRequest, message = 'GOAL_OWNER_UNAVAILABLE'): GoalControlReceipt {
  return { operationId: request.operationId, sessionId, goalId: request.goalId, action: request.action,
    expectedConditionRevision: request.expectedConditionRevision, outcome: 'unavailable', snapshot: null,
    message };
}

/** This is a host/UI control port, not a registered model-callable tool. */
export async function controlGoal(sessionId: string, raw: unknown, runRound?: RunGoalRound): Promise<GoalControlReceipt> {
  const request = parseGoalControlRequest(raw);
  return controls().get(sessionId)?.execute(request, runRound) ?? unavailableGoalControl(sessionId, request);
}

export function captureGoalOwnerRoundId(sessionId: string): string | undefined {
  return controls().get(sessionId)?.captureRoundId();
}

export function captureGoalOwnerFailureFence(sessionId: string): GoalOwnerFailureFence | undefined {
  return controls().get(sessionId)?.captureFailureFence();
}

export function reportGoalOwnerFailure(sessionId: string, failure: Failure, expectedOwnerEpoch: string) {
  const owner = controls().get(sessionId);
  if (!owner || owner.epoch !== expectedOwnerEpoch) return { persisted: false, skipped: true, error: 'GOAL_OWNER_UNAVAILABLE' };
  return owner.fail(failure);
}

export async function executeGoalCommandControl(pi: ExtensionAPI, ctx: ExtensionContext, action: GoalControlAction, condition?: string): Promise<GoalControlReceipt> {
  const sessionId = sessionIdOf(ctx);
  if (!getGoalOwnerEpoch(sessionId)) buildGoalStatus({ entries: ctx.sessionManager.getEntries(), sessionId });
  if (!controls().has(sessionId)) registerGoalControl(pi, ctx);
  const snapshot = readSnapshot(ctx);
  return controlGoal(sessionId, {
    operationId: crypto.randomUUID(), action, goalId: snapshot?.goalId ?? '',
    expectedRevision: snapshot?.revision ?? 0,
    expectedConditionRevision: snapshot?.conditionRevision ?? 0,
    ...(condition !== undefined ? { condition } : {}),
  });
}

async function applyControl(pi: ExtensionAPI, ctx: ExtensionContext, request: GoalControlRequest, epoch: string): Promise<GoalControlReceipt> {
  const sessionId = sessionIdOf(ctx);
  const entries = () => ctx.sessionManager.getEntries();
  const fingerprint = JSON.stringify(request);
  const base = { operationId: request.operationId, sessionId, goalId: request.goalId, ownerEpoch: epoch,
    action: request.action, expectedConditionRevision: request.expectedConditionRevision };
  const receipt = (outcome: GoalControlReceipt['outcome'], message?: string): GoalControlReceipt => ({
    ...base, outcome, snapshot: readSnapshot(ctx) ?? null,
    status: buildGoalStatus({ entries: entries(), sessionId }), ...(message ? { message } : {}),
  });
  const history = entries();
  const priorIndex = history.findIndex((entry) => readGoalEvent(entry)?.payload.operationId === request.operationId);
  if (priorIndex >= 0) {
    const prior = readGoalEvent(history[priorIndex])!;
    if (prior.payload.controlRequest !== fingerprint) return receipt('conflict', 'GOAL_OPERATION_ID_CONFLICT');
    // A transport retry also re-proves an ACK the earlier commit could not deliver.
    await ackSupersededLoss(ctx, sessionId, prior.payload.supersedesConfirmedLoss);
    return { ...receipt('committed'), replayed: true, goalId: prior.goalId, committedRevision: prior.revision,
      snapshot: foldGoal(history.slice(0, priorIndex + 1)) ?? null };
  }
  const current = readSnapshot(ctx);
  const operationHalf = request.action === 'resume' ? halfCommits.get(sessionId)?.get(request.operationId) : undefined;
  if (operationHalf && operationHalf.fingerprint !== fingerprint) return receipt('conflict', 'GOAL_OPERATION_ID_CONFLICT');
  // A retry of the same operation resumes from the repaired pause instead of
  // being rejected by the pre-repair expectedRevision it sent.
  const resumedFromHalf = !!operationHalf && operationHalf.goalId === request.goalId &&
    current?.revision === operationHalf.revisionAfterRepair;
  const expectedRevision = resumedFromHalf ? operationHalf!.revisionAfterRepair : request.expectedRevision;
  if ((current?.goalId ?? '') !== request.goalId || (current?.revision ?? 0) !== expectedRevision
    || (current?.conditionRevision ?? 0) !== request.expectedConditionRevision) return receipt('conflict', 'VERSION_CONFLICT');
  // A trusted resume is the human boundary that repairs an unpersisted failure
  // pause and supersedes an exact, still-claimed loss. Failure commits nothing.
  let superseded: ConfirmedGoalOwnerLoss | undefined;
  const lossPort = request.action === 'resume' ? goalOwnerLossPort() : undefined;
  if (request.action === 'resume') {
    const hadPending = hasPendingGoalPause(sessionId);
    if (!commitPendingGoalPause(pi, ctx)) return receipt('failed', 'GOAL_PAUSE_NOT_PERSISTED');
    if (hadPending) {
      const repaired = readSnapshot(ctx);
      if (repaired?.status === 'paused' && repaired.goalId === request.goalId) {
        const sessionHalf = halfCommits.get(sessionId) ?? new Map<string, HalfCommit>();
        sessionHalf.set(request.operationId, { fingerprint, goalId: request.goalId,
          revisionAfterRepair: repaired.revision });
        halfCommits.set(sessionId, sessionHalf);
      }
    }
    const path = typeof ctx.sessionManager.getSessionFile === 'function' ? ctx.sessionManager.getSessionFile() : undefined;
    if (lossPort && path) {
      try { superseded = await lossPort.claim(path, sessionId); }
      catch { return receipt('failed', 'GOAL_OWNER_LOSS_UNKNOWN'); }
    }
    // The claim is an async gap: an SDK tool or another legitimate write may
    // have edited, cleared or replaced the Goal meanwhile. Re-check the exact
    // operation identity before any resume/restart append; a mismatch must not
    // ACK, clear the latch or dispatch. A repair already advanced the revision,
    // so accept exactly the recorded post-repair revision for this operation.
    const verifiedHalf = halfCommits.get(sessionId)?.get(request.operationId);
    const requiredRevision = verifiedHalf?.goalId === request.goalId
      ? verifiedHalf.revisionAfterRepair : request.expectedRevision;
    const settled = readSnapshot(ctx);
    if ((settled?.goalId ?? '') !== request.goalId || (settled?.revision ?? 0) !== requiredRevision ||
      (settled?.conditionRevision ?? 0) !== request.expectedConditionRevision) return receipt('conflict', 'VERSION_CONFLICT');
  }
  const metadata = { operationId: request.operationId, controlAction: request.action,
    expectedRevision: request.expectedRevision, expectedConditionRevision: request.expectedConditionRevision, controlRequest: fingerprint,
    ...(superseded ? { supersedesConfirmedLoss: { ownerEpoch: superseded.ownerEpoch,
      roundId: superseded.roundId, sequence: superseded.sequence } } : {}) };
  try {
    if (request.action === 'create') createGoal(pi, ctx, request.condition!, request.maxRounds, metadata);
    else if (request.action === 'edit') editGoal(pi, ctx, request.condition!, metadata);
    else if (request.action === 'pause') pauseGoal(pi, ctx, metadata);
    else if (request.action === 'clear') clearGoal(pi, ctx, metadata);
    else if (current && current.runRoundsStarted >= current.maxRounds) restartGoalForControl(pi, ctx, metadata);
    else resumeGoal(pi, ctx, metadata);
    const committed = entries().find((entry) => readGoalEvent(entry)?.payload.operationId === request.operationId);
    const event = readGoalEvent(committed);
    const after = readSnapshot(ctx);
    if (!event || (request.action !== 'clear' && (!after || after.revision !== event.revision))) return receipt('failed', 'GOAL_WRITE_NOT_COMMITTED');
    // Only a real commit may ACK the exact re-claimed fence; a lost ACK is
    // re-proved from the durable marker on the next owner or operation replay.
    if (superseded && lossPort) {
      try { await lossPort.ack(superseded); } catch { /* durable marker re-ACKs later */ }
    }
    // The latch lifts only after the trusted resume actually committed; the
    // unfrozen run starts now, so the pause-to-resume wait never counts.
    if (request.action === 'resume') {
      const sessionHalf = halfCommits.get(sessionId);
      sessionHalf?.delete(request.operationId);
      if (sessionHalf && sessionHalf.size === 0) halfCommits.delete(sessionId);
    }
    // A committed clear/create is a completed lifecycle boundary: the old
    // Goal's failure projection and pending pause must not block the new one.
    // This only drops latch bookkeeping; it never releases an execution slot.
    if (request.action === 'resume' || request.action === 'create' || request.action === 'clear') {
      clearGoalRunUnavailable(sessionId);
      pushStatus(ctx);
    }
    return { ...receipt('committed'), goalId: event.goalId, committedRevision: event.revision, snapshot: after ?? null };
  } catch (error) {
    return receipt('failed', error instanceof Error ? error.message : 'GOAL_CONTROL_FAILED');
  }
}

type LossFence = { ownerEpoch: string; roundId: string; sequence: number };
function readLossFence(value: unknown): LossFence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const fence = value as Record<string, unknown>;
  return typeof fence.ownerEpoch === 'string' && fence.ownerEpoch !== '' &&
    typeof fence.roundId === 'string' && fence.roundId !== '' &&
    typeof fence.sequence === 'number' && Number.isSafeInteger(fence.sequence)
    ? { ownerEpoch: fence.ownerEpoch, roundId: fence.roundId, sequence: fence.sequence }
    : undefined;
}
function sameLossFence(loss: ConfirmedGoalOwnerLoss, fence: LossFence): boolean {
  return loss.ownerEpoch === fence.ownerEpoch && loss.roundId === fence.roundId && loss.sequence === fence.sequence;
}

/** Startup/replay-only ACK of a loss already superseded by a committed control event. */
async function ackSupersededLoss(ctx: ExtensionContext, sessionId: string, marker: unknown): Promise<void> {
  const fence = readLossFence(marker);
  const port = goalOwnerLossPort();
  const path = typeof ctx.sessionManager.getSessionFile === 'function' ? ctx.sessionManager.getSessionFile() : undefined;
  if (!fence || !port || !path) return;
  try {
    const loss = await port.claim(path, sessionId);
    if (loss && sameLossFence(loss, fence)) await port.ack(loss);
  } catch { /* a later startup re-proves the marker */ }
}
