import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GoalCasUpdate, GoalDispatch, GoalEvent, GoalJudgeRecord, GoalSnapshot, GoalStatus, CreateGoalInput, RoundClaimInput, RoundSettlementInput, JudgeResultInput, ForkGoalInput } from './goalContracts';

export const DEFAULT_MAX_ROUNDS = 256;
export type GoalPublish = (event: GoalEvent) => void;

function validateMaxRounds(value: number | undefined): number {
  const max = value ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isSafeInteger(max) || max <= 0) throw new Error('INVALID_MAX_ROUNDS');
  return max;
}

export class GoalStore {
  private readonly listeners = new Set<GoalPublish>();
  private pending: GoalEvent[];
  constructor(readonly db: DatabaseSync, publish?: GoalPublish) {
    if (publish) this.listeners.add(publish);
    this.pending = (this.db.prepare('SELECT * FROM goal_events WHERE published_at IS NULL ORDER BY created_at,rowid').all() as Array<Record<string, unknown>>).map(mapEvent);
    this.recoverActiveGoals();
  }

  onPublish(listener: GoalPublish): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  replay(): void { this.publishPending(); }

  get(sessionId: string): GoalSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM goal_snapshots WHERE session_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(sessionId) as Record<string, unknown> | undefined;
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
      const now = new Date().toISOString(); const snapshot: GoalSnapshot = { goalId: randomUUID(), sessionId: input.sessionId, workspace: input.workspace, revision: 1, condition: input.condition, status: 'active', roundsUsed: 0, maxRounds, createdAt: now, updatedAt: now };
      this.persist(snapshot); this.event(snapshot, 'create', { origin: input.origin, ...(input.continuousIntentEvidence ? { continuousIntentEvidence: input.continuousIntentEvidence } : {}) }); return snapshot;
    });
  }

  update(input: GoalCasUpdate): GoalSnapshot {
    return this.tx(() => {
      const hasMaxRounds = Boolean(input.payload && Object.prototype.hasOwnProperty.call(input.payload, 'maxRounds'));
      const hasCondition = Boolean(input.payload && Object.prototype.hasOwnProperty.call(input.payload, 'condition'));
      if (input.action === 'judge_pass' || input.action === 'judge_fail') throw new Error('INVALID_TRANSITION');
      if ((['pause', 'resume', 'clear'].includes(input.action) || hasMaxRounds || hasCondition) && input.origin !== 'human-ui') throw new Error('HUMAN_AUTH_REQUIRED');
      const current = this.require(input.sessionId, input.goalId); assertRevision(current, input.goalId, input.revision);
      const next = transition(current, input.action, input.payload);
      if (hasMaxRounds) {
        const maxRounds = validateMaxRounds(Number(input.payload.maxRounds));
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
      const dispatch: GoalDispatch = { idempotencyKey: canonicalKey, goalId: input.goalId, revision: input.revision, nextRound: input.nextRound, status: 'claimed' };
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO goal_turn_leases(
        idempotency_key,goal_id,session_id,revision,next_round,status,turn_id,workspace,origin,prompt_digest,continuous_intent,summary,error,created_at,claimed_at,settled_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        canonicalKey, input.goalId, input.sessionId, input.revision, input.nextRound, dispatch.status, null,
        input.workspace ?? current.workspace, input.origin ?? 'system', input.promptDigest ?? '', input.continuousIntent ? 1 : 0,
        null, null, now, now, null,
      );
      this.event(current, 'round_claim', { nextRound: input.nextRound }, canonicalKey); return dispatch;
    });
  }

  settleRound(input: RoundSettlementInput): { snapshot: GoalSnapshot; dispatch: GoalDispatch } {
    return this.tx(() => {
      const prior = this.db.prepare('SELECT * FROM goal_turn_leases WHERE idempotency_key=?').get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (prior) assertLeaseMatches(prior, input.sessionId, input.goalId, input.revision);
      if (prior && String(prior.status) === 'settled') return { snapshot: this.require(input.sessionId, input.goalId), dispatch: mapDispatch(prior) };
      const settledByTurn = this.db.prepare("SELECT * FROM goal_turn_leases WHERE goal_id=? AND session_id=? AND turn_id=? AND status='settled' ORDER BY settled_at DESC LIMIT 1").get(input.goalId, input.sessionId, input.turnId) as Record<string, unknown> | undefined;
      if (settledByTurn) return { snapshot: this.require(input.sessionId, input.goalId), dispatch: mapDispatch(settledByTurn) };
      const lease = prior ?? this.db.prepare('SELECT * FROM goal_turn_leases WHERE goal_id=? AND revision=? AND turn_id=?').get(input.goalId, input.revision, input.turnId) as Record<string, unknown> | undefined;
      if (!lease) throw new Error('ROUND_NOT_CLAIMED');
      assertLeaseMatches(lease, input.sessionId, input.goalId, input.revision);
      const current = this.require(input.sessionId, input.goalId); assertRevision(current, input.goalId, input.revision);
      const roundsUsed = current.roundsUsed + 1; let next = { ...current, roundsUsed, updatedAt: new Date().toISOString() };
      if (roundsUsed >= current.maxRounds) { next = { ...next, status: 'paused', revision: current.revision + 1, stopReason: { kind: 'max_rounds', summary: '达到最大轮数', at: next.updatedAt } }; }
      this.persist(next);
      const updated = this.db.prepare('UPDATE goal_turn_leases SET status=\'settled\',turn_id=?,summary=?,settled_at=? WHERE idempotency_key=? AND status<>\'settled\'').run(input.turnId, input.summary, next.updatedAt, String(lease.idempotency_key));
      if (Number(updated.changes)) this.event(next, 'round_settle', { nextRound: Number(lease.next_round), turnId: input.turnId, summary: input.summary }, `${String(lease.idempotency_key)}:settle`);
      const finalLease = this.db.prepare('SELECT * FROM goal_turn_leases WHERE idempotency_key=?').get(String(lease.idempotency_key)) as Record<string, unknown>;
      return { snapshot: next, dispatch: mapDispatch(finalLease) };
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
      const existing = this.db.prepare("SELECT 1 FROM goal_snapshots WHERE session_id=? AND status <> 'cleared'").get(sessionId); if (existing) throw new Error('GOAL_ALREADY_EXISTS');
      const now = new Date().toISOString(); const snapshot: GoalSnapshot = { ...source, goalId: randomUUID(), sessionId, status: 'disarmed', revision: 1, roundsUsed: 0, createdAt: now, updatedAt: now, sourceGoalId: source.goalId, sourceSessionId: source.sessionId, stopReason: undefined, judge: undefined, blockage: undefined, clearedAt: undefined };
      this.persist(snapshot); this.event(snapshot, 'fork', { sourceGoalId: source.goalId, sourceSessionId: source.sessionId }); return snapshot;
    });
  }

  private require(sessionId: string, goalId: string): GoalSnapshot { const row = this.db.prepare('SELECT * FROM goal_snapshots WHERE session_id=? AND goal_id=?').get(sessionId, goalId) as Record<string, unknown> | undefined; if (!row) throw new Error('GOAL_NOT_FOUND'); return mapSnapshot(row); }
  private recoverActiveGoals(): void {
    const rows = this.db.prepare("SELECT * FROM goal_snapshots WHERE status='active' ORDER BY session_id, goal_id").all() as Array<Record<string, unknown>>;
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
  private persist(snapshot: GoalSnapshot): void { this.db.prepare(`INSERT INTO goal_snapshots(goal_id,session_id,workspace,revision,condition,status,rounds_used,max_rounds,created_at,updated_at,stop_reason,judge,blockage,source_goal_id,source_session_id,cleared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET revision=excluded.revision,condition=excluded.condition,status=excluded.status,rounds_used=excluded.rounds_used,max_rounds=excluded.max_rounds,updated_at=excluded.updated_at,stop_reason=excluded.stop_reason,judge=excluded.judge,blockage=excluded.blockage,source_goal_id=excluded.source_goal_id,source_session_id=excluded.source_session_id,cleared_at=excluded.cleared_at`).run(snapshot.goalId,snapshot.sessionId,snapshot.workspace,snapshot.revision,snapshot.condition,snapshot.status,snapshot.roundsUsed,snapshot.maxRounds,snapshot.createdAt,snapshot.updatedAt,json(snapshot.stopReason),json(snapshot.judge),json(snapshot.blockage),snapshot.sourceGoalId ?? null,snapshot.sourceSessionId ?? null,snapshot.clearedAt ?? null); }
  private event(snapshot: GoalSnapshot, kind: string, payload: Record<string, unknown>, idempotencyKey?: string): void { const event: GoalEvent = { id: randomUUID(), goalId: snapshot.goalId, sessionId: snapshot.sessionId, revision: snapshot.revision, kind, payload, ...(idempotencyKey ? { idempotencyKey } : {}), createdAt: new Date().toISOString() }; this.db.prepare('INSERT INTO goal_events(id,goal_id,session_id,revision,kind,payload,idempotency_key,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?)').run(event.id,event.goalId,event.sessionId,event.revision,event.kind,JSON.stringify(event.payload),event.idempotencyKey ?? null,event.createdAt,null); this.pending.push(event); }
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

  private publishPending(): void {
    for (let index = 0; index < this.pending.length;) {
      const event = this.pending[index];
      let delivered = false;
      for (const listener of this.listeners) {
        try { listener(event); delivered = true; } catch { /* retain the event only when nobody received it */ }
      }
      if (!delivered) { index += 1; continue; }
      try {
        this.db.prepare('UPDATE goal_events SET published_at=? WHERE id=?').run(new Date().toISOString(), event.id);
        this.pending.splice(index, 1);
      } catch {
        index += 1;
      }
    }
  }
}

function json(value: unknown): string | null { return value == null ? null : JSON.stringify(value); }
function assertRevision(snapshot: GoalSnapshot, goalId: string, revision: number): void { if (snapshot.goalId !== goalId || snapshot.revision !== revision) throw new Error('VERSION_CONFLICT'); }
function assertLeaseMatches(row: Record<string, unknown>, sessionId: string, goalId: string, revision: number): void {
  if (String(row.session_id) !== sessionId || String(row.goal_id) !== goalId || Number(row.revision) !== revision) throw new Error('IDEMPOTENCY_CONFLICT');
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
function mapSnapshot(row: Record<string, unknown>): GoalSnapshot { return { goalId: String(row.goal_id), sessionId: String(row.session_id), workspace: String(row.workspace), revision: Number(row.revision), condition: String(row.condition), status: String(row.status) as GoalStatus, roundsUsed: Number(row.rounds_used), maxRounds: Number(row.max_rounds), createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(row.stop_reason ? { stopReason: JSON.parse(String(row.stop_reason)) } : {}), ...(row.judge ? { judge: JSON.parse(String(row.judge)) } : {}), ...(row.blockage ? { blockage: JSON.parse(String(row.blockage)) } : {}), ...(row.source_goal_id ? { sourceGoalId: String(row.source_goal_id) } : {}), ...(row.source_session_id ? { sourceSessionId: String(row.source_session_id) } : {}), ...(row.cleared_at ? { clearedAt: String(row.cleared_at) } : {}) }; }
function mapEvent(row: Record<string, unknown>): GoalEvent { return { id: String(row.id), goalId: String(row.goal_id), sessionId: String(row.session_id), revision: Number(row.revision), kind: String(row.kind), payload: JSON.parse(String(row.payload)) as Record<string, unknown>, ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}), createdAt: String(row.created_at), ...(row.published_at ? { publishedAt: String(row.published_at) } : {}) }; }
function mapDispatch(row: Record<string, unknown>): GoalDispatch { return { idempotencyKey: String(row.idempotency_key), goalId: String(row.goal_id), revision: Number(row.revision), nextRound: Number(row.next_round), status: String(row.status) as GoalDispatch['status'], ...(row.turn_id ? { turnId: String(row.turn_id) } : {}) }; }
