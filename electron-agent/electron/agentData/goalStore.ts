import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GoalCasUpdate, GoalDispatch, GoalEvent, GoalJudgeRecord, GoalSnapshot, GoalStatus, CreateGoalInput, RoundClaimInput, RoundSettlementInput, RoundCancelInput, JudgeResultInput, ForkGoalInput, GoalRuntimeErrorInput, GoalProgressInput, RecoverLegacyGoalInput } from './goalContracts';

export const DEFAULT_MAX_ROUNDS = 256;
export type GoalPublish = (event: GoalEvent) => void | boolean | Promise<void | boolean>;

function validateMaxRounds(value: number | undefined): number {
  const max = value ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isSafeInteger(max) || max <= 0) throw new Error('INVALID_MAX_ROUNDS');
  return max;
}

export class GoalStore {
  private readonly listeners = new Set<GoalPublish>();
  private pending: GoalEvent[];
  private publishing?: Promise<void>;
  private publishingSync = false;
  constructor(readonly db: DatabaseSync, publish?: GoalPublish) {
    if (publish) this.listeners.add(publish);
    this.pending = (this.db.prepare('SELECT * FROM goal_events WHERE published_at IS NULL ORDER BY created_at,rowid').all() as Array<Record<string, unknown>>).map(mapEvent);
    this.recoverActiveGoals();
  }

  onPublish(listener: GoalPublish): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  replay(): Promise<void> { return Promise.resolve(this.publishPending()); }

