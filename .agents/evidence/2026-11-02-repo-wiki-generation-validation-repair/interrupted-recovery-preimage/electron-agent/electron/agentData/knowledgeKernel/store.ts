import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { JobStore, type Job, type JobState } from '../jobStore';
import { resolveKnowledgeUnitBudget } from './executionPolicy';
import { DEFAULT_KNOWLEDGE_BUDGETS, KNOWLEDGE_FRAME_MAX_BYTES, knowledgeBudgetTokens, KNOWLEDGE_TIME_SLICE_MAX_MS, assertKnowledgePayloadSize, executionFenceSchema, parseKnowledgeTaskMetadata, parseStageExecutionResult, parseStartKnowledgeTask, type ExecutionFence, type KnowledgeBudgets, type KnowledgeStageKind, type KnowledgeExecutionPolicyV2, type KnowledgeKey, type KnowledgePhase, type KnowledgeTaskMetadata, type KnowledgeUsage, type PublishClaim, type PublishReceipt, type StageExecutionResult, type StartKnowledgeTask } from '../../../shared/knowledgeKernelContracts';

export function migrateKnowledgeKernel(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_build_items (
    task_id TEXT NOT NULL, phase TEXT NOT NULL, item_id TEXT NOT NULL, state TEXT NOT NULL,
    attempt INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT, payload TEXT,
    evidence TEXT NOT NULL DEFAULT '[]', dependencies TEXT NOT NULL DEFAULT '[]', error TEXT,
    revision INTEGER NOT NULL DEFAULT 0, source_task_id TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY(task_id,phase,item_id));
    CREATE INDEX IF NOT EXISTS knowledge_items_source ON knowledge_build_items(source_task_id);
    CREATE TABLE IF NOT EXISTS knowledge_source_snapshots (
      snapshot_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
      manifest TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_snapshots_task ON knowledge_source_snapshots(task_id);
    CREATE TABLE IF NOT EXISTS knowledge_execution_requests (
      request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, phase TEXT NOT NULL, item_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, fence TEXT NOT NULL,
      reserved TEXT NOT NULL, actual TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_requests_unit ON knowledge_execution_requests(task_id,phase,item_id);
    CREATE TABLE IF NOT EXISTS agent_job_leases (
      scope TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_id TEXT NOT NULL, ledger_id TEXT NOT NULL,
      controller_epoch TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      claim_id TEXT, claim TEXT, pinned INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS agent_job_leases_task ON agent_job_leases(task_id);`);
  const columns = db.prepare('PRAGMA table_info(knowledge_build_items)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'stage_kind')) db.exec('ALTER TABLE knowledge_build_items ADD COLUMN stage_kind TEXT');
}
export const hashKnowledgePayload = (payload: unknown): string => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
export interface CreateKnowledgeTask { workspace: string; key: KnowledgeKey; request: StartKnowledgeTask; pipelineConfigHash: string; budgets?: KnowledgeBudgets; executionPolicy?: KnowledgeExecutionPolicyV2 }
export interface CheckpointRef { taskId: string; phase: KnowledgePhase; itemId: string }
export interface ItemAck extends CheckpointRef { attempt: number; revision: number; outputHash: string }
export interface VerifiedArtifact extends ItemAck { state: string; inputHash: string; payload: unknown; evidence: StageExecutionResult['evidence']; dependencies: StageExecutionResult['dependencies']; sourceTaskId?: string }
export interface FailedCandidate extends VerifiedArtifact { error: NonNullable<StageExecutionResult['error']> }
export interface ExecutionBudgetRequest extends CheckpointRef { requestId: string; attempt: number; fence: ExecutionFence; kind: 'model' | 'tool' | 'time'; reserved: KnowledgeUsage }
export interface ExecutionRequestRecord extends ExecutionBudgetRequest { state: 'reserved' | 'dispatched' | 'unknown' | 'settled' | 'released'; actual?: KnowledgeUsage }
export interface KnowledgeLease { scope: string; taskId: string; fence: ExecutionFence; expiresAt: number; pinned: boolean; claimId?: string }
export interface KnowledgeUsageRecoveryReport { requestId: string; taskId: string; controllerEpoch: string; unknown: boolean; usage?: { input: number; output: number; totalTokens: number; cacheRead?: number; cacheWrite?: number } }
export interface StoredKnowledgeControlRequest { taskId: string; requestId: string; action: 'pause' | 'cancel'; cause: 'user' | 'application_exit'; requestedAt: number }
interface ItemRow { task_id: string; phase: KnowledgePhase; item_id: string; state: string; attempt: number; input_hash: string; output_hash: string | null; payload: string | null; evidence: string; dependencies: string; error: string | null; revision: number; source_task_id: string | null; stage_kind: KnowledgeStageKind | null }
interface Lease { scope: string; task_id: string; owner_id: string; ledger_id: string; controller_epoch: string; generation: number; expires_at: number; pinned: number; claim_id: string | null; claim: string | null }

/** The existing agent_jobs row is the sole task state. Every acknowledged write is fenced in the same transaction. */
export class KnowledgeBuildStore {
  readonly jobs: JobStore;
  readonly ledgerId: string;
  private readonly now: () => number;
  constructor(private readonly db: DatabaseSync, readonly options: { controllerEpoch: string; ledgerId?: string; now?: () => number }) {
    this.jobs = new JobStore(db); migrateKnowledgeKernel(db); this.now = options.now ?? Date.now;
    this.ledgerId = this.transaction(() => {
      const row = db.prepare("SELECT value FROM agent_config WHERE module='knowledge-kernel-ledger'").get() as { value: string } | undefined;
      if (row) return String(JSON.parse(row.value).ledgerId);
      const id = options.ledgerId ?? randomUUID(); db.prepare('INSERT INTO agent_config(module,version,value) VALUES(?,1,?)').run('knowledge-kernel-ledger', JSON.stringify({ ledgerId: id })); return id;
    });
    // Once a controller has restarted, unacknowledged work retains its upper bound.
    db.prepare("UPDATE knowledge_execution_requests SET state='unknown' WHERE state IN ('reserved','dispatched')").run();
  }
  private transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  getTask(taskId: string): Job | undefined { return this.jobs.get(taskId); }
  private task(taskId: string): Job & { metadata: NonNullable<Job['metadata']> & { repoWiki: KnowledgeTaskMetadata } } {
    const job = this.jobs.get(taskId); if (!job?.metadata?.repoWiki || !('confirmExternal' in (job.metadata.payload ?? {})) || (job.metadata.payload as { confirmExternal?: boolean }).confirmExternal !== true) throw new Error('TASK_NOT_FOUND_OR_CONFIRMATION_REQUIRED');
    return job as Job & { metadata: NonNullable<Job['metadata']> & { repoWiki: KnowledgeTaskMetadata } };
  }
  createTask(input: CreateKnowledgeTask): Job {
    const request = parseStartKnowledgeTask(input.request);
    if (input.key.projectId !== request.projectId || input.key.domain !== request.domain || input.key.language !== request.language) throw new Error('IDENTITY_MISMATCH');
    return this.transaction(() => {
      const all = this.jobs.list().filter(j => j.metadata?.repoWiki);
      const previous = all.find(j => j.metadata!.repoWiki!.requestId === request.requestId);
      if (previous) { if (JSON.stringify(previous.metadata!.repoWiki!.key) !== JSON.stringify(input.key) || previous.metadata!.repoWiki!.intent !== request.intent) throw new Error('IDEMPOTENCY_CONFLICT'); return previous; }
      if (all.some(j => ['pending','running','paused','blocked'].includes(j.state) && identity(j.metadata!.repoWiki!.key) === identity(input.key))) throw new Error('TARGET_ACTIVE');
      const origin = request.retryOf ? this.task(request.retryOf) : undefined;
      if (origin && identity(origin.metadata.repoWiki.key) !== identity(input.key)) throw new Error('REPAIR_IDENTITY_MISMATCH');
      const repairOrigin = request.intent === 'repair' ? origin : undefined;
      const metadata = parseKnowledgeTaskMetadata({ version: 1, requestId: request.requestId, key: input.key, intent: request.intent, revision: 0, phase: 'prepare', pipelineConfigHash: repairOrigin?.metadata.repoWiki.pipelineConfigHash ?? input.pipelineConfigHash, ...(repairOrigin ? (repairOrigin.metadata.repoWiki.executionPolicy ? { executionPolicy: structuredClone(repairOrigin.metadata.repoWiki.executionPolicy) } : {}) : (input.executionPolicy ? { executionPolicy: structuredClone(input.executionPolicy) } : {})), modelIdentity: request.expectedModelIdentity, planHash: request.expectedPlanToken, budgets: structuredClone(repairOrigin?.metadata.repoWiki.budgets ?? input.budgets ?? DEFAULT_KNOWLEDGE_BUDGETS), resumePolicy: 'auto', counts: { planned: 0, prepared: 0, failed: 0, blocked: 0, published: 0 } });
      return this.jobs.create({ kind: 'repoWiki.generate', workspace: input.workspace, metadata: { repoWiki: metadata, retryOf: request.retryOf, target: { type: 'repoWiki', id: input.workspace, language: request.language }, payload: { projectId: request.projectId, language: request.language, target: request.domain, force: request.intent === 'regenerate', confirmExternal: true } } });
    });
  }
  claim(scope: string, taskId: string, ownerId: string, diskFloor: number, recovery: { previousExecutorExited?: boolean } = {}): ExecutionFence {
    if (!scope || !ownerId || !Number.isSafeInteger(diskFloor) || diskFloor < 0) throw new Error('INVALID_LEASE');
    return this.transaction(() => {
      const job = this.task(taskId); if (['completed','cancelled'].includes(job.state)) throw new Error('TASK_TERMINAL');
      const current = this.db.prepare('SELECT * FROM agent_job_leases WHERE scope=?').get(scope) as unknown as Lease | undefined;
      if (current?.pinned) throw new Error('PUBLICATION_PINNED');
      if (current && current.expires_at !== 0) {
        if (current.task_id === taskId && current.owner_id === ownerId && current.controller_epoch === this.options.controllerEpoch && current.ledger_id === this.ledgerId && current.generation >= diskFloor && current.expires_at > this.now()) return fenceFrom(current);
        if (current.controller_epoch === this.options.controllerEpoch || !recovery.previousExecutorExited) throw new Error('LEASE_BUSY');
      }
      const maximum = this.db.prepare('SELECT max(generation) n FROM agent_job_leases').get() as { n: number | null };
      const fence = { ledgerId: this.ledgerId, controllerEpoch: this.options.controllerEpoch, ownerId, generation: Math.max(diskFloor, current?.generation ?? 0, maximum.n ?? 0) + 1 };
      this.db.prepare('INSERT INTO agent_job_leases(scope,task_id,owner_id,ledger_id,controller_epoch,generation,expires_at,pinned) VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(scope) DO UPDATE SET task_id=excluded.task_id,owner_id=excluded.owner_id,ledger_id=excluded.ledger_id,controller_epoch=excluded.controller_epoch,generation=excluded.generation,expires_at=excluded.expires_at,claim_id=NULL,claim=NULL,pinned=0').run(scope, taskId, ownerId, this.ledgerId, fence.controllerEpoch, fence.generation, this.now() + 30000);
      this.write(job, { ...job.metadata.repoWiki, fence }); return fence;
    });
  }
  private checkFence(taskId: string, fence: ExecutionFence, allowPinned = false): ReturnType<KnowledgeBuildStore['task']> {
    executionFenceSchema.parse(fence); const job = this.task(taskId);
    const lease = this.db.prepare('SELECT * FROM agent_job_leases WHERE task_id=? AND owner_id=? AND generation=? AND ledger_id=? AND controller_epoch=?').get(taskId, fence.ownerId, fence.generation, fence.ledgerId, fence.controllerEpoch) as unknown as Lease | undefined;
    if (!lease || JSON.stringify(job.metadata.repoWiki.fence) !== JSON.stringify(fence) || fence.controllerEpoch !== this.options.controllerEpoch || fence.ledgerId !== this.ledgerId) throw new Error('STALE_FENCE');
    if (!lease.pinned && lease.expires_at <= this.now()) throw new Error('LEASE_EXPIRED');
    if (lease.pinned && !allowPinned) throw new Error('PUBLICATION_PINNED'); return job;
  }
  renewLease(taskId: string, fence: ExecutionFence): void { this.transaction(() => { this.checkFence(taskId, fence); this.db.prepare('UPDATE agent_job_leases SET expires_at=? WHERE task_id=? AND generation=? AND pinned=0').run(this.now() + 30000, taskId, fence.generation); }); }
  releaseLease(taskId: string, fence: ExecutionFence): void { this.transaction(() => { this.checkFence(taskId, fence); this.db.prepare('UPDATE agent_job_leases SET expires_at=0 WHERE task_id=? AND generation=? AND pinned=0').run(taskId, fence.generation); }); }
  private write(job: ReturnType<KnowledgeBuildStore['task']>, metadata: KnowledgeTaskMetadata, state?: JobState): Job {
    const next = parseKnowledgeTaskMetadata({ ...metadata, revision: job.metadata.repoWiki.revision + 1 });
    this.db.prepare('UPDATE agent_jobs SET metadata=?,state=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...job.metadata, repoWiki: next }), state ?? job.state, this.now(), job.id); return this.jobs.get(job.id)!;
  }
  setState(taskId: string, fence: ExecutionFence, state: JobState, patch: Partial<KnowledgeTaskMetadata> = {}): Job { return this.transaction(() => { const job = this.checkFence(taskId, fence); if (['completed','cancelled'].includes(job.state)) throw new Error('TASK_TERMINAL'); return this.write(job, { ...job.metadata.repoWiki, ...patch, key: job.metadata.repoWiki.key, fence }, state); }); }
  requestControl(taskId: string, input: { requestId: string; action: 'pause' | 'cancel'; cause: 'user' | 'application_exit' }): Job {
    return this.transaction(() => { const job = this.task(taskId); const current = job.metadata.repoWiki;
      const previous = this.readControlRequest(taskId, input.requestId);
      if (previous) { if (previous.action !== input.action || previous.cause !== input.cause) throw new Error('IDEMPOTENCY_CONFLICT'); return job; }
      if (current.control?.requestId === input.requestId) { if (current.control.action !== input.action || current.control.cause !== input.cause) throw new Error('IDEMPOTENCY_CONFLICT'); return job; }
      if (['completed','cancelled','failed'].includes(job.state)) throw new Error('TASK_TERMINAL');
      const leases = this.db.prepare('SELECT * FROM agent_job_leases WHERE task_id=?').all(taskId) as unknown as Lease[];
      if (leases.some(lease => lease.pinned)) throw new Error('PUBLICATION_PINNED');
      // An expired but unreconciled owner can still be running. Only explicit release or no lease proves no executor.
      const owned = leases.some(lease => lease.expires_at > 0);
      const control = { ...input, requestedAt: this.now() };
      this.db.prepare('INSERT INTO agent_audit VALUES(?,?,?,?)').run(randomUUID(), 'knowledge.control.requested', JSON.stringify({ taskId, ...input }), control.requestedAt);
      const updated = { ...job, metadata: { ...job.metadata, ...(input.action === 'cancel' ? { cancellationRequested: true } : {}) } };
      return this.write(updated, { ...current, control, resumePolicy: input.action === 'cancel' ? 'never' : input.cause === 'user' ? 'manual' : 'auto', ...(input.action === 'pause' ? { pauseCause: input.cause } : {}) }, owned ? job.state : input.action === 'pause' ? 'paused' : 'cancelled');
    });
  }
  readControlRequest(taskId: string, requestId: string): StoredKnowledgeControlRequest | undefined {
    const row = this.db.prepare("SELECT detail,created_at FROM agent_audit WHERE action='knowledge.control.requested' AND json_extract(detail,'$.taskId')=? AND json_extract(detail,'$.requestId')=? ORDER BY created_at DESC LIMIT 1").get(taskId, requestId) as { detail: string; created_at: number } | undefined;
    return row ? { ...JSON.parse(row.detail), requestedAt: row.created_at } as StoredKnowledgeControlRequest : undefined;
  }
  blockUnclaimedTask(taskId: string, error: NonNullable<KnowledgeTaskMetadata['error']>): Job {
    return this.transaction(() => { const job = this.task(taskId); if (job.state !== 'pending') throw new Error('TASK_NOT_PENDING');
      if (this.db.prepare('SELECT 1 FROM agent_job_leases WHERE task_id=? AND (expires_at<>0 OR pinned<>0)').get(taskId)) throw new Error('TASK_CLAIMED');
      return this.write(job, { ...job.metadata.repoWiki, error }, 'blocked');
    });
  }
  beginAttempt(taskId: string, phase: KnowledgePhase, itemId: string, fence: ExecutionFence, inputHash = 'pending', options?: { stageKind?: KnowledgeStageKind }): number {
    return this.transaction(() => { const job = this.checkFence(taskId, fence); const previous = this.item({ taskId, phase, itemId });
      if (previous?.state === 'prepared') throw new Error('ITEM_ALREADY_PREPARED');
      const stageKind = options?.stageKind ?? previous?.stage_kind ?? undefined;
      if (previous?.stage_kind && options?.stageKind && previous.stage_kind !== options.stageKind) throw new Error('STAGE_KIND_MISMATCH');
      const modelStage = ['overview', 'plan', 'catalogue', 'generate', 'relations'].includes(phase) && itemId !== 'catalogue:complete';
      if (job.metadata.repoWiki.executionPolicy && modelStage && stageKind) { const domain=job.metadata.repoWiki.key.domain; const valid=(phase==='overview'&&domain==='wiki'&&itemId==='overview'&&stageKind==='overview')||(phase==='plan'&&itemId==='plan'&&stageKind==='plan')||(phase==='catalogue'&&domain==='wiki'&&itemId.startsWith('catalogue:')&&stageKind==='catalogue')||(phase==='generate'&&domain==='wiki'&&itemId.startsWith('generate:')&&stageKind==='page')||(phase==='generate'&&domain==='cards'&&itemId.startsWith('card:')&&stageKind===(itemId==='card:repository'?'repository-card':'module-card'))||(phase==='relations'&&domain==='cards'&&itemId==='relations'&&stageKind==='relations');if(!valid)throw new Error('STAGE_KIND_MISMATCH'); }
      const effectiveUnit = modelStage ? resolveKnowledgeUnitBudget(job.metadata.repoWiki, stageKind) : job.metadata.repoWiki.budgets.unit;
      const attempt = (previous?.attempt ?? 0) + 1; if (attempt > effectiveUnit.maxAttempts) throw new Error('BUDGET_EXHAUSTED');
      const count = this.db.prepare('SELECT count(*) n FROM knowledge_build_items WHERE task_id=? AND phase=?').get(taskId, phase) as { n: number };
      if (!previous && ['catalogue', 'generate'].includes(phase) && count.n >= job.metadata.repoWiki.budgets.run.maxItems) throw new Error('CATALOGUE_LIMIT');
      this.db.prepare("INSERT INTO knowledge_build_items(task_id,phase,item_id,state,attempt,input_hash,updated_at,stage_kind) VALUES(?,?,?,'running',?,?,?,?) ON CONFLICT(task_id,phase,item_id) DO UPDATE SET state='running',attempt=excluded.attempt,input_hash=excluded.input_hash,output_hash=NULL,payload=NULL,error=NULL,evidence='[]',dependencies='[]',updated_at=excluded.updated_at").run(taskId, phase, itemId, attempt, inputHash, this.now(), stageKind ?? null);
      if (previous && ['failed', 'blocked'].includes(previous.state)) { const counts = { ...job.metadata.repoWiki.counts }; const field = previous.state as 'failed' | 'blocked'; counts[field] = Math.max(0, counts[field] - 1); this.write(job, { ...job.metadata.repoWiki, counts }); }
      return attempt;
    });
  }
  reserveExecutionBudget(input: ExecutionBudgetRequest): ExecutionRequestRecord {
    return this.transaction(() => { const job = this.checkFence(input.taskId, input.fence); const previous = this.getExecutionRequest(input.requestId);
      if (previous) { if (previous.taskId !== input.taskId || previous.phase !== input.phase || previous.itemId !== input.itemId || previous.attempt !== input.attempt || previous.kind !== input.kind || JSON.stringify(previous.reserved) !== JSON.stringify(input.reserved)) throw new Error('IDEMPOTENCY_CONFLICT'); return previous; }
      const item = this.item(input); if (!item || item.attempt !== input.attempt || item.state !== 'running') throw new Error('STALE_ATTEMPT');
      for (const [key, value] of Object.entries(input.reserved)) if (key !== 'unknown' && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new Error('INVALID_RESERVATION');
      if (input.kind === 'time' && (!(Number(input.reserved.activeTimeMs) > 0) || Number(input.reserved.activeTimeMs) > KNOWLEDGE_TIME_SLICE_MAX_MS)) throw new Error('INVALID_TIME_SLICE');
      const unit = this.usage(input.taskId, input.phase, input.itemId); const run = this.usage(input.taskId); const budget = job.metadata.repoWiki.budgets; const unitBudget = resolveKnowledgeUnitBudget(job.metadata.repoWiki, item.stage_kind ?? undefined);
      const cost = { ...input.reserved, modelRequests: input.kind === 'model' ? 1 : 0, toolCalls: input.kind === 'tool' ? 1 : 0 };
      const limits: Array<[keyof KnowledgeUsage, number]> = [['modelRequests', unitBudget.maxModelRequests], ['toolCalls', unitBudget.maxToolCalls], ['totalTokens', unitBudget.maxTotalTokens], ['readBytes', unitBudget.maxReadBytes], ['activeTimeMs', unitBudget.activeTimeMs]];
      if (limits.some(([key, limit]) => Number(unit[key] ?? 0) + Number(cost[key] ?? 0) > limit) || Number(run.modelRequests ?? 0) + cost.modelRequests > budget.run.maxModelRequests || Number(run.totalTokens ?? 0) + Number(cost.totalTokens ?? 0) > budget.run.maxTotalTokens) throw new Error('BUDGET_EXHAUSTED');
      this.db.prepare('INSERT INTO knowledge_execution_requests(request_id,task_id,phase,item_id,attempt,kind,state,fence,reserved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(input.requestId, input.taskId, input.phase, input.itemId, input.attempt, input.kind, 'reserved', JSON.stringify(input.fence), JSON.stringify(input.reserved), this.now(), this.now()); return this.getExecutionRequest(input.requestId)!;
    });
  }
  getExecutionRequest(requestId: string): ExecutionRequestRecord | undefined { const row = this.db.prepare('SELECT * FROM knowledge_execution_requests WHERE request_id=?').get(requestId) as Record<string, unknown> | undefined; return row ? { requestId, taskId: String(row.task_id), phase: row.phase as KnowledgePhase, itemId: String(row.item_id), attempt: Number(row.attempt), kind: row.kind as ExecutionRequestRecord['kind'], state: row.state as ExecutionRequestRecord['state'], fence: JSON.parse(String(row.fence)), reserved: JSON.parse(String(row.reserved)), ...(row.actual ? { actual: JSON.parse(String(row.actual)) } : {}) } : undefined; }
  markExecutionDispatched(requestId: string): void { this.db.prepare("UPDATE knowledge_execution_requests SET state='dispatched',updated_at=? WHERE request_id=? AND state='reserved'").run(this.now(), requestId); }
  assertExecutionScope(input: CheckpointRef & { fence: ExecutionFence; attempt: number }, requestId?: string): void {
    this.checkFence(input.taskId, input.fence); const item = this.item(input);
    if (!item || item.attempt !== input.attempt || item.state !== 'running') throw new Error('STALE_ATTEMPT');
    if (requestId) { const request = this.getExecutionRequest(requestId); if (!request || request.taskId !== input.taskId || request.phase !== input.phase || request.itemId !== input.itemId || request.attempt !== input.attempt || JSON.stringify(request.fence) !== JSON.stringify(input.fence)) throw new Error('REQUEST_SCOPE_MISMATCH'); }
  }
  reconcileUsageReports(reports: KnowledgeUsageRecoveryReport[]): { settled: string[]; ignored: string[] } {
    return this.transaction(() => { const settled: string[] = [], ignored: string[] = [];
      for (const report of reports) {
        const request = this.getExecutionRequest(report.requestId);
        if (!request || !this.jobs.get(report.taskId)) { ignored.push(report.requestId); this.db.prepare('INSERT INTO agent_audit VALUES(?,?,?,?)').run(randomUUID(), 'knowledge.usage.orphan', JSON.stringify({ requestId: report.requestId, taskId: report.taskId, controllerEpoch: report.controllerEpoch }), this.now()); continue; }
        if (request.taskId !== report.taskId || request.fence.controllerEpoch !== report.controllerEpoch || request.kind !== 'model') throw new Error('USAGE_SCOPE_MISMATCH');
        if (request.state === 'settled') continue;
        // Same accounting as a live request; a report without cache fields keeps its raw total.
        const actual: KnowledgeUsage = report.unknown || !report.usage ? { ...request.reserved, unknown: true } : { inputTokens: report.usage.input, outputTokens: report.usage.output, totalTokens: report.usage.cacheRead === undefined ? report.usage.totalTokens : knowledgeBudgetTokens(report.usage) };
        for (const [key, value] of Object.entries(actual)) if (key !== 'unknown' && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new Error('INVALID_USAGE');
        this.db.prepare("UPDATE knowledge_execution_requests SET state='settled',actual=?,updated_at=? WHERE request_id=?").run(JSON.stringify(actual), this.now(), report.requestId); settled.push(report.requestId);
      }
      return { settled, ignored };
    });
  }
  releaseExecutionBudget(requestId: string): void { this.db.prepare("UPDATE knowledge_execution_requests SET state='released',updated_at=? WHERE request_id=? AND state='reserved'").run(this.now(), requestId); }
  finishExecutionBudget(requestId: string, actual: KnowledgeUsage): ExecutionRequestRecord {
    return this.transaction(() => { const record = this.getExecutionRequest(requestId); if (!record) throw new Error('REQUEST_NOT_FOUND'); if (record.state === 'settled') { if (JSON.stringify(record.actual) !== JSON.stringify(actual)) throw new Error('USAGE_CONFLICT'); return record; } if (record.state === 'released') throw new Error('REQUEST_RELEASED');
      for (const [key, value] of Object.entries(actual)) if (key !== 'unknown' && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new Error('INVALID_USAGE');
      this.db.prepare("UPDATE knowledge_execution_requests SET state='settled',actual=?,updated_at=? WHERE request_id=?").run(JSON.stringify(actual), this.now(), requestId); return this.getExecutionRequest(requestId)!;
    });
  }
  usage(taskId: string, phase?: KnowledgePhase, itemId?: string): KnowledgeUsage {
    const rows = this.db.prepare(`SELECT kind,reserved,actual,state FROM knowledge_execution_requests WHERE task_id=?${phase ? ' AND phase=? AND item_id=?' : ''}`).all(...(phase ? [taskId, phase, itemId!] : [taskId])) as Array<{ kind: string; reserved: string; actual: string | null; state: string }>;
    const total: KnowledgeUsage = {};
    for (const row of rows) { if (row.state === 'released') continue; const values = JSON.parse(row.actual ?? row.reserved) as KnowledgeUsage;
      for (const [key, value] of Object.entries(values)) if (!['unknown','modelRequests','toolCalls'].includes(key)) (total as Record<string, number | boolean>)[key] = Number((total as Record<string, unknown>)[key] ?? 0) + Number(value);
      if (row.kind === 'model') total.modelRequests = Number(total.modelRequests ?? 0) + 1;
      if (row.kind === 'tool') total.toolCalls = Number(total.toolCalls ?? 0) + 1;
      if (!row.actual || values.unknown) total.unknown = true;
    } return total;
  }
  private item(ref: CheckpointRef): ItemRow | undefined { return this.db.prepare('SELECT * FROM knowledge_build_items WHERE task_id=? AND phase=? AND item_id=?').get(ref.taskId, ref.phase, ref.itemId) as unknown as ItemRow | undefined; }
  commitItem(value: StageExecutionResult, expectedItemAttempt: number): ItemAck {
    const result = parseStageExecutionResult(value); if (hashKnowledgePayload(result.payload) !== result.outputHash) throw new Error('OUTPUT_HASH_MISMATCH');
    return this.transaction(() => { const job = this.checkFence(result.taskId, result.fence); const old = this.item(result);
      if (!old || old.attempt !== expectedItemAttempt || result.stageAttempt !== expectedItemAttempt || old.input_hash !== result.inputHash) throw new Error('STALE_ATTEMPT_OR_INPUT');
      if (old.output_hash) { if (old.output_hash !== result.outputHash || old.state !== result.disposition) throw new Error('ITEM_COMMIT_CONFLICT'); return ackFrom(old); }
      for (const dependency of result.dependencies) { const item = this.item({ taskId: result.taskId, ...dependency }); if (!item || item.state !== 'prepared' || item.output_hash !== dependency.outputHash) throw new Error('INVALID_DEPENDENCY'); }
      const metadata = job.metadata.repoWiki; const revision = metadata.revision + 1;
      this.db.prepare('UPDATE knowledge_build_items SET state=?,output_hash=?,payload=?,evidence=?,dependencies=?,error=?,revision=?,updated_at=? WHERE task_id=? AND phase=? AND item_id=?').run(result.disposition, result.outputHash, JSON.stringify(result.payload), JSON.stringify(result.evidence), JSON.stringify(result.dependencies), result.error ? JSON.stringify(result.error) : null, revision, this.now(), result.taskId, result.phase, result.itemId);
      const counts = { ...metadata.counts }; counts[result.disposition === 'prepared' ? 'prepared' : result.disposition === 'failed' ? 'failed' : 'blocked']++;
      this.write(job, { ...metadata, phase: result.phase, counts }); return ackFrom(this.item(result)!);
    });
  }
  readCheckpoint(ref: CheckpointRef): VerifiedArtifact { const item = this.item(ref); if (!item?.output_hash || item.state !== 'prepared' || item.payload === null) throw new Error('CHECKPOINT_NOT_FOUND'); const payload: unknown = JSON.parse(item.payload); if (hashKnowledgePayload(payload) !== item.output_hash) throw new Error('CHECKPOINT_HASH_MISMATCH'); return { ...ackFrom(item), state: item.state, inputHash: item.input_hash, payload, evidence: JSON.parse(item.evidence), dependencies: JSON.parse(item.dependencies), ...(item.source_task_id ? { sourceTaskId: item.source_task_id } : {}) }; }
  readFailedCandidate(ref: CheckpointRef): FailedCandidate { const item = this.item(ref); if (!item || item.state !== 'failed' || !item.output_hash || item.payload === null || !item.error) throw new Error('CANDIDATE_NOT_FOUND'); const error=JSON.parse(item.error) as StageExecutionResult['error']; if (!error?.code.startsWith('INVALID_')) throw new Error('CANDIDATE_NOT_FOUND'); const payload:unknown=JSON.parse(item.payload);if(hashKnowledgePayload(payload)!==item.output_hash)throw new Error('CANDIDATE_HASH_MISMATCH');return {...ackFrom(item),state:item.state,inputHash:item.input_hash,payload,evidence:JSON.parse(item.evidence),dependencies:JSON.parse(item.dependencies),error:error!,...(item.source_task_id?{sourceTaskId:item.source_task_id}:{})}; }
  listItems(taskId: string): Array<{ phase: KnowledgePhase; itemId: string; state: string; attempt: number; inputHash: string; outputHash?: string }> { return (this.db.prepare('SELECT * FROM knowledge_build_items WHERE task_id=?').all(taskId) as unknown as ItemRow[]).map(i => ({ phase: i.phase, itemId: i.item_id, state: i.state, attempt: i.attempt, inputHash: i.input_hash, ...(i.output_hash ? { outputHash: i.output_hash } : {}) })); }
  listCheckpoints(taskId: string): VerifiedArtifact[] { return this.listItems(taskId).filter(item => item.state === 'prepared').map(item => this.readCheckpoint({ taskId, phase: item.phase, itemId: item.itemId })); }
  listExecutionRequests(taskId: string): ExecutionRequestRecord[] { return (this.db.prepare('SELECT request_id FROM knowledge_execution_requests WHERE task_id=? ORDER BY created_at,request_id').all(taskId) as Array<{ request_id: string }>).map(row => this.getExecutionRequest(row.request_id)!); }
  budgetRemaining(taskId: string, phase: KnowledgePhase, itemId: string): KnowledgeBudgets {
    const metadata = this.task(taskId).metadata.repoWiki; const unit = this.usage(taskId, phase, itemId); const run = this.usage(taskId); const item = this.item({ taskId, phase, itemId }); const budget = structuredClone(metadata.budgets);
    if (['overview', 'plan', 'catalogue', 'generate', 'relations'].includes(phase)) budget.unit = structuredClone(resolveKnowledgeUnitBudget(metadata, item?.stage_kind ?? undefined));
    const attempt = item?.attempt ?? 0;
    budget.unit.maxAttempts = Math.max(0, budget.unit.maxAttempts - attempt);
    for (const [limit, value] of [['maxModelRequests','modelRequests'],['maxToolCalls','toolCalls'],['maxTotalTokens','totalTokens'],['maxReadBytes','readBytes'],['activeTimeMs','activeTimeMs']] as const) budget.unit[limit] = Math.max(0, budget.unit[limit] - Number(unit[value] ?? 0));
    budget.run.maxModelRequests = Math.max(0, budget.run.maxModelRequests - Number(run.modelRequests ?? 0)); budget.run.maxTotalTokens = Math.max(0, budget.run.maxTotalTokens - Number(run.totalTokens ?? 0));
    return budget;
  }
  copyRepairArtifact(ref: CheckpointRef, targetTaskId: string, fence: ExecutionFence, expectedInputHash: string): VerifiedArtifact {
    return this.transaction(() => { const target = this.checkFence(targetTaskId, fence); const source = this.task(ref.taskId); const artifact = this.readCheckpoint(ref);
      if (target.metadata.retryOf !== ref.taskId || identity(target.metadata.repoWiki.key) !== identity(source.metadata.repoWiki.key) || target.metadata.repoWiki.pipelineConfigHash !== source.metadata.repoWiki.pipelineConfigHash || target.metadata.repoWiki.modelIdentity !== source.metadata.repoWiki.modelIdentity || target.metadata.repoWiki.planHash !== source.metadata.repoWiki.planHash || expectedInputHash !== artifact.inputHash) throw new Error('REPAIR_INPUT_MISMATCH');
      const old = this.item({ ...ref, taskId: targetTaskId }); if (old) { if (old.output_hash === artifact.outputHash && old.input_hash === artifact.inputHash && old.source_task_id === ref.taskId) return this.readCheckpoint({ ...ref, taskId: targetTaskId }); throw new Error('ITEM_COMMIT_CONFLICT'); }
      const revision = target.metadata.repoWiki.revision + 1;
      this.db.prepare("INSERT INTO knowledge_build_items(task_id,phase,item_id,state,attempt,input_hash,output_hash,payload,evidence,dependencies,revision,source_task_id,updated_at,stage_kind) VALUES(?,?,?,'prepared',0,?,?,?,?,?,?,?,?,?)").run(targetTaskId, ref.phase, ref.itemId, artifact.inputHash, artifact.outputHash, JSON.stringify(artifact.payload), JSON.stringify(artifact.evidence), JSON.stringify(artifact.dependencies), revision, ref.taskId, this.now(), this.item(ref)?.stage_kind ?? null);
      this.write(target, { ...target.metadata.repoWiki, counts: { ...target.metadata.repoWiki.counts, prepared: target.metadata.repoWiki.counts.prepared + 1 } }); return this.readCheckpoint({ ...ref, taskId: targetTaskId });
    });
  }
  copyRepairCandidate(ref: CheckpointRef, targetTaskId: string, fence: ExecutionFence, expectedInputHash: string, payload: unknown): VerifiedArtifact {
    assertKnowledgePayloadSize(payload, KNOWLEDGE_FRAME_MAX_BYTES);
    return this.transaction(() => { const target=this.checkFence(targetTaskId,fence);const source=this.task(ref.taskId);const candidate=this.readFailedCandidate(ref);
      if(target.metadata.retryOf!==ref.taskId||identity(target.metadata.repoWiki.key)!==identity(source.metadata.repoWiki.key)||target.metadata.repoWiki.pipelineConfigHash!==source.metadata.repoWiki.pipelineConfigHash||target.metadata.repoWiki.modelIdentity!==source.metadata.repoWiki.modelIdentity||target.metadata.repoWiki.planHash!==source.metadata.repoWiki.planHash||expectedInputHash!==candidate.inputHash)throw new Error('REPAIR_INPUT_MISMATCH');
      for(const dependency of candidate.dependencies){const item=this.item({taskId:targetTaskId,...dependency});if(!item||item.state!=='prepared'||item.output_hash!==dependency.outputHash)throw new Error('INVALID_DEPENDENCY');}
      const old=this.item({...ref,taskId:targetTaskId});const outputHash=hashKnowledgePayload(payload);if(old){if(old.output_hash===outputHash&&old.input_hash===candidate.inputHash&&old.source_task_id===ref.taskId)return this.readCheckpoint({...ref,taskId:targetTaskId});throw new Error('ITEM_COMMIT_CONFLICT');}
      const revision=target.metadata.repoWiki.revision+1;this.db.prepare("INSERT INTO knowledge_build_items(task_id,phase,item_id,state,attempt,input_hash,output_hash,payload,evidence,dependencies,revision,source_task_id,updated_at,stage_kind) VALUES(?,?,?,'prepared',0,?,?,?,?,?,?,?,?,?)").run(targetTaskId,ref.phase,ref.itemId,candidate.inputHash,outputHash,JSON.stringify(payload),JSON.stringify(candidate.evidence),JSON.stringify(candidate.dependencies),revision,ref.taskId,this.now(),this.item(ref)?.stage_kind??null);
      this.write(target,{...target.metadata.repoWiki,counts:{...target.metadata.repoWiki.counts,prepared:target.metadata.repoWiki.counts.prepared+1}});return this.readCheckpoint({...ref,taskId:targetTaskId});
    });
  }
  promoteFailedCandidate(ref:CheckpointRef,fence:ExecutionFence,expectedInputHash:string,payload:unknown):VerifiedArtifact {
    assertKnowledgePayloadSize(payload,KNOWLEDGE_FRAME_MAX_BYTES);
    return this.transaction(()=>{const job=this.checkFence(ref.taskId,fence);const candidate=this.readFailedCandidate(ref);if(candidate.inputHash!==expectedInputHash)throw new Error('REPAIR_INPUT_MISMATCH');
      for(const dependency of candidate.dependencies){const item=this.item({taskId:ref.taskId,...dependency});if(!item||item.state!=='prepared'||item.output_hash!==dependency.outputHash)throw new Error('INVALID_DEPENDENCY');}
      const revision=job.metadata.repoWiki.revision+1;this.db.prepare("UPDATE knowledge_build_items SET state='prepared',output_hash=?,payload=?,error=NULL,revision=?,updated_at=? WHERE task_id=? AND phase=? AND item_id=? AND state='failed'").run(hashKnowledgePayload(payload),JSON.stringify(payload),revision,this.now(),ref.taskId,ref.phase,ref.itemId);
      const counts=job.metadata.repoWiki.counts;this.write(job,{...job.metadata.repoWiki,counts:{...counts,failed:Math.max(0,counts.failed-1),prepared:counts.prepared+1}});return this.readCheckpoint(ref);
    });
  }
  putSourceSnapshot(taskId: string, fence: ExecutionFence, manifest: unknown): string { assertKnowledgePayloadSize(manifest, KNOWLEDGE_FRAME_MAX_BYTES); rejectSourceContent(manifest); return this.transaction(() => { const job = this.checkFence(taskId, fence); const hash = hashKnowledgePayload(manifest); const id = `${taskId}:${hash}`; this.db.prepare('INSERT OR IGNORE INTO knowledge_source_snapshots VALUES(?,?,?,?,?)').run(id, taskId, hash, JSON.stringify(manifest), this.now()); this.write(job, { ...job.metadata.repoWiki, sourceSnapshotId: id }); return id; }); }
  readSourceSnapshot(id: string): unknown { const row = this.db.prepare('SELECT manifest,manifest_hash FROM knowledge_source_snapshots WHERE snapshot_id=?').get(id) as { manifest: string; manifest_hash: string } | undefined; if (!row) throw new Error('SOURCE_SNAPSHOT_NOT_FOUND'); const value: unknown = JSON.parse(row.manifest); if (hashKnowledgePayload(value) !== row.manifest_hash) throw new Error('SOURCE_SNAPSHOT_HASH_MISMATCH'); return value; }
  pinPublication(claim: PublishClaim): void {
    this.transaction(() => { const job = this.checkFence(claim.taskId, claim.fence, true); const lease = this.db.prepare('SELECT * FROM agent_job_leases WHERE task_id=? AND generation=?').get(claim.taskId, claim.fence.generation) as unknown as Lease;
      if (lease.pinned) { if (lease.claim === JSON.stringify(claim)) return; throw new Error('PUBLICATION_PINNED'); }
      if (claim.version !== 1 || job.metadata.repoWiki.revision !== claim.expectedRevision || job.metadata.cancellationRequested || job.metadata.repoWiki.resumePolicy === 'never') throw new Error('PUBLICATION_CONFLICT');
      const counts = job.metadata.repoWiki.counts; if (counts.failed || counts.blocked || (counts.planned > 0 && counts.prepared < counts.planned)) throw new Error('REQUIRED_ITEMS_INCOMPLETE');
      this.db.prepare('UPDATE agent_job_leases SET pinned=1,claim_id=?,claim=? WHERE scope=?').run(claim.claimId, JSON.stringify(claim), lease.scope);
      this.write(job, { ...job.metadata.repoWiki, phase: 'publish', publication: { id: claim.publicationId, claimId: claim.claimId, intentHash: claim.intentHash, state: 'claimed' } });
    });
  }
  listLeases(taskId?: string): KnowledgeLease[] { return (this.db.prepare(`SELECT * FROM agent_job_leases${taskId ? ' WHERE task_id=?' : ''}`).all(...(taskId ? [taskId] : [])) as unknown as Lease[]).map(lease => ({ scope: lease.scope, taskId: lease.task_id, fence: fenceFrom(lease), expiresAt: lease.expires_at, pinned: !!lease.pinned, ...(lease.claim_id ? { claimId: lease.claim_id } : {}) })); }
  readPublicationClaim(taskId: string): PublishClaim | null { const lease = this.db.prepare('SELECT claim FROM agent_job_leases WHERE task_id=? AND pinned=1').get(taskId) as { claim: string | null } | undefined; return lease?.claim ? JSON.parse(lease.claim) as PublishClaim : null; }
  getPublicationClaim(taskId: string): PublishClaim | undefined { return this.readPublicationClaim(taskId) ?? undefined; }
  private reconcilePublicationFence(taskId: string, fence: ExecutionFence, recovery?: { previousExecutorExited: true }): ReturnType<KnowledgeBuildStore['task']> {
    if (!recovery?.previousExecutorExited) return this.checkFence(taskId, fence, true);
    const job = this.task(taskId); const claim = this.readPublicationClaim(taskId);
    if (!claim || fence.ledgerId !== this.ledgerId || JSON.stringify(claim.fence) !== JSON.stringify(fence) || JSON.stringify(job.metadata.repoWiki.fence) !== JSON.stringify(fence)) throw new Error('STALE_FENCE');
    return job;
  }
  /** Only the reconciler calls this after proving the old writer exited and no journal was prepared. */
  releasePublicationClaim(taskId: string, fence: ExecutionFence, claimId: string, recovery?: { previousExecutorExited: true }): Job {
    return this.transaction(() => { const job = this.reconcilePublicationFence(taskId, fence, recovery); const publication = job.metadata.repoWiki.publication;
      if (!publication || publication.claimId !== claimId || publication.state !== 'claimed') throw new Error('PUBLICATION_CONFLICT');
      const result = this.db.prepare('UPDATE agent_job_leases SET pinned=0,claim_id=NULL,claim=NULL WHERE task_id=? AND claim_id=? AND generation=?').run(taskId, claimId, fence.generation);
      if (!Number(result.changes)) throw new Error('PUBLICATION_CONFLICT');
      return this.write(job, { ...job.metadata.repoWiki, publication: undefined });
    });
  }
  blockPublication(taskId: string, fence: ExecutionFence, error: NonNullable<KnowledgeTaskMetadata['error']>, recovery?: { previousExecutorExited: true }): Job {
    return this.transaction(() => { const job = this.reconcilePublicationFence(taskId, fence, recovery); if (!job.metadata.repoWiki.publication) throw new Error('PUBLICATION_CONFLICT');
      this.db.prepare('INSERT INTO agent_audit VALUES(?,?,?,?)').run(randomUUID(), 'knowledge.publication.blocked', JSON.stringify({ taskId, claimId: job.metadata.repoWiki.publication.claimId, ...error }), this.now());
      return this.write(job, { ...job.metadata.repoWiki, error }, 'blocked'); });
  }
  settlePublication(receipt: PublishReceipt): Job {
    return this.transaction(() => { const job = this.task(receipt.taskId); const lease = this.db.prepare('SELECT * FROM agent_job_leases WHERE task_id=? AND claim_id=?').get(receipt.taskId, receipt.claimId) as unknown as Lease | undefined;
      const publication = job.metadata.repoWiki.publication;
      if (job.state === 'completed') { const audit = this.db.prepare("SELECT detail FROM agent_audit WHERE action='knowledge.publication.settled' AND json_extract(detail,'$.taskId')=? AND json_extract(detail,'$.claimId')=? ORDER BY created_at DESC LIMIT 1").get(receipt.taskId, receipt.claimId) as { detail: string } | undefined; if (audit && JSON.stringify(JSON.parse(audit.detail)) === JSON.stringify(receipt)) return job; throw new Error('PUBLICATION_RECEIPT_MISMATCH'); }
      if (!lease?.claim || !publication || receipt.version !== 1) throw new Error('PUBLICATION_RECEIPT_MISMATCH');
      const claim = JSON.parse(lease.claim) as PublishClaim;
      if (receipt.publicationId !== claim.publicationId || receipt.intentHash !== claim.intentHash || receipt.outputSetHash !== claim.outputSetHash || receipt.ledgerId !== claim.fence.ledgerId || receipt.generation !== claim.fence.generation) throw new Error('PUBLICATION_RECEIPT_MISMATCH');
      const result = this.write(job, { ...job.metadata.repoWiki, phase: 'publish', outcome: 'complete', error: undefined, publication: { ...publication, state: 'files_committed' }, counts: { ...job.metadata.repoWiki.counts, published: job.metadata.repoWiki.counts.planned } }, 'completed');
      this.db.prepare('INSERT INTO agent_audit(id,action,detail,created_at) VALUES(?,?,?,?)').run(randomUUID(), 'knowledge.publication.settled', JSON.stringify(receipt), this.now());
      this.db.prepare('UPDATE agent_jobs SET progress=100 WHERE id=?').run(job.id); this.db.prepare('UPDATE agent_job_leases SET pinned=0,expires_at=0 WHERE scope=?').run(lease.scope); return { ...result, progress: 100 };
    });
  }
}
function fenceFrom(lease: Lease): ExecutionFence { return { ledgerId: lease.ledger_id, controllerEpoch: lease.controller_epoch, ownerId: lease.owner_id, generation: lease.generation }; }
function ackFrom(item: ItemRow): ItemAck { return { taskId: item.task_id, phase: item.phase, itemId: item.item_id, attempt: item.attempt, revision: item.revision, outputHash: item.output_hash! }; }
function identity(key: KnowledgeKey): string { return JSON.stringify([key.workspaceInstanceId, key.projectId, key.portableProjectId, key.branch, key.language, key.domain]); }
function rejectSourceContent(value: unknown): void { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { if (['content','source','text','code','credentials','apiKey','headers'].includes(key)) throw new Error('SOURCE_MANIFEST_CONTAINS_CONTENT'); rejectSourceContent(child); } }
