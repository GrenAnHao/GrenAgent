import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ConfirmedGoalOwnerLoss } from '../../electron-agent/electron/agentProcess/contract.js';
import { reportGoalRunFailure } from './continue.js';
import { foldGoal, readGoalEvent } from './fold.js';
import { goalOwnerLossPort } from './owner-loss.js';
import { onSessionStart, pushStatus, readSnapshot, sessionIdOf, setActivation } from './session.js';
import { setGoalOwnerUnavailable } from './status.js';

function matchesLoss(ctx: ExtensionContext, loss: ConfirmedGoalOwnerLoss): boolean {
  const snapshot = readSnapshot(ctx);
  return ctx.sessionManager.getSessionFile?.() === loss.sessionPath && sessionIdOf(ctx) === loss.sessionId &&
    snapshot?.status === 'active' && snapshot.goalId === loss.goalId && snapshot.revision === loss.revision &&
    snapshot.runNumber === loss.runNumber && snapshot.conditionRevision === loss.conditionRevision;
}

interface LossFence { ownerEpoch: unknown; roundId: unknown; sequence: unknown }

function fenceOf(value: unknown): LossFence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const fence = value as Record<string, unknown>;
  return { ownerEpoch: fence.ownerEpoch, roundId: fence.roundId, sequence: fence.sequence };
}

function sameFence(fence: LossFence | undefined, loss: ConfirmedGoalOwnerLoss): boolean {
  return !!fence && fence.ownerEpoch === loss.ownerEpoch && fence.roundId === loss.roundId && fence.sequence === loss.sequence;
}

/**
 * The pause this loss wrote stays provable after later legitimate edits or
 * resumes. Verify the tagged event as it folded at its own time, not whether
 * the current snapshot still sits on that revision. A newer Goal is never
 * mistaken for it because the pause carries the original fence.
 */
function hasCommittedPause(ctx: ExtensionContext, loss: ConfirmedGoalOwnerLoss): boolean {
  const entries = ctx.sessionManager.getEntries();
  for (let index = 0; index < entries.length; index += 1) {
    const event = readGoalEvent(entries[index]);
    if (event?.kind !== 'pause' || event.goalId !== loss.goalId || event.revision !== loss.revision + 1) continue;
    if (!sameFence(fenceOf(event.payload.confirmedLoss), loss)) continue;
    const folded = foldGoal(entries.slice(0, index + 1));
    if (!folded) continue;
    if (folded.goalId === loss.goalId && folded.revision === event.revision &&
      folded.status === 'paused' && folded.pauseReason?.code === 'runtime-error') return true;
  }
  return false;
}

/**
 * A trusted human resume may have already replaced this exact loss. The marker
 * lives in the committed control event, so a lost ACK is re-proved on startup
 * without writing another pause. A marker for another fence proves nothing.
 */
function hasSupersededLoss(ctx: ExtensionContext, loss: ConfirmedGoalOwnerLoss): boolean {
  const entries = ctx.sessionManager.getEntries();
  for (let index = 0; index < entries.length; index += 1) {
    const event = readGoalEvent(entries[index]);
    if (!event || !sameFence(fenceOf(event.payload.supersedesConfirmedLoss), loss)) continue;
    const folded = foldGoal(entries.slice(0, index + 1));
    if (!folded) continue;
    if (folded.revision === event.revision && folded.goalId === event.goalId) return true;
  }
  return false;
}

/** Claim is read-only. Only this freshly opened, writable session owner appends the pause. */
export async function recoverGoalOwnerLoss(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  const port = goalOwnerLossPort();
  const path = ctx.sessionManager.getSessionFile?.();
  const sessionId = sessionIdOf(ctx);
  let loss: ConfirmedGoalOwnerLoss | undefined;
  let claimFailed = false;
  if (port && path) {
    try { loss = await port.claim(path, sessionId); }
    catch { claimFailed = true; }
  } else if (port) claimFailed = true;
  // No owner epoch or status is published before the main-process claim settles.
  onSessionStart(ctx, { forceDisarmed: claimFailed || !!loss, deferStatus: claimFailed || !!loss });
  if (!loss && !claimFailed) return true; // normal reopen keeps the configured auto-continue rule
  const unavailable = (reason: string) => {
    setActivation(sessionId, 'disarmed');
    setGoalOwnerUnavailable(sessionId, reason);
    pushStatus(ctx);
  };
  if (claimFailed || !loss || !port) { unavailable('GOAL_OWNER_LOSS_UNKNOWN'); return false; }
  const superseded = hasSupersededLoss(ctx, loss);
  const committedPause = !superseded && hasCommittedPause(ctx, loss);
  if (!matchesLoss(ctx, loss) && !committedPause && !superseded) {
    // A genuinely stale loss is never ACKed automatically.
    unavailable('GOAL_OWNER_LOSS_STALE');
    return false;
  }
  if (!committedPause && !superseded) {
    const result = reportGoalRunFailure(pi, ctx, { kind: 'runtime-error',
      goalId: loss.goalId, runNumber: loss.runNumber, conditionRevision: loss.conditionRevision,
      // Do not pass old roundId: it belongs to the dead owner, not this process.
      confirmedLoss: { ownerEpoch: loss.ownerEpoch, roundId: loss.roundId, sequence: loss.sequence },
    });
    if (!result.persisted || !hasCommittedPause(ctx, loss)) {
      unavailable('GOAL_PAUSE_NOT_PERSISTED');
      return false;
    }
  }
  try {
    if (!(await port.ack(loss))) { unavailable('GOAL_OWNER_LOSS_ACK_FAILED'); return false; }
  } catch { unavailable('GOAL_OWNER_LOSS_ACK_FAILED'); return false; }
  if (superseded) {
    // The user's committed resume already moved past this loss; a reopen is normal.
    onSessionStart(ctx);
    return true;
  }
  pushStatus(ctx); // ACK retry may have found an already durable pause.
  return false;
}
