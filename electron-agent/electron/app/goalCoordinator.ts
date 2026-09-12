import { randomUUID } from 'node:crypto';
import type { GoalJudgeInput, GoalJudgeVerdict } from './goalJudge';

/** Task 14/15 boundary: local stubs after AgentData Goal contracts were removed. */
export type GoalStatus = 'active' | 'paused' | 'disarmed' | 'judging' | 'blocked' | 'complete' | 'error' | 'cleared';
export interface GoalSnapshot {
  goalId: string; sessionId: string; workspace: string; revision: number; condition: string; status: GoalStatus;
  roundsUsed: number; maxRounds: number; createdAt: string; updatedAt: string;
}
export interface GoalEvent {
  id?: string; goalId: string; sessionId: string; revision: number; kind: string; payload: Record<string, unknown>;
}
export interface GoalDispatch {
  idempotencyKey: string; goalId: string; revision: number; nextRound: number;
  status: 'claimed' | 'queued' | 'settled' | 'failed'; turnId?: string;
}
export interface RoundClaimInput {
  sessionId: string; goalId: string; revision: number; nextRound: number; idempotencyKey: string;
  workspace?: string; origin?: string; promptDigest?: string; continuousIntent?: boolean; turnId?: string;
}
export interface RoundSettlementInput { sessionId: string; goalId: string; revision: number; idempotencyKey: string; turnId: string; summary: string }
export interface RoundCancelInput { sessionId: string; goalId: string; revision: number; idempotencyKey: string; turnId?: string; reason: string }
export interface JudgeResultInput { sessionId: string; goalId: string; revision: number; verdict: 'pass' | 'fail' | 'error'; reason: string; missing?: string[]; fingerprint?: string; turnId?: string; model?: string }
export interface GoalRuntimeErrorInput { sessionId: string; goalId: string; revision: number; reason: string; turnId?: string }

export interface GoalTurnMeta {
  goalId: string;
  revision: number;
  nextRound: number;
  idempotencyKey: string;
}

export interface GoalTurnCompleted {
  workspace: string;
  sessionId: string;
  sessionPath?: string;
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  goal?: GoalTurnMeta;
}

export interface GoalCompletionRequest {
  workspace?: string;
  sessionId: string;
  goalId: string;
  revision: number;
  turnId?: string;
  evidence: string;
}

export interface GoalDataPort {
  get(sessionId: string): Promise<GoalSnapshot | undefined> | GoalSnapshot | undefined;
  update(input: { sessionId: string; goalId: string; revision: number; action: 'resume' | 'begin_judging'; origin: 'human-ui' | 'system'; payload?: Record<string, unknown> }): Promise<GoalSnapshot> | GoalSnapshot;
  claimRound(input: RoundClaimInput): Promise<GoalDispatch> | GoalDispatch;
  settleRound(input: RoundSettlementInput): Promise<{ snapshot: GoalSnapshot; dispatch: GoalDispatch }> | { snapshot: GoalSnapshot; dispatch: GoalDispatch };
  judgeResult(input: JudgeResultInput): Promise<GoalSnapshot> | GoalSnapshot;
  runtimeError?(input: GoalRuntimeErrorInput): Promise<GoalSnapshot> | GoalSnapshot;
  /** Release a claimed round by idempotency key; required to survive a worker crash. */
  cancelRound?(input: RoundCancelInput): Promise<GoalDispatch | null | undefined> | GoalDispatch | null | undefined;
}

export interface GoalWorkerPort {
  enqueueGoalTurn(input: {
    workspace: string;
    sessionId: string;
    sessionPath?: string;
    turnId: string;
    goal: GoalTurnMeta & { condition: string };
  }): Promise<void> | void;
  closeGoalWorker?(sessionId: string, workspace?: string): Promise<void> | void;
}

export interface GoalJudgePort {
  judge(input: GoalJudgeInput): Promise<GoalJudgeVerdict>;
}

