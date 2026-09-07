import { randomUUID } from 'node:crypto';
import type {
  GoalDispatch,
  GoalEvent,
  GoalRuntimeErrorInput,
  GoalSnapshot,
  JudgeResultInput,
  RoundClaimInput,
  RoundSettlementInput,
} from '../agentData/goalContracts';
import type { GoalJudgeInput, GoalJudgeVerdict } from './goalJudge';

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
  sessionId: string;
  goalId: string;
  revision: number;
  turnId?: string;
  evidence: string;
}

export interface GoalDataPort {
  get(sessionId: string): Promise<GoalSnapshot | undefined> | GoalSnapshot | undefined;
  update(input: { sessionId: string; goalId: string; revision: number; action: 'resume' | 'begin_judging'; origin: 'system'; payload?: Record<string, unknown> }): Promise<GoalSnapshot> | GoalSnapshot;
  claimRound(input: RoundClaimInput): Promise<GoalDispatch> | GoalDispatch;
  settleRound(input: RoundSettlementInput): Promise<{ snapshot: GoalSnapshot; dispatch: GoalDispatch }> | { snapshot: GoalSnapshot; dispatch: GoalDispatch };
  judgeResult(input: JudgeResultInput): Promise<GoalSnapshot> | GoalSnapshot;
  runtimeError?(input: GoalRuntimeErrorInput): Promise<GoalSnapshot> | GoalSnapshot;
}

export interface GoalWorkerPort {
  enqueueGoalTurn(input: {
    workspace: string;
    sessionId: string;
    sessionPath?: string;
    turnId: string;
    goal: GoalTurnMeta & { condition: string };
  }): Promise<void> | void;
  closeGoalWorker?(sessionId: string): Promise<void> | void;
}

export interface GoalJudgePort {
  judge(input: GoalJudgeInput): Promise<GoalJudgeVerdict>;
}

export interface GoalCoordinatorOptions {
  data: GoalDataPort;
  worker?: GoalWorkerPort;
  judge?: GoalJudgePort;
  onGoalChanged?: (snapshot: GoalSnapshot) => void;
}

/**
 * Owns automatic Goal progression. It deliberately has no renderer or Pi
 * extension dependency: AgentData is the state machine, this class is only
 * the side-effect coordinator around committed CAS transitions.
 */
export class GoalCoordinator {
  private readonly dispatches = new Map<string, Promise<void>>();
  private readonly judges = new Map<string, Promise<void>>();
  private readonly waitingForTurn = new Set<string>();
  private stopped = false;

  constructor(private readonly options: GoalCoordinatorOptions) {}

  /** Called only after a GoalStore event has committed. */
  onGoalChanged(snapshot: GoalSnapshot, event?: Pick<GoalEvent, 'kind' | 'payload'>): void {
    if (this.stopped) return;
    this.options.onGoalChanged?.(snapshot);
    if (snapshot.status === 'active' && (!event || event.kind === 'create' || event.kind === 'resume')) {
      this.waitingForTurn.add(snapshot.sessionId);
      // Let the current human turn finish first when one exists. The worker
      // implementation may queue this dispatch; the microtask also supports
      // goals created from the session UI while idle.
      queueMicrotask(() => { void this.dispatchNext(snapshot); });
    }
    if (event?.kind === 'begin_judging' || snapshot.status === 'judging') {
      const evidence = typeof event?.payload?.evidence === 'string' ? event.payload.evidence : '';
      void this.startJudge({ sessionId: snapshot.sessionId, goalId: snapshot.goalId, revision: snapshot.revision, evidence });
    }
  }

  async onTurnCompleted(input: GoalTurnCompleted): Promise<void> {
    if (this.stopped) return;
    const current = await this.options.data.get(input.sessionId);
    if (!current) return;

    if (input.goal) {
      // A late event from an old revision must be a no-op. Never settle a new
      // generation merely because its session shares the same workspace.
      if (current.goalId !== input.goal.goalId || current.revision !== input.goal.revision) return;
      if (input.status !== 'completed') {
        await this.failRuntime(current, input.summary || `Goal turn ${input.status}`, input.turnId);
        return;
      }
      const settled = await this.options.data.settleRound({
        sessionId: input.sessionId,
        goalId: input.goal.goalId,
        revision: input.goal.revision,
        idempotencyKey: input.goal.idempotencyKey,
        turnId: input.turnId,
        summary: bound(input.summary, 4000),
      });
      this.options.onGoalChanged?.(settled.snapshot);
      this.waitingForTurn.delete(input.sessionId);
      if (settled.snapshot.status === 'active') await this.dispatchNext(settled.snapshot);
      return;
    }

    // A human turn may have created/resumed a Goal. Only the session that
    // caused the event is eligible for the pending dispatch.
    if (this.waitingForTurn.has(input.sessionId) && current.status === 'active') {
      await this.dispatchNext(current);
    }
  }

