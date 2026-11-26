import type { ConfirmedGoalOwnerLoss, GoalWorkslotNotice } from './contract';

/** Only a still-occupied, explicitly reported host slot proves an unexpected exit interrupted a Goal. */
export class GoalOwnerLossTracker {
  private readonly slots = new Map<string, GoalWorkslotNotice>();
  private readonly losses = new Map<string, ConfirmedGoalOwnerLoss>();
  private readonly retiredOwners = new Set<string>();

  report(raw: unknown): void {
    if (!isWorkslotNotice(raw)) return;
    const notice = raw;
    if (this.retiredOwners.has(notice.ownerEpoch)) return;
    const previous = this.slots.get(notice.sessionPath);
    // An older queued notification must not release a newer slot or replace its fence.
    if (previous && previous.ownerEpoch === notice.ownerEpoch && notice.sequence <= previous.sequence) return;
    if (!notice.occupied) {
      if (previous?.ownerEpoch === notice.ownerEpoch && previous.sessionId === notice.sessionId &&
        previous.roundId === notice.roundId) this.slots.delete(notice.sessionPath);
      return;
    }
    this.slots.set(notice.sessionPath, notice);
  }

  /** Called after an exit was confirmed unexpected; this is main-process memory, never a disk pause. */
  confirmUnexpectedExit(): ConfirmedGoalOwnerLoss[] {
    const confirmed = [...this.slots.values()].map(slot => ({ ...slot, occupied: true as const }));
    for (const loss of confirmed) {
      this.retiredOwners.add(loss.ownerEpoch);
      this.losses.set(loss.sessionPath, loss);
    }
    this.slots.clear();
    return confirmed;
  }

  /** An expected exit has no crash fact and must never generate a loss. */
  clearExpectedExit(): void {
    for (const slot of this.slots.values()) this.retiredOwners.add(slot.ownerEpoch);
    this.slots.clear();
  }

  claim(sessionPath: string, sessionId: string): ConfirmedGoalOwnerLoss | undefined {
    const loss = this.losses.get(sessionPath);
    return loss?.sessionId === sessionId ? { ...loss } : undefined;
  }

  ack(loss: ConfirmedGoalOwnerLoss): boolean {
    const current = this.losses.get(loss.sessionPath);
    if (!current || !sameFence(current, loss)) return false;
    this.losses.delete(loss.sessionPath);
    return true;
  }
}

function sameFence(a: ConfirmedGoalOwnerLoss, b: ConfirmedGoalOwnerLoss): boolean {
  return a.workspace === b.workspace && a.sessionPath === b.sessionPath && a.sessionId === b.sessionId && a.ownerEpoch === b.ownerEpoch &&
    a.goalId === b.goalId && a.revision === b.revision && a.runNumber === b.runNumber &&
    a.conditionRevision === b.conditionRevision && a.roundId === b.roundId && a.sequence === b.sequence;
}

export function isWorkslotNotice(raw: unknown): raw is GoalWorkslotNotice {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Partial<GoalWorkslotNotice>;
  return typeof p.workspace === 'string' && !!p.workspace && typeof p.sessionPath === 'string' && !!p.sessionPath && typeof p.sessionId === 'string' && !!p.sessionId &&
    typeof p.ownerEpoch === 'string' && !!p.ownerEpoch && typeof p.goalId === 'string' && !!p.goalId &&
    typeof p.roundId === 'string' && !!p.roundId && typeof p.occupied === 'boolean' &&
    Number.isSafeInteger(p.runNumber) && p.runNumber! > 0 && Number.isSafeInteger(p.conditionRevision) &&
    p.conditionRevision! > 0 && Number.isSafeInteger(p.revision) && p.revision! > 0 &&
    Number.isSafeInteger(p.sequence) && p.sequence! > 0;
}