export interface GoalCoordinatorOptions {
  data: GoalDataPort;
  worker?: GoalWorkerPort;
  judge?: GoalJudgePort;
  onGoalChanged?: (snapshot: GoalSnapshot) => void | Promise<void>;
}

/**
 * Owns automatic Goal progression. It deliberately has no renderer or Pi
 * extension dependency: AgentData is the state machine, this class is only
 * the side-effect coordinator around committed CAS transitions.
 */
export class GoalCoordinator {
  private readonly dispatches = new Map<string, Promise<void>>();
  private readonly judges = new Map<string, Promise<void>>();
  // AgentData owns Goals by session id alone (see GoalSnapshot). The runtime
  // boundary also accepts unverified session ids from callbacks, so keep every
  // coordinator map on the composite key and never act on a foreign workspace.
  private readonly waitingForTurn = new Map<string, string>();
  // Evidence is scoped to one session's exact Goal generation. This prevents
  // replayed or late events from borrowing text from another revision.
  private readonly latestEvidence = new Map<string, string>();
  private stopped = false;

  constructor(private readonly options: GoalCoordinatorOptions) {}

  /** Called only after a GoalStore event has committed. */
  onGoalChanged(snapshot: GoalSnapshot, event?: Pick<GoalEvent, 'kind' | 'payload'> & Partial<Pick<GoalEvent, 'goalId' | 'sessionId' | 'revision'>>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const eventMatchesSnapshot = !event
      || (event.goalId === undefined && event.sessionId === undefined && event.revision === undefined)
      || (event.goalId === snapshot.goalId && event.sessionId === snapshot.sessionId && event.revision === snapshot.revision);
    // Do not project or trigger side effects for an event from an older Goal
    // generation. The renderer also filters stale revisions, but the
    // coordinator must not rely on that cache-level safeguard.
    if (!eventMatchesSnapshot) return Promise.resolve();
    const work: Promise<unknown>[] = [];
    this.project(snapshot);
    const sessionKey = coordinatorSessionKey(snapshot.workspace, snapshot.sessionId);
    if (snapshot.status === 'active' && (!event || event.kind === 'create' || event.kind === 'resume')) {
      this.waitingForTurn.set(sessionKey, snapshot.workspace);
      // Let the current human turn finish first when one exists. The worker
      // implementation may queue this dispatch; the microtask also supports
      // goals created from the session UI while idle.
      work.push(new Promise<void>((resolve, reject) => {
        queueMicrotask(() => { void this.dispatchNext(snapshot).then(resolve, reject); });
      }));
    }
    const judgingEventMatches = event?.kind === 'begin_judging'
      && event.goalId === snapshot.goalId
      && event.sessionId === snapshot.sessionId
      && event.revision === snapshot.revision;
    if (snapshot.status === 'judging' && (!event || judgingEventMatches)) {
      const key = evidenceKey(snapshot.workspace, snapshot.sessionId, snapshot.goalId, snapshot.revision);
      const eventEvidence = typeof event?.payload?.evidence === 'string' ? event.payload.evidence : undefined;
      const evidence = eventEvidence ?? this.latestEvidence.get(key) ?? '';
      // A replayed generation is one-shot; never leave it available to a
      // later event for this session.
      this.latestEvidence.delete(key);
      work.push(this.startJudge({ workspace: snapshot.workspace, sessionId: snapshot.sessionId, goalId: snapshot.goalId, revision: snapshot.revision, evidence }));
    }
    return Promise.all(work).then(() => undefined);
  }