  async onCompletionRequested(input: GoalCompletionRequest): Promise<void> {
    if (this.stopped) return;
    const current = await this.options.data.get(input.sessionId);
    if (!current || current.goalId !== input.goalId || current.revision !== input.revision) return;
    if (current.status === 'active') {
      const judging = await this.options.data.update({
        sessionId: input.sessionId, goalId: input.goalId, revision: input.revision,
        action: 'begin_judging', origin: 'system', payload: { evidence: bound(input.evidence, 32_000) },
      });
      this.options.onGoalChanged?.(judging);
      await this.startJudge({ ...input, revision: judging.revision, evidence: input.evidence });
      return;
    }
    if (current.status === 'judging') await this.startJudge(input);
  }

  async resume(input: { sessionId: string; goalId: string; revision: number }): Promise<GoalSnapshot> {
    const snapshot = await this.options.data.update({ ...input, action: 'resume', origin: 'system' });
    this.options.onGoalChanged?.(snapshot);
    return snapshot;
  }

  async onWorkspaceDeleted(workspace: string): Promise<void> {
    const sessions = [...this.waitingForTurn];
    for (const sessionId of sessions) {
      // Worker implementations own the workspace lookup; a failed close must
      // not prevent other session workers from being released.
      try { await this.options.worker?.closeGoalWorker?.(sessionId); } catch { /* best effort during deletion */ }
    }
    void workspace;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.dispatches.values(), ...this.judges.values()]);
    this.dispatches.clear();
    this.judges.clear();
    this.waitingForTurn.clear();
  }

  private async dispatchNext(snapshot: GoalSnapshot): Promise<void> {
    if (this.stopped || snapshot.status !== 'active' || !this.options.worker) return;
    const nextRound = snapshot.roundsUsed + 1;
    if (nextRound > snapshot.maxRounds) return;
    const idempotencyKey = `${snapshot.goalId}:${snapshot.revision}:${nextRound}`;
    const existing = this.dispatches.get(idempotencyKey);
    if (existing) return existing;
    const work = this.dispatchNextOnce(snapshot, nextRound, idempotencyKey);
    this.dispatches.set(idempotencyKey, work);
    try { await work; } finally { if (this.dispatches.get(idempotencyKey) === work) this.dispatches.delete(idempotencyKey); }
  }

  private async dispatchNextOnce(snapshot: GoalSnapshot, nextRound: number, idempotencyKey: string): Promise<void> {
    const turnId = randomUUID();
    const claimed = await this.options.data.claimRound({
      sessionId: snapshot.sessionId, goalId: snapshot.goalId, revision: snapshot.revision,
      nextRound, idempotencyKey, workspace: snapshot.workspace, origin: 'goal_automatic',
      promptDigest: digest(snapshot.condition), continuousIntent: true, turnId,
    });
    if (claimed.status !== 'claimed' || (claimed.turnId && claimed.turnId !== turnId)) return;
    try {
      await this.options.worker!.enqueueGoalTurn({
        workspace: snapshot.workspace, sessionId: snapshot.sessionId, turnId,
        goal: { goalId: snapshot.goalId, revision: snapshot.revision, nextRound, idempotencyKey, condition: snapshot.condition },
      });
    } catch (error) {
      await this.failRuntime(snapshot, error instanceof Error ? error.message : String(error), turnId);
    }
  }

  private async startJudge(input: GoalCompletionRequest): Promise<void> {
    const key = `${input.goalId}:${input.revision}`;
    const prior = this.judges.get(key);
    if (prior) return prior;
    const work = this.judgeOnce(input);
    this.judges.set(key, work);
    try { await work; } finally { if (this.judges.get(key) === work) this.judges.delete(key); }
  }

  private async judgeOnce(input: GoalCompletionRequest): Promise<void> {
    let result: GoalJudgeVerdict = { verdict: 'error', reason: 'JUDGE_UNAVAILABLE', missing: [] };
    try {
      result = this.options.judge
        ? await this.options.judge.judge({ condition: (await this.options.data.get(input.sessionId))?.condition ?? '', evidence: bound(input.evidence, 32_000), goalId: input.goalId, sessionId: input.sessionId })
        : result;
    } catch (error) {
      result = { verdict: 'error', reason: error instanceof Error ? error.message : 'JUDGE_UNAVAILABLE', missing: [] };
    }
    const current = await this.options.data.get(input.sessionId);
    if (!current || current.goalId !== input.goalId || current.revision !== input.revision || current.status !== 'judging') return;
    const judged = await this.options.data.judgeResult({
      sessionId: input.sessionId, goalId: input.goalId, revision: input.revision,
      verdict: result.verdict, reason: bound(result.reason, 4000), missing: result.missing,
      ...(result.blockageFingerprint ? { fingerprint: result.blockageFingerprint } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}), model: 'goal_judge',
    });
    this.options.onGoalChanged?.(judged);
  }

  private async failRuntime(snapshot: GoalSnapshot, reason: string, turnId?: string): Promise<void> {
    if (!this.options.data.runtimeError) return;
    try {
      const failed = await this.options.data.runtimeError({ sessionId: snapshot.sessionId, goalId: snapshot.goalId, revision: snapshot.revision, reason: bound(reason, 4000), ...(turnId ? { turnId } : {}) });
      this.options.onGoalChanged?.(failed);
    } catch { /* stale revision or persistence failure: keep the original audit trail */ }
  }
}

function bound(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function digest(value: string): string {
  // This is intentionally a non-secret, stable dispatch hint. The full goal
  // condition remains in the Goal snapshot and is never used as a key.
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