  get(sessionId: string): GoalSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM goal_snapshots WHERE session_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapSnapshot(row) : undefined;
  }

  /** Read a specific Goal generation for event replay; never substitute the session's latest generation. */
  getById(sessionId: string, goalId: string): GoalSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM goal_snapshots WHERE session_id=? AND goal_id=?').get(sessionId, goalId) as Record<string, unknown> | undefined;
    return row ? mapSnapshot(row) : undefined;
  }

  getLive(sessionId: string): GoalSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM goal_snapshots WHERE session_id=? AND status <> 'cleared' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapSnapshot(row) : undefined;
  }

  create(input: CreateGoalInput): GoalSnapshot {
    const maxRounds = validateMaxRounds(input.maxRounds);
    if (!input.sessionId || !input.condition?.trim()) throw new Error('INVALID_GOAL');
    return this.tx(() => {
      const existing = this.db.prepare("SELECT 1 FROM goal_snapshots WHERE session_id=? AND status <> 'cleared' LIMIT 1").get(input.sessionId);
      if (existing) throw new Error('GOAL_ALREADY_EXISTS');
      const now = new Date().toISOString(); const snapshot: GoalSnapshot = { goalId: randomUUID(), sessionId: input.sessionId, workspace: input.workspace, revision: 1, condition: input.condition, status: 'active', roundsUsed: 0, maxRounds, createdAt: now, updatedAt: now, source: 'human' };
      this.persist(snapshot); this.event(snapshot, 'create', { origin: input.origin, ...(input.continuousIntentEvidence ? { continuousIntentEvidence: input.continuousIntentEvidence } : {}) }); return snapshot;
    });
  }

  /** Import the old session custom entry without rewriting the original JSONL. */
  recoverLegacy(input: RecoverLegacyGoalInput): GoalSnapshot {
    if (!input.sessionId?.trim() || !input.workspace?.trim() || !input.condition?.trim()) throw new Error('INVALID_GOAL');
    if (!Number.isSafeInteger(input.react) || input.react < 0 || typeof input.paused !== 'boolean') throw new Error('INVALID_LEGACY_GOAL');
    return this.tx(() => {
      // Both the visible and headless worker can request recovery while they
      // bind the same session. Returning any existing generation makes this
      // operation idempotent and preserves an explicit cleared tombstone.
      const existing = this.get(input.sessionId);
      if (existing) return existing;
      const now = new Date().toISOString();
      const snapshot: GoalSnapshot = {
        goalId: randomUUID(), sessionId: input.sessionId, workspace: input.workspace,
        revision: 1, condition: input.condition.trim(), status: 'disarmed', roundsUsed: 0,
        maxRounds: DEFAULT_MAX_ROUNDS, createdAt: now, updatedAt: now, source: 'legacy',
      };
      this.persist(snapshot);
      this.event(snapshot, 'legacy_goal_restored', {
        source: 'legacy', condition: snapshot.condition, react: input.react, paused: input.paused,
        ...(input.legacyEntryTimestamp === undefined ? {} : { legacyEntryTimestamp: input.legacyEntryTimestamp }),
      });
      return snapshot;
    });
  }

  update(input: GoalCasUpdate): GoalSnapshot {
    if (input.action === 'block') {
      if (input.origin === 'human-ui' && typeof input.payload?.condition === 'string') {
        return this.updateBlockedCondition(input);
      }
      return this.recordProgress({
        sessionId: input.sessionId,
        goalId: input.goalId,
        revision: input.revision,
        summary: typeof input.payload?.reason === 'string' ? input.payload.reason : undefined,
        fingerprint: typeof input.payload?.fingerprint === 'string' ? input.payload.fingerprint : undefined,
      });
    }
    return this.tx(() => {
      const hasMaxRounds = Boolean(input.payload && Object.prototype.hasOwnProperty.call(input.payload, 'maxRounds'));
      const hasCondition = Boolean(input.payload && Object.prototype.hasOwnProperty.call(input.payload, 'condition'));
      if (input.action === 'judge_pass' || input.action === 'judge_fail') throw new Error('INVALID_TRANSITION');
      if ((['pause', 'resume', 'clear'].includes(input.action) || hasMaxRounds || hasCondition) && input.origin !== 'human-ui') throw new Error('HUMAN_AUTH_REQUIRED');
      const current = this.require(input.sessionId, input.goalId); assertRevision(current, input.goalId, input.revision);
      const next = transition(current, input.action, input.payload);
      if (hasMaxRounds) {
        const maxRounds = validateMaxRounds(Number(input.payload?.maxRounds));
        if (maxRounds < current.roundsUsed) throw new Error('MAX_ROUNDS_BELOW_USAGE');
        next.maxRounds = maxRounds;
      }
      if (hasCondition) {
        if (typeof input.payload?.condition !== 'string' || !input.payload.condition.trim()) throw new Error('INVALID_GOAL');
        next.condition = input.payload.condition.trim();
      }
      this.persist(next); this.event(next, input.action, input.payload ?? {}); return next;
    });
  }

  private updateBlockedCondition(input: GoalCasUpdate): GoalSnapshot {
    return this.tx(() => {
      const current = this.require(input.sessionId, input.goalId);
      assertRevision(current, input.goalId, input.revision);
      if (current.status !== 'blocked' || !input.payload?.condition || typeof input.payload.condition !== 'string') throw new Error('INVALID_TRANSITION');
      const condition = input.payload.condition.trim();
      if (!condition) throw new Error('INVALID_GOAL');
      const next: GoalSnapshot = { ...current, condition, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      this.persist(next); this.event(next, 'condition_update', { condition });
      return next;
    });
  }

  /** Record a blockage on the currently claimed automatic round without changing the Goal revision. */
  recordProgress(input: GoalProgressInput): GoalSnapshot {
    return this.tx(() => {
      const current = this.require(input.sessionId, input.goalId);
      assertRevision(current, input.goalId, input.revision);
      if (current.status !== 'active') throw new Error('INVALID_TRANSITION');
      const lease = this.db.prepare("SELECT * FROM goal_turn_leases WHERE goal_id=? AND session_id=? AND revision=? AND status='claimed' ORDER BY claimed_at DESC LIMIT 1").get(input.goalId, input.sessionId, input.revision) as Record<string, unknown> | undefined;
      if (!lease) throw new Error('ROUND_NOT_CLAIMED');
      const fingerprint = typeof input.fingerprint === 'string' ? input.fingerprint.trim().slice(0, 400) : '';
      const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary.trim().slice(0, 4000) : '业务阻塞';
      this.db.prepare('UPDATE goal_turn_leases SET blockage_fingerprint=?, blockage_summary=? WHERE idempotency_key=?').run(fingerprint || null, summary, String(lease.idempotency_key));
      this.event(current, 'progress', { reason: summary, ...(fingerprint ? { fingerprint } : {}), nextRound: Number(lease.next_round) });
      return current;
    });
  }

  claimRound(input: RoundClaimInput): GoalDispatch {
    return this.tx(() => {
      const canonicalKey = `${input.goalId}:${input.revision}:${input.nextRound}`;
      if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey !== canonicalKey) throw new Error('INVALID_IDEMPOTENCY_KEY');
      const prior = this.db.prepare('SELECT * FROM goal_turn_leases WHERE idempotency_key=?').get(canonicalKey) as Record<string, unknown> | undefined;
      if (prior) {
        assertLeaseMatches(prior, input.sessionId, input.goalId, input.revision);
        return mapDispatch(prior);
      }
      const priorRound = this.db.prepare('SELECT * FROM goal_turn_leases WHERE goal_id=? AND revision=? AND next_round=?').get(input.goalId, input.revision, input.nextRound) as Record<string, unknown> | undefined;
      if (priorRound) {
        assertLeaseMatches(priorRound, input.sessionId, input.goalId, input.revision);
        return mapDispatch(priorRound);
      }
      const current = this.require(input.sessionId, input.goalId); assertRevision(current, input.goalId, input.revision);
      if (current.status !== 'active') throw new Error('GOAL_NOT_ACTIVE');
      if (current.roundsUsed >= current.maxRounds) throw new Error('MAX_ROUNDS_REACHED');
      if (!Number.isSafeInteger(input.nextRound) || input.nextRound !== current.roundsUsed + 1 || input.nextRound > current.maxRounds) throw new Error('INVALID_ROUND');
      const dispatch: GoalDispatch = { idempotencyKey: canonicalKey, goalId: input.goalId, revision: input.revision, nextRound: input.nextRound, status: 'claimed', ...(input.turnId ? { turnId: input.turnId } : {}) };
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO goal_turn_leases(
        idempotency_key,goal_id,session_id,revision,next_round,status,turn_id,workspace,origin,prompt_digest,continuous_intent,summary,error,blockage_fingerprint,blockage_summary,created_at,claimed_at,settled_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        canonicalKey, input.goalId, input.sessionId, input.revision, input.nextRound, dispatch.status, input.turnId ?? null,
        input.workspace ?? current.workspace, input.origin ?? 'system', input.promptDigest ?? '', input.continuousIntent ? 1 : 0,
        null, null, null, null, now, now, null,
      );
      this.event(current, 'round_claim', { nextRound: input.nextRound }, canonicalKey); return dispatch;
    });
  }

  settleRound(input: RoundSettlementInput): { snapshot: GoalSnapshot; dispatch: GoalDispatch } {
    return this.tx(() => {
      const prior = this.db.prepare('SELECT * FROM goal_turn_leases WHERE idempotency_key=?').get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (prior) {
        assertLeaseMatches(prior, input.sessionId, input.goalId, input.revision);
        assertLeaseTurnMatches(prior, input.turnId);
      }
      if (prior && String(prior.status) === 'settled') return { snapshot: this.require(input.sessionId, input.goalId), dispatch: mapDispatch(prior) };
      const settledByTurn = this.db.prepare("SELECT * FROM goal_turn_leases WHERE goal_id=? AND session_id=? AND revision=? AND turn_id=? AND status='settled' ORDER BY settled_at DESC LIMIT 1").get(input.goalId, input.sessionId, input.revision, input.turnId) as Record<string, unknown> | undefined;
      if (settledByTurn) {
        const current = this.require(input.sessionId, input.goalId);
        assertRevision(current, input.goalId, input.revision);
        return { snapshot: current, dispatch: mapDispatch(settledByTurn) };
      }
      const lease = prior ?? this.db.prepare('SELECT * FROM goal_turn_leases WHERE goal_id=? AND revision=? AND turn_id=?').get(input.goalId, input.revision, input.turnId) as Record<string, unknown> | undefined;
      if (!lease) throw new Error('ROUND_NOT_CLAIMED');
      assertLeaseMatches(lease, input.sessionId, input.goalId, input.revision);
      assertLeaseTurnMatches(lease, input.turnId);
      const current = this.require(input.sessionId, input.goalId); assertRevision(current, input.goalId, input.revision);
      const roundsUsed = current.roundsUsed + 1;
      const now = new Date().toISOString();
      const fingerprint = typeof lease.blockage_fingerprint === 'string' ? lease.blockage_fingerprint.trim() : '';
      const summary = typeof lease.blockage_summary === 'string' && lease.blockage_summary.trim() ? lease.blockage_summary : '业务阻塞';
      let next: GoalSnapshot = { ...current, roundsUsed, revision: current.revision + 1, updatedAt: now, blockage: undefined };
      if (fingerprint) {
        const count = current.blockage?.fingerprint === fingerprint ? current.blockage.count + 1 : 1;
        next.blockage = { fingerprint, count, summary, lastTurnId: input.turnId, at: now };
        if (count >= 3) next = { ...next, status: 'blocked', stopReason: { kind: 'blocked', summary, at: now, turnId: input.turnId } };
      }
      if (next.status === 'active' && roundsUsed >= current.maxRounds) {
        next = { ...next, status: 'paused', stopReason: { kind: 'max_rounds', summary: '达到最大轮数', at: now } };
      }
      this.persist(next);
      const updated = this.db.prepare('UPDATE goal_turn_leases SET status=\'settled\',turn_id=?,summary=?,settled_at=? WHERE idempotency_key=? AND status<>\'settled\'').run(input.turnId, input.summary, next.updatedAt, String(lease.idempotency_key));
      if (Number(updated.changes)) this.event(next, 'round_settle', { nextRound: Number(lease.next_round), turnId: input.turnId, summary: input.summary }, `${String(lease.idempotency_key)}:settle`);
      const finalLease = this.db.prepare('SELECT * FROM goal_turn_leases WHERE idempotency_key=?').get(String(lease.idempotency_key)) as Record<string, unknown>;
      return { snapshot: next, dispatch: mapDispatch(finalLease) };
    });
  }

  /**
   * Release one claimed round without touching the Goal snapshot. The lease is
   * located by its idempotency key so a generation whose revision has already
   * moved on cannot strand it. Repeated cancellation, and a lease that is
   * already settled or failed, return the stored dispatch unchanged.
   */
  cancelRound(input: RoundCancelInput): GoalDispatch | undefined {
    if (typeof input?.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new Error('INVALID_IDEMPOTENCY_KEY');
    return this.tx(() => {
      const lease = this.db.prepare('SELECT * FROM goal_turn_leases WHERE idempotency_key=?').get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (!lease) return undefined;
      assertLeaseMatches(lease, input.sessionId, input.goalId, input.revision);
      // A lease claimed without a turn id can still be cancelled; only a
      // conflicting turn id means the caller is describing a different turn.
      if (input.turnId && typeof lease.turn_id === 'string' && lease.turn_id && lease.turn_id !== input.turnId) throw new Error('TURN_ID_MISMATCH');
      if (['settled', 'failed'].includes(String(lease.status))) return mapDispatch(lease);
      const now = new Date().toISOString();
      const reason = (typeof input.reason === 'string' ? input.reason.trim().slice(0, 4000) : '') || 'goal turn cancelled';
      const updated = this.db.prepare("UPDATE goal_turn_leases SET status='failed',error=?,settled_at=? WHERE idempotency_key=? AND status IN ('claimed','queued')").run(reason, now, input.idempotencyKey);
      if (Number(updated.changes)) {
        this.event({ goalId: input.goalId, sessionId: input.sessionId, revision: input.revision }, 'round_cancel', {
          reason, nextRound: Number(lease.next_round), ...(input.turnId ? { turnId: input.turnId } : {}),
        }, `${input.idempotencyKey}:cancel`);
      }
      return mapDispatch(this.db.prepare('SELECT * FROM goal_turn_leases WHERE idempotency_key=?').get(input.idempotencyKey) as Record<string, unknown>);
    });
  }

  recordJudge(input: JudgeResultInput): GoalSnapshot {
    return this.tx(() => {
      const current = this.require(input.sessionId, input.goalId); assertRevision(current, input.goalId, input.revision);
      if (current.status !== 'judging') throw new Error('INVALID_TRANSITION');
      const now = new Date().toISOString(); const judge: GoalJudgeRecord = { model: input.model ?? 'unknown', verdict: input.verdict, reason: input.reason, missing: input.missing ?? [], revision: input.revision, ...(input.turnId ? { turnId: input.turnId } : {}), at: now };
      let next: GoalSnapshot = { ...current, judge, updatedAt: now, revision: current.revision + 1 };
      if (input.verdict === 'pass') next.status = 'complete';
      else { next.status = input.verdict === 'error' ? 'error' : 'paused'; next.stopReason = { kind: input.verdict === 'error' ? 'judge_unavailable' : 'judge_failed', summary: input.reason, at: now, ...(input.turnId ? { turnId: input.turnId } : {}) }; }
      this.persist(next); this.event(next, input.verdict === 'pass' ? 'judge_pass' : 'judge_fail', { reason: input.reason }); return next;
    });
  }

  failRuntime(input: GoalRuntimeErrorInput): GoalSnapshot {
    return this.tx(() => {
      const current = this.require(input.sessionId, input.goalId);
      assertRevision(current, input.goalId, input.revision);
      if (['complete', 'cleared'].includes(current.status)) throw new Error('INVALID_TRANSITION');
      const now = new Date().toISOString();
      const next: GoalSnapshot = {
        ...current,
        status: 'error',
        revision: current.revision + 1,
        updatedAt: now,
        stopReason: { kind: 'runtime_error', summary: input.reason, at: now, ...(input.turnId ? { turnId: input.turnId } : {}) },
      };
      this.persist(next);
      const leaseWhere = input.turnId
        ? "goal_id=? AND session_id=? AND revision=? AND turn_id=? AND status IN ('claimed','queued')"
        : "goal_id=? AND session_id=? AND revision=? AND status IN ('claimed','queued')";
      const leaseArgs = input.turnId
        ? [input.goalId, input.sessionId, input.revision, input.turnId]
        : [input.goalId, input.sessionId, input.revision];
      this.db.prepare(`UPDATE goal_turn_leases SET status='failed',error=?,settled_at=? WHERE ${leaseWhere}`).run(input.reason, now, ...leaseArgs);
      this.event(next, 'runtime_error', { reason: input.reason, ...(input.turnId ? { turnId: input.turnId } : {}) });
      return next;
    });
  }

  history(sessionId: string, limit?: number): GoalEvent[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('INVALID_HISTORY_LIMIT');
    const rows = limit === undefined
      ? this.db.prepare('SELECT * FROM goal_events WHERE session_id=? ORDER BY created_at,rowid').all(sessionId)
      : this.db.prepare('SELECT * FROM goal_events WHERE session_id=? ORDER BY created_at,rowid LIMIT ?').all(sessionId, limit);
    return (rows as Array<Record<string, unknown>>).map(mapEvent);
  }

  clear(input: GoalCasUpdate): GoalSnapshot { return this.update({ ...input, action: 'clear' }); }

  restart(sessionId: string): GoalSnapshot | undefined {
    const current = this.get(sessionId); if (!current || current.status !== 'active') return current;
    return this.update({ sessionId, goalId: current.goalId, revision: current.revision, action: 'disarm', origin: 'system' });
  }

  fork(input: ForkGoalInput): GoalSnapshot {
    if (!input || !input.sourceSessionId?.trim() || !input.sourceGoalId?.trim() || !input.targetSessionId?.trim() || input.sourceSessionId === input.targetSessionId) throw new Error('INVALID_FORK_SESSION');
    const source = this.require(input.sourceSessionId, input.sourceGoalId); const sessionId = input.targetSessionId;
    return this.tx(() => {
      // A repeated fork sync must return the copy it already made, including a
      // cleared tombstone. Looking it up by source reference (not by live
      // status) is what keeps `clear` from being resurrected by a later retry.
      const copied = this.db.prepare('SELECT * FROM goal_snapshots WHERE session_id=? AND source_goal_id=? AND source_session_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(sessionId, source.goalId, source.sessionId) as Record<string, unknown> | undefined;
      if (copied) return mapSnapshot(copied);
      const existing = this.db.prepare("SELECT * FROM goal_snapshots WHERE session_id=? AND status <> 'cleared' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(sessionId) as Record<string, unknown> | undefined;
      if (existing) throw new Error('GOAL_ALREADY_EXISTS');
      const now = new Date().toISOString();
      // Forking a cleared Goal copies the tombstone instead of a runnable
      // snapshot: the fork target must not offer to resume a cleared goal, and
      // the tombstone also stops legacy JSONL recovery from recreating it.
      const cleared = source.status === 'cleared';
      const snapshot: GoalSnapshot = {
        ...source, goalId: randomUUID(), sessionId, status: cleared ? 'cleared' : 'disarmed', revision: 1, roundsUsed: 0,
        createdAt: now, updatedAt: now, source: 'fork', sourceGoalId: source.goalId, sourceSessionId: source.sessionId,
        stopReason: cleared ? { kind: 'cleared', summary: '目标已清除', at: now } : undefined,
        judge: undefined, blockage: undefined, clearedAt: cleared ? now : undefined,
      };
      this.persist(snapshot);
      this.event(snapshot, 'fork', { sourceGoalId: source.goalId, sourceSessionId: source.sessionId, ...(cleared ? { cleared: true } : {}) });
      return snapshot;
    });
  }

  private require(sessionId: string, goalId: string): GoalSnapshot { const row = this.db.prepare('SELECT * FROM goal_snapshots WHERE session_id=? AND goal_id=?').get(sessionId, goalId) as Record<string, unknown> | undefined; if (!row) throw new Error('GOAL_NOT_FOUND'); return mapSnapshot(row); }
  private recoverActiveGoals(): void {
    const rows = this.db.prepare("SELECT * FROM goal_snapshots WHERE status IN ('active','judging') ORDER BY session_id, goal_id").all() as Array<Record<string, unknown>>;
    if (!rows.length) return;
    this.tx(() => {
      for (const row of rows) {
        const current = mapSnapshot(row);
        const now = new Date().toISOString();
        const next: GoalSnapshot = { ...current, status: 'disarmed', revision: current.revision + 1, updatedAt: now };
        this.persist(next);
        this.event(next, 'disarm', { origin: 'system', reason: 'restart' });
      }
    });
  }
  private persist(snapshot: GoalSnapshot): void { this.db.prepare(`INSERT INTO goal_snapshots(goal_id,session_id,workspace,revision,condition,status,rounds_used,max_rounds,created_at,updated_at,stop_reason,judge,blockage,source_goal_id,source_session_id,cleared_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET revision=excluded.revision,condition=excluded.condition,status=excluded.status,rounds_used=excluded.rounds_used,max_rounds=excluded.max_rounds,updated_at=excluded.updated_at,stop_reason=excluded.stop_reason,judge=excluded.judge,blockage=excluded.blockage,source_goal_id=excluded.source_goal_id,source_session_id=excluded.source_session_id,cleared_at=excluded.cleared_at,source=excluded.source`).run(snapshot.goalId,snapshot.sessionId,snapshot.workspace,snapshot.revision,snapshot.condition,snapshot.status,snapshot.roundsUsed,snapshot.maxRounds,snapshot.createdAt,snapshot.updatedAt,json(snapshot.stopReason),json(snapshot.judge),json(snapshot.blockage),snapshot.sourceGoalId ?? null,snapshot.sourceSessionId ?? null,snapshot.clearedAt ?? null,snapshot.source ?? null); }
  /** Only the event identity is read, so a lease-scoped cancellation can carry its own revision. */
  private event(snapshot: Pick<GoalSnapshot, 'goalId' | 'sessionId' | 'revision'>, kind: string, payload: Record<string, unknown>, idempotencyKey?: string): void { const event: GoalEvent = { id: randomUUID(), goalId: snapshot.goalId, sessionId: snapshot.sessionId, revision: snapshot.revision, kind, payload, ...(idempotencyKey ? { idempotencyKey } : {}), createdAt: new Date().toISOString() }; this.db.prepare('INSERT INTO goal_events(id,goal_id,session_id,revision,kind,payload,idempotency_key,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?)').run(event.id,event.goalId,event.sessionId,event.revision,event.kind,JSON.stringify(event.payload),event.idempotencyKey ?? null,event.createdAt,null); this.pending.push(event); }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const start = this.pending.length;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.publishPending();
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.pending.splice(start);
      throw error;
    }
  }

  private publishPending(startIndex = 0): Promise<void> | void {
    if (this.publishing || this.publishingSync) return this.publishing;
    this.publishingSync = true;
    try {
      for (let index = startIndex; index < this.pending.length;) {
        const event = this.pending[index];
        let delivered = false;
        let failed = false;
        const asyncDeliveries: Array<Promise<boolean>> = [];
        for (const listener of this.listeners) {
          try {
            const result = listener(event);
            if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
              asyncDeliveries.push(Promise.resolve(result).then((value) => value !== false, () => false));
            } else if (result !== false) {
              delivered = true;
            } else {
              failed = true;
            }
          } catch { failed = true; }
        }
        if (asyncDeliveries.length) {
          const currentEvent = event;
          this.publishingSync = false;
          const work = (async () => {
            const results = await Promise.all(asyncDeliveries);
            const success = !failed && results.every(Boolean);
            const eventIndex = this.pending.indexOf(currentEvent);
            let acknowledged = false;
            if (success && eventIndex >= 0) {
              try {
                this.db.prepare('UPDATE goal_events SET published_at=? WHERE id=?').run(new Date().toISOString(), currentEvent.id);
                this.pending.splice(eventIndex, 1);
                acknowledged = true;
              } catch { /* keep the event pending for a later replay */ }
            }
            this.publishing = undefined;
            const nextIndex = eventIndex < 0 ? 0 : acknowledged ? eventIndex : eventIndex + 1;
            const next = this.publishPending(nextIndex);
            if (next) await next;
          })();
          this.publishing = work;
          return work;
        }
        // A partial delivery cannot be acknowledged: the failed consumer must
        // be able to receive the event after restart/replay.
        if ((!delivered && !this.listeners.size) || failed) { index += 1; continue; }
        try {
          this.db.prepare('UPDATE goal_events SET published_at=? WHERE id=?').run(new Date().toISOString(), event.id);
          this.pending.splice(index, 1);
        } catch {
          index += 1;
        }
      }
    } finally {
      this.publishingSync = false;
    }
  }
}