  async onTurnCompleted(input: GoalTurnCompleted): Promise<void> {
    if (this.stopped) return;
    let current: GoalSnapshot | undefined;
    try { current = await this.options.data.get(input.sessionId); } catch { await this.closeWorker(input.sessionId, input.workspace); return; }
    if (!current) { await this.closeWorker(input.sessionId, input.workspace); return; }

    // A turn settlement from another workspace is stale even when its
    // session/goal identifiers happen to match. Never mutate this Goal from
    // that callback; release only the reported worker.
    if (current.workspace !== input.workspace) {
      if (input.goal) this.clearEvidenceForGeneration(input.workspace, input.sessionId, input.goal.goalId, input.goal.revision);
      await this.closeStaleWorker(input.sessionId, input.workspace);
      return;
    }

    if (input.goal) {
      // A late event from an old revision must be a no-op. Never settle a new
      // generation merely because its session shares the same workspace.
      if (current.goalId !== input.goal.goalId || current.revision !== input.goal.revision) {
        this.clearEvidenceForGeneration(input.workspace, input.sessionId, input.goal.goalId, input.goal.revision);
        // The snapshot moved on, so no state transition applies. The stale
        // generation still owns a claimed lease: releasing it is the only way
        // a Goal recovers after a crashed or cancelled turn.
        if (input.status !== 'completed') await this.cancelLease(input, input.summary || `Goal turn ${input.status}`);
        // A worker is shared by all turns in one session. A late old
        // generation cannot be distinguished from the live generation by the
        // session-scoped key, so never close the current worker here.
        return;
      }
      if (input.status !== 'completed') {
        this.clearEvidenceForGeneration(input.workspace, input.sessionId, input.goal.goalId, input.goal.revision);
        // Cancel first: failRuntime only reaches the lease while the live
        // revision still matches, and it bumps the revision when it succeeds.
        await this.cancelLease(input, input.summary || `Goal turn ${input.status}`);
        await this.failRuntime(current, input.summary || `Goal turn ${input.status}`, input.turnId);
        await this.closeWorker(input.sessionId, current.workspace);
        return;
      }
      let settled: Awaited<ReturnType<GoalDataPort['settleRound']>>;
      try {
        settled = await this.options.data.settleRound({
          sessionId: input.sessionId,
          goalId: input.goal.goalId,
          revision: input.goal.revision,
          idempotencyKey: input.goal.idempotencyKey,
          turnId: input.turnId,
          summary: bound(input.summary, 4000),
        });
      } catch (error) {
        await this.cancelLease(input, errorText(error));
        await this.failRuntime(current, errorText(error), input.turnId);
        this.clearEvidenceForGeneration(input.workspace, input.sessionId, input.goal.goalId, input.goal.revision);
        await this.closeWorker(input.sessionId, current.workspace);
        return;
      }
      const key = evidenceKey(input.workspace, input.sessionId, input.goal.goalId, input.goal.revision);
      this.latestEvidence.set(key, bound(input.summary, 32_000));
      this.project(settled.snapshot);
      this.waitingForTurn.delete(coordinatorSessionKey(input.workspace, input.sessionId));
      // settleRound normally advances revision. Once it does, the old
      // generation has no valid evidence consumer.
      if (settled.snapshot.goalId !== input.goal.goalId || settled.snapshot.revision !== input.goal.revision) {
        this.latestEvidence.delete(key);
      }
      if (settled.snapshot.status === 'active') await this.dispatchNext(settled.snapshot);
      else await this.closeWorker(input.sessionId, settled.snapshot.workspace);
      return;
    }

    // A human turn may have created/resumed a Goal. Only the session that
    // caused the event is eligible for the pending dispatch.
    if (this.waitingForTurn.has(coordinatorSessionKey(input.workspace, input.sessionId)) && current.status === 'active') {
      await this.dispatchNext(current);
    }
  }

  async onCompletionRequested(input: GoalCompletionRequest): Promise<void> {
    if (this.stopped) return;
    let current: GoalSnapshot | undefined;
    try { current = await this.options.data.get(input.sessionId); } catch { return; }
    if (!current || current.goalId !== input.goalId || current.revision !== input.revision || (input.workspace !== undefined && current.workspace !== input.workspace)) {
      this.clearEvidenceForGeneration(input.workspace, input.sessionId, input.goalId, input.revision);
      return;
    }
    const workspace = current.workspace;
    const key = evidenceKey(workspace, input.sessionId, input.goalId, input.revision);
    const evidence = input.evidence.trim() ? input.evidence : this.latestEvidence.get(key) ?? '';
    // Completion requests consume pending evidence for this exact generation.
    this.latestEvidence.delete(key);
    if (current.status === 'active') {
      let judging: GoalSnapshot;
      try {
        judging = await this.options.data.update({
          sessionId: input.sessionId, goalId: input.goalId, revision: input.revision,
          action: 'begin_judging', origin: 'system', payload: { evidence: bound(evidence, 32_000) },
        });
      } catch { return; }
      this.project(judging);
      await this.startJudge({ ...input, workspace, revision: judging.revision, evidence });
      return;
    }
    if (current.status === 'judging') await this.startJudge({ ...input, workspace, evidence });
  }

  async resume(input: { sessionId: string; goalId: string; revision: number }): Promise<GoalSnapshot> {
    const snapshot = await this.options.data.update({ ...input, action: 'resume', origin: 'human-ui' });
    this.project(snapshot);
    return snapshot;
  }