function json(value: unknown): string | null { return value == null ? null : JSON.stringify(value); }
function assertRevision(snapshot: GoalSnapshot, goalId: string, revision: number): void { if (snapshot.goalId !== goalId || snapshot.revision !== revision) throw new Error('VERSION_CONFLICT'); }
function assertLeaseMatches(row: Record<string, unknown>, sessionId: string, goalId: string, revision: number): void {
  if (String(row.session_id) !== sessionId || String(row.goal_id) !== goalId || Number(row.revision) !== revision) throw new Error('IDEMPOTENCY_CONFLICT');
}
function assertLeaseTurnMatches(row: Record<string, unknown>, turnId: string): void {
  if (typeof row.turn_id !== 'string' || row.turn_id !== turnId) throw new Error('TURN_ID_MISMATCH');
}
function transition(current: GoalSnapshot, action: GoalCasUpdate['action'], payload?: Record<string, unknown>): GoalSnapshot {
  const now = new Date().toISOString(); let status: GoalStatus = current.status;
  if (action === 'pause' && current.status === 'active') status = 'paused';
  else if (action === 'resume' && ['paused','blocked','disarmed','error'].includes(current.status)) status = 'active';
  else if (action === 'begin_judging' && current.status === 'active') status = 'judging';
  else if (action === 'block' && current.status === 'active') status = 'blocked';
  else if (action === 'disarm' && ['active','paused'].includes(current.status)) status = 'disarmed';
  else if (action === 'clear' && ['active','paused','blocked','disarmed','error'].includes(current.status)) status = 'cleared';
  else if (action === 'judge_pass' && current.status === 'judging') status = 'complete';
  else if (action === 'judge_fail' && current.status === 'judging') status = 'paused';
  else throw new Error('INVALID_TRANSITION');
  const next: GoalSnapshot = { ...current, status, revision: current.revision + 1, updatedAt: now };
  if (status === 'cleared') { next.stopReason = { kind: 'cleared', summary: '目标已清除', at: now }; next.clearedAt = now; }
  else if (action === 'pause') next.stopReason = { kind: 'user_pause', summary: String(payload?.reason ?? 'user_pause'), at: now };
  else if (action === 'block') { next.stopReason = { kind: 'blocked', summary: String(payload?.reason ?? 'blocked'), at: now }; const fp = String(payload?.fingerprint ?? ''); const prior = current.blockage; next.blockage = { fingerprint: fp, count: fp && prior?.fingerprint === fp ? prior.count + 1 : 1, summary: String(payload?.reason ?? 'blocked'), at: now }; }
  else if (action === 'judge_fail') next.stopReason = { kind: 'judge_failed', summary: String(payload?.reason ?? '条件未满足'), at: now, ...(payload?.turnId ? { turnId: String(payload.turnId) } : {}) };
  else if (action === 'resume' && current.blockage) next.blockage = { ...current.blockage, count: 0 };
  return next;
}
function mapSnapshot(row: Record<string, unknown>): GoalSnapshot { return { goalId: String(row.goal_id), sessionId: String(row.session_id), workspace: String(row.workspace), revision: Number(row.revision), condition: String(row.condition), status: String(row.status) as GoalStatus, roundsUsed: Number(row.rounds_used), maxRounds: Number(row.max_rounds), createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(row.stop_reason ? { stopReason: JSON.parse(String(row.stop_reason)) } : {}), ...(row.judge ? { judge: JSON.parse(String(row.judge)) } : {}), ...(row.blockage ? { blockage: JSON.parse(String(row.blockage)) } : {}), ...(row.source_goal_id ? { sourceGoalId: String(row.source_goal_id) } : {}), ...(row.source_session_id ? { sourceSessionId: String(row.source_session_id) } : {}), ...(row.cleared_at ? { clearedAt: String(row.cleared_at) } : {}), ...(row.source ? { source: String(row.source) as GoalSnapshot['source'] } : {}) }; }
function mapEvent(row: Record<string, unknown>): GoalEvent { return { id: String(row.id), goalId: String(row.goal_id), sessionId: String(row.session_id), revision: Number(row.revision), kind: String(row.kind), payload: JSON.parse(String(row.payload)) as Record<string, unknown>, ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}), createdAt: String(row.created_at), ...(row.published_at ? { publishedAt: String(row.published_at) } : {}) }; }
function mapDispatch(row: Record<string, unknown>): GoalDispatch { return { idempotencyKey: String(row.idempotency_key), goalId: String(row.goal_id), revision: Number(row.revision), nextRound: Number(row.next_round), status: String(row.status) as GoalDispatch['status'], ...(row.turn_id ? { turnId: String(row.turn_id) } : {}) }; }