  async onWorkspaceDeleted(workspace: string): Promise<void> {
    const sessions = [...this.waitingForTurn.entries()]
      .filter(([, owner]) => owner === workspace)
      .map(([key]) => coordinatorSessionId(key));
    for (const sessionId of sessions) {
      // Worker implementations own the workspace lookup; a failed close must
      // not prevent other session workers from being released.
      await this.closeWorker(sessionId, workspace);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.dispatches.values(), ...this.judges.values()]);
    this.dispatches.clear();
    this.judges.clear();
    this.waitingForTurn.clear();
    this.latestEvidence.clear();
  }

  private async dispatchNext(snapshot: GoalSnapshot): Promise<void> {
    if (this.stopped || snapshot.status !== 'active' || !this.options.worker) return;
    const nextRound = snapshot.roundsUsed + 1;
    if (nextRound > snapshot.maxRounds) return;
    const idempotencyKey = `${snapshot.goalId}:${snapshot.revision}:${nextRound}`;
    const dispatchKey = `${coordinatorSessionKey(snapshot.workspace, snapshot.sessionId)}\0${idempotencyKey}`;
    const existing = this.dispatches.get(dispatchKey);
    if (existing) return existing;
    const work = this.dispatchNextOnce(snapshot, nextRound, idempotencyKey);
    this.dispatches.set(dispatchKey, work);
    try { await work; } finally { if (this.dispatches.get(dispatchKey) === work) this.dispatches.delete(dispatchKey); }
  }

  private async dispatchNextOnce(snapshot: GoalSnapshot, nextRound: number, idempotencyKey: string): Promise<void> {
    const turnId = randomUUID();
    let claimed: GoalDispatch;
    try {
      claimed = await this.options.data.claimRound({
        sessionId: snapshot.sessionId, goalId: snapshot.goalId, revision: snapshot.revision,
        nextRound, idempotencyKey, workspace: snapshot.workspace, origin: 'goal_automatic',
        promptDigest: digest(snapshot.condition), continuousIntent: true, turnId,
      });
    } catch (error) {
      await this.failRuntime(snapshot, errorText(error), turnId);
      await this.closeWorker(snapshot.sessionId, snapshot.workspace);
      return;
    }
    if (claimed.status !== 'claimed' || (claimed.turnId && claimed.turnId !== turnId)) return;
    try {
      await this.options.worker!.enqueueGoalTurn({
        workspace: snapshot.workspace, sessionId: snapshot.sessionId, turnId,
        goal: { goalId: snapshot.goalId, revision: snapshot.revision, nextRound, idempotencyKey, condition: snapshot.condition },
      });
    } catch (error) {
      await this.failRuntime(snapshot, error instanceof Error ? error.message : String(error), turnId);
      await this.closeWorker(snapshot.sessionId, snapshot.workspace);
    }
  }

  private async startJudge(input: GoalCompletionRequest): Promise<void> {
    const key = evidenceKey(input.workspace ?? '', input.sessionId, input.goalId, input.revision);
    const prior = this.judges.get(key);
    if (prior) return prior;
    const work = this.judgeOnce(input);
    this.judges.set(key, work);
    try { await work; } finally { if (this.judges.get(key) === work) this.judges.delete(key); }
  }

  private async judgeOnce(input: GoalCompletionRequest): Promise<void> {
    // Validate the replay/request against the live snapshot before invoking a
    // model. A persisted event can outlive its Goal generation after restart.
    let current: GoalSnapshot | undefined;
    try {
      current = await this.options.data.get(input.sessionId);
    } catch {
      this.clearEvidenceForGeneration(input.workspace, input.sessionId, input.goalId, input.revision);
      return;
    }
    if (!current || current.goalId !== input.goalId || current.revision !== input.revision || current.status !== 'judging') {
      this.clearEvidenceForGeneration(input.workspace, input.sessionId, input.goalId, input.revision);
      // A same-workspace stale replay shares the live worker key. Only close
      // a worker when the callback is explicitly from another workspace.
      if (input.workspace !== undefined && current && current.workspace !== input.workspace) {
        await this.closeStaleWorker(input.sessionId, input.workspace);
      }
      return;
    }

    let result: GoalJudgeVerdict = { verdict: 'error', reason: 'JUDGE_UNAVAILABLE', missing: [] };
    try {
      result = this.options.judge
        ? await this.options.judge.judge({ condition: current.condition, evidence: bound(input.evidence, 32_000), goalId: input.goalId, sessionId: input.sessionId, revision: input.revision })
        : result;
    } catch (error) {
      result = { verdict: 'error', reason: error instanceof Error ? error.message : 'JUDGE_UNAVAILABLE', missing: [] };
    }
    try {
      current = await this.options.data.get(input.sessionId);
    } catch {
      this.clearEvidenceForGeneration(input.workspace, input.sessionId, input.goalId, input.revision);
      return;
    }
    if (!current || current.goalId !== input.goalId || current.revision !== input.revision || current.status !== 'judging') {
      this.clearEvidenceForGeneration(input.workspace, input.sessionId, input.goalId, input.revision);
      if (input.workspace !== undefined && current && current.workspace !== input.workspace) {
        await this.closeStaleWorker(input.sessionId, input.workspace);
      }
      return;
    }
    let judged: GoalSnapshot;
    try {
      judged = await this.options.data.judgeResult({
        sessionId: input.sessionId, goalId: input.goalId, revision: input.revision,
        verdict: result.verdict, reason: bound(result.reason, 4000), missing: result.missing,
        ...(result.blockageFingerprint ? { fingerprint: result.blockageFingerprint } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}), model: 'goal_judge',
      });
    } catch (error) {
      // A judge response is not complete until its result is durably written.
      // Preserve the failure as a runtime error when the live revision still
      // matches; if persistence itself is unavailable, close the worker and
      // leave the original judging snapshot for recovery/audit.
      await this.failRuntime(current, `judge result persistence failed: ${errorText(error)}`, input.turnId);
      await this.closeWorker(input.sessionId, current.workspace);
      return;
    }
    this.project(judged);
    await this.closeWorker(input.sessionId, judged.workspace);
  }

  /**
   * Release the AgentData lease for one reported turn. Cancellation is keyed by
   * the turn's own idempotency key, so it works for a generation whose revision
   * has already advanced. A rejected cancellation keeps the claim for audit.
   */
  private async cancelLease(input: GoalTurnCompleted, reason: string): Promise<void> {
    const cancel = this.options.data.cancelRound;
    if (!cancel || !input.goal) return;
    try {
      await cancel.call(this.options.data, {
        sessionId: input.sessionId,
        goalId: input.goal.goalId,
        revision: input.goal.revision,
        idempotencyKey: input.goal.idempotencyKey,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        reason: bound(reason, 4000),
      });
    } catch { /* already settled, mismatched turn, or persistence failure */ }
  }

  private async failRuntime(snapshot: GoalSnapshot, reason: string, turnId?: string): Promise<void> {
    if (!this.options.data.runtimeError) return;
    try {
      const failed = await this.options.data.runtimeError({ sessionId: snapshot.sessionId, goalId: snapshot.goalId, revision: snapshot.revision, reason: bound(reason, 4000), ...(turnId ? { turnId } : {}) });
      this.project(failed);
    } catch { /* stale revision or persistence failure: keep the original audit trail */ }
  }

  private async closeWorker(sessionId: string, workspace?: string): Promise<void> {
    if (workspace === undefined) {
      for (const key of this.waitingForTurn.keys()) if (key.endsWith(`${EVIDENCE_SEPARATOR}${sessionId}`)) this.waitingForTurn.delete(key);
    } else this.waitingForTurn.delete(coordinatorSessionKey(workspace, sessionId));
    this.clearEvidenceForSession(sessionId, workspace);
    try {
      const close = this.options.worker?.closeGoalWorker;
      if (close) {
        if (workspace === undefined) await close.call(this.options.worker, sessionId);
        else await close.call(this.options.worker, sessionId, workspace);
      }
    } catch { /* best effort after a terminal turn */ }
  }

  /** Renderer updates are projections; a transient UI failure must not keep a
   * committed AgentData event pending or stop Goal progression. */
  private project(snapshot: GoalSnapshot): void {
    try { void this.options.onGoalChanged?.(snapshot); } catch { /* best effort */ }
  }

  /** Close an obsolete worker without touching state for the live generation. */
  private async closeStaleWorker(sessionId: string, workspace?: string): Promise<void> {
    if (workspace === undefined) return;
    try {
      const close = this.options.worker?.closeGoalWorker;
      if (close) {
        await close.call(this.options.worker, sessionId, workspace);
      }
    } catch { /* best effort for stale callbacks */ }
  }

  private clearEvidenceForGeneration(workspace: string | undefined, sessionId: string, goalId: string, revision: number): void {
    if (workspace !== undefined) this.latestEvidence.delete(evidenceKey(workspace, sessionId, goalId, revision));
    else {
      for (const key of this.latestEvidence.keys()) {
        const parts = key.split(EVIDENCE_SEPARATOR);
        if (parts[1] === sessionId && parts[2] === goalId && parts[3] === String(revision)) this.latestEvidence.delete(key);
      }
    }
  }

  private clearEvidenceForSession(sessionId: string, workspace?: string): void {
    const prefix = workspace === undefined ? undefined : `${workspace}${EVIDENCE_SEPARATOR}${sessionId}${EVIDENCE_SEPARATOR}`;
    for (const key of this.latestEvidence.keys()) {
      if (prefix ? key.startsWith(prefix) : key.split(EVIDENCE_SEPARATOR)[1] === sessionId) this.latestEvidence.delete(key);
    }
  }
}

const EVIDENCE_SEPARATOR = '\u0000';

function coordinatorSessionKey(workspace: string, sessionId: string): string {
  return `${workspace}${EVIDENCE_SEPARATOR}${sessionId}`;
}

function coordinatorSessionId(key: string): string {
  const separator = key.lastIndexOf(EVIDENCE_SEPARATOR);
  return separator < 0 ? key : key.slice(separator + 1);
}

function evidenceKey(workspace: string, sessionId: string, goalId: string, revision: number): string {
  return `${workspace}${EVIDENCE_SEPARATOR}${sessionId}${EVIDENCE_SEPARATOR}${goalId}${EVIDENCE_SEPARATOR}${revision}`;
}

function bound(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function digest(value: string): string {
  // This is intentionally a non-secret, stable dispatch hint. The full goal
  // condition remains in the Goal snapshot and is never used as a key.
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
