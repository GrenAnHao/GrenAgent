import type { WikiSessionEvent } from './sessionRuntime';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WIKI_ENGINE, type WikiCheckpoint, type WikiFence, type WikiManifest, type WikiOperation, type WikiPublication, type WikiStartInput, type WikiState, type WikiUsage } from './contracts';

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
type Row = Record<string, any>;

/** Native state is authoritative; project files and task entries are projections. */
export class WikiStore {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'wiki.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT, error TEXT, publication_id TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE TABLE IF NOT EXISTS leases(branch TEXT NOT NULL, locale TEXT NOT NULL, operation_id TEXT NOT NULL, owner TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(branch,locale));
      CREATE TABLE IF NOT EXISTS checkpoints(operation_id TEXT NOT NULL, stage TEXT NOT NULL, item_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(operation_id,stage,item_id));
      CREATE TABLE IF NOT EXISTS checkpoint_history(seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, stage TEXT NOT NULL, item_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(operation_id TEXT NOT NULL, request_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(operation_id,request_id));
      CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, branch TEXT NOT NULL, locale TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS partitions(branch TEXT NOT NULL, locale TEXT NOT NULL, publication_id TEXT NOT NULL, PRIMARY KEY(branch,locale));
      CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);`);
  }
  close(): void { this.db.close(); }
  private tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  private row(id: string): Row { const r = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row | undefined; if (!r) throw new Error('OPERATION_NOT_FOUND'); return r; }
  private operation(r: Row): WikiOperation { return { ...parse<WikiStartInput>(r.input), id: r.id, state: r.state, revision: r.revision, ...(r.run_id ? { runId: r.run_id } : {}), ...(r.error ? { error: r.error } : {}), ...(r.publication_id ? { publicationId: r.publication_id } : {}) }; }
  private event(op: WikiOperation): void { this.db.prepare("INSERT INTO outbox(id,kind,payload) VALUES(?,'operation',?)").run(randomUUID(), json({ operationId: op.id, revision: op.revision, state: op.state })); }
  list(): WikiOperation[] { return (this.db.prepare('SELECT * FROM operations ORDER BY rowid DESC').all() as Row[]).map(row => this.operation(row)); }
  get(id: string): WikiOperation { return this.operation(this.row(id)); }
  accept(input: WikiStartInput): WikiOperation {
    if (!input.requestId || !input.projectId || !input.repositoryRoot || !input.branch || !input.locale || !input.targetCommit || input.engine !== WIKI_ENGINE || !input.authorization?.confirmed || !input.spendingPolicy || !input.effectiveProfile) throw new Error('INVALID_INPUT');
    const secret = (v: unknown): boolean => !!v && typeof v === 'object' && Object.entries(v).some(([k, x]) => /^(api.?key|credential|password|secret|token)$/i.test(k) || secret(x));
    if (secret(input.model)) throw new Error('MODEL_CREDENTIAL_FORBIDDEN');
    for (const n of [input.spendingPolicy?.maxModelRequests, input.spendingPolicy?.maxTotalTokens]) if (n !== undefined && (!Number.isSafeInteger(n) || n < 0)) throw new Error('INVALID_SPENDING_POLICY');
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(input.requestId) as Row | undefined;
      if (existing) { if (existing.input !== json(input)) throw new Error('IDEMPOTENCY_CONFLICT'); return this.operation(existing); }
      if (input.action !== 'repair' && input.parentOperationId) throw new Error('INVALID_PARENT_OPERATION');
      if (input.action === 'repair') {
        if (!input.parentOperationId || input.expectedRevision === undefined) throw new Error('REPAIR_CONFIRMATION_REQUIRED');
        const parent = this.get(input.parentOperationId);
        if (!['failed', 'completed'].includes(parent.state) || parent.engine !== input.engine || parent.templateVersion !== input.templateVersion || parent.revision !== input.expectedRevision || parent.projectId !== input.projectId || parent.repositoryRoot !== input.repositoryRoot || parent.branch !== input.branch || parent.locale !== input.locale || parent.targetCommit !== input.targetCommit || json(parent.model) !== json(input.model) || json(parent.plan) !== json(input.plan) || json(parent.author) !== json(input.author) || json(parent.spendingPolicy) !== json(input.spendingPolicy) || json(parent.effectiveProfile) !== json(input.effectiveProfile)) throw new Error('REVISION_OR_IDENTITY_CONFLICT');
      }
      const id = randomUUID(); this.db.prepare("INSERT INTO operations(id,request_id,input,state,revision) VALUES(?,?,?,'queued',0)").run(id, input.requestId, json(input));
      if (input.action === 'repair' && input.parentOperationId) {
        this.db.prepare('INSERT INTO checkpoints SELECT ?,stage,item_id,value FROM checkpoints WHERE operation_id=?').run(id, input.parentOperationId);
      }
      const op = this.get(id); this.event(op); return op;
    });
  }
  /** Called only after the host confirms the prior executor has exited and released admission. */
  recoverInterrupted(id: string): WikiOperation { return this.tx(() => {
    const op = this.get(id);
    if (!['running', 'pausing', 'cancelling'].includes(op.state)) throw new Error('INVALID_STATE');
    const lease = this.db.prepare('SELECT * FROM leases WHERE branch=? AND locale=?').get(op.branch, op.locale) as Row | undefined;
    if (lease && lease.operation_id !== id && lease.expires_at > Date.now()) throw new Error('LEASE_BUSY');
    if (lease && lease.operation_id === id) this.db.prepare('UPDATE leases SET expires_at=0 WHERE branch=? AND locale=?').run(op.branch, op.locale);
    const pending = this.db.prepare('SELECT request_id,value FROM usage WHERE operation_id=?').all(id) as Row[];
    for (const row of pending) { const value = parse<WikiUsage>(row.value); if (value.state === 'dispatched') this.db.prepare('UPDATE usage SET value=? WHERE operation_id=? AND request_id=?').run(json({ ...value, state: 'unknown' }), id, row.request_id); }
    const state: WikiState = op.state === 'pausing' ? 'paused' : op.state === 'cancelling' ? 'cancelled' : 'queued';
    this.db.prepare('UPDATE operations SET state=?,revision=revision+1 WHERE id=?').run(state, id);
    this.db.prepare("UPDATE runs SET state='interrupted',finished_at=? WHERE id=?").run(Date.now(), op.runId!);
    const updated = this.get(id); this.event(updated); return updated;
  }); }
  control(id: string, action: 'pause' | 'cancel' | 'resume', revision: number, cause: 'user' | 'application_exit' = 'user'): WikiOperation { return this.tx(() => {
    const op = this.get(id); if (op.revision !== revision) throw new Error('REVISION_CONFLICT');
    let state: WikiState;
    if (action === 'resume') { if (op.state !== 'paused') throw new Error('INVALID_STATE'); state = 'queued'; }
    else if (action === 'cancel' && op.state === 'paused') state = 'cancelled';
    else { if (!['queued', 'running'].includes(op.state)) throw new Error('INVALID_STATE'); state = op.state === 'queued' ? (action === 'pause' ? 'paused' : 'cancelled') : (action === 'pause' ? 'pausing' : 'cancelling'); }
    this.db.prepare('UPDATE operations SET state=?,revision=revision+1,error=? WHERE id=?').run(state, cause === 'application_exit' && action === 'pause' ? 'APPLICATION_EXIT' : null, id); const updated = this.get(id); this.event(updated); return updated;
  }); }
  claim(id: string, owner: string, leaseMs: number): WikiFence { return this.tx(() => {
    const op = this.get(id); if (op.state !== 'queued') throw new Error('INVALID_STATE');
    const old = this.db.prepare('SELECT * FROM leases WHERE branch=? AND locale=?').get(op.branch, op.locale) as Row | undefined;
    if (old && old.expires_at > Date.now()) throw new Error('LEASE_BUSY');
    const fence = { operationId: id, owner, generation: (old?.generation ?? 0) + 1 };
    this.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?,?) ON CONFLICT(branch,locale) DO UPDATE SET operation_id=excluded.operation_id,owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at').run(op.branch, op.locale, id, owner, fence.generation, Date.now() + leaseMs);
    const run = randomUUID(); this.db.prepare("INSERT INTO runs VALUES(?,?,'running',?,NULL)").run(run, id, Date.now());
    this.db.prepare("UPDATE operations SET state='running',run_id=?,revision=revision+1,error=NULL WHERE id=?").run(run, id); this.event(this.get(id)); return fence;
  }); }
  private check(f: WikiFence): WikiOperation { const op = this.get(f.operationId); const row = this.db.prepare('SELECT * FROM leases WHERE branch=? AND locale=?').get(op.branch, op.locale) as Row | undefined; if (!row || row.operation_id !== f.operationId || row.owner !== f.owner || row.generation !== f.generation || row.expires_at <= Date.now()) throw new Error('STALE_FENCE'); return op; }
  heartbeat(f: WikiFence, leaseMs: number): void { this.tx(() => { const op = this.check(f); this.db.prepare('UPDATE leases SET expires_at=? WHERE branch=? AND locale=?').run(Date.now() + leaseMs, op.branch, op.locale); }); }
  release(f: WikiFence): void { this.tx(() => { const op = this.check(f); this.db.prepare('UPDATE leases SET expires_at=0 WHERE branch=? AND locale=?').run(op.branch, op.locale); }); }
  checkpoint(f: WikiFence, value: WikiCheckpoint): void { this.tx(() => { const op = this.check(f); if (!['running','pausing','cancelling'].includes(op.state)) throw new Error('INVALID_STATE'); this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT(operation_id,stage,item_id) DO UPDATE SET value=excluded.value').run(op.id, value.stage, value.itemId, json(value)); this.db.prepare('INSERT INTO checkpoint_history(operation_id,stage,item_id,value) VALUES(?,?,?,?)').run(op.id, value.stage, value.itemId, json(value)); }); }
  checkpoints(id: string): WikiCheckpoint[] { this.row(id); return (this.db.prepare('SELECT value FROM checkpoints WHERE operation_id=? ORDER BY stage,item_id').all(id) as Row[]).map(r => parse(r.value)); }
  checkpointHistory(id: string): WikiCheckpoint[] { this.row(id); return (this.db.prepare('SELECT value FROM checkpoint_history WHERE operation_id=? ORDER BY seq').all(id) as Row[]).map(r => parse(r.value)); }
  sessionEvent(f: WikiFence, value: WikiSessionEvent): void { this.tx(() => { const op = this.check(f); this.db.prepare('INSERT INTO session_events(operation_id,value) VALUES(?,?)').run(op.id, json(value)); }); }
  events(id: string): WikiSessionEvent[] { this.row(id); return (this.db.prepare('SELECT value FROM session_events WHERE operation_id=? ORDER BY seq').all(id) as Row[]).map(r => parse(r.value)); }
  usage(f: WikiFence, value: WikiUsage): void { this.tx(() => {
    const op = this.check(f);
    if (!value.requestId) throw new Error('INVALID_USAGE');
    const row = this.db.prepare('SELECT value FROM usage WHERE operation_id=? AND request_id=?').get(op.id, value.requestId) as Row | undefined;
    const prior = row ? parse<WikiUsage>(row.value) : undefined;
    if (!prior) {
      if (value.state !== 'dispatched' || !Number.isSafeInteger(value.reservationTokens) || value.reservationTokens! <= 0) throw new Error('INVALID_USAGE');
      const records = this.aggregateUsageRecords(op.id);
      const usedTokens = records.reduce((sum, item) => sum + (item.state === 'actual' ? item.totalTokens! : item.reservationTokens!), 0);
      const policy = op.spendingPolicy;
      if ((policy.maxModelRequests !== undefined && records.length + 1 > policy.maxModelRequests) || (policy.maxTotalTokens !== undefined && usedTokens + value.reservationTokens! > policy.maxTotalTokens)) throw new Error('SPENDING_LIMIT');
    } else {
      if (prior.state === 'actual') { if (json(prior) !== json({ ...value, reservationTokens: prior.reservationTokens })) throw new Error('USAGE_ALREADY_SETTLED'); return; }
      if (value.state === 'dispatched') { if (json(prior) !== json(value)) throw new Error('USAGE_STATE_REGRESSION'); return; }
      if (value.state !== 'actual' && value.state !== 'unknown') throw new Error('INVALID_USAGE');
      if (value.state === 'actual' && (!Number.isSafeInteger(value.totalTokens) || value.totalTokens! < 0)) throw new Error('INVALID_USAGE');
      value = { ...value, reservationTokens: prior.reservationTokens };
    }
    this.db.prepare('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(operation_id,request_id) DO UPDATE SET value=excluded.value').run(op.id, value.requestId, json(value));
  }); }
  usageRecords(id: string): WikiUsage[] { this.row(id); return (this.db.prepare('SELECT value FROM usage WHERE operation_id=? ORDER BY rowid').all(id) as Row[]).map(r => parse(r.value)); }
  aggregateUsageRecords(id: string): WikiUsage[] {
    const seen = new Set<string>(); const chain: WikiOperation[] = []; let current: WikiOperation | undefined = this.get(id);
    while (current) {
      if (seen.has(current.id)) throw new Error('OPERATION_LINEAGE_CYCLE');
      seen.add(current.id); chain.push(current);
      if (!current.parentOperationId) break;
      const parent: WikiOperation = this.get(current.parentOperationId);
      if (parent.projectId !== current.projectId || parent.repositoryRoot !== current.repositoryRoot || parent.branch !== current.branch || parent.locale !== current.locale || parent.targetCommit !== current.targetCommit || parent.engine !== current.engine || parent.templateVersion !== current.templateVersion || json(parent.model) !== json(current.model) || json(parent.plan) !== json(current.plan) || json(parent.author) !== json(current.author) || json(parent.spendingPolicy) !== json(current.spendingPolicy) || json(parent.effectiveProfile) !== json(current.effectiveProfile) || current.action !== 'repair') throw new Error('OPERATION_LINEAGE_MISMATCH');
      current = parent;
    }
    return chain.reverse().flatMap(op => this.usageRecords(op.id));
  }
  admissionError(id: string, code: string): void { this.tx(() => {
    const op = this.get(id); if (op.state !== 'queued') return;
    const safe = code.match(/^([A-Z][A-Z0-9_]{0,99})(?:$|[:\s])/)?.[1] ?? 'ADMISSION_FAILED';
    this.db.prepare('UPDATE operations SET error=?,revision=revision+1 WHERE id=?').run(safe, id); this.event(this.get(id));
  }); }
  settle(f: WikiFence, error?: string): WikiOperation { return this.tx(() => { const op = this.check(f); if (op.state === 'completed') return op; const state: WikiState = op.state === 'pausing' ? 'paused' : op.state === 'cancelling' ? 'cancelled' : 'failed'; this.db.prepare('UPDATE operations SET state=?,error=?,revision=revision+1 WHERE id=?').run(state, state === 'failed' ? ((error ?? 'RUN_ENDED_WITHOUT_PUBLICATION').match(/^[A-Z][A-Z0-9_]{0,99}$/)?.[0] ?? 'RUN_FAILED') : state === 'paused' ? op.error ?? null : null, op.id); this.db.prepare('UPDATE runs SET state=?,finished_at=? WHERE id=?').run(state, Date.now(), op.runId!); const updated = this.get(op.id); this.event(updated); return updated; }); }
  publication(id: string): WikiPublication | undefined { const r = this.db.prepare('SELECT value FROM publications WHERE id=?').get(id) as Row | undefined; return r ? parse(r.value) : undefined; }
  partition(branch: string, locale: string): WikiPublication | undefined { const row = this.db.prepare('SELECT publication_id FROM partitions WHERE branch=? AND locale=?').get(branch, locale) as Row | undefined; return row ? this.publication(row.publication_id) : undefined; }
  publish(f: WikiFence, manifest: WikiManifest): WikiPublication { return this.tx(() => {
    const op = this.check(f); if (op.publicationId) return this.publication(op.publicationId)!; if (op.state !== 'running') throw new Error('CONTROL_PENDING'); if (manifest.baseline !== op.targetCommit) throw new Error('BASELINE_MISMATCH');
    const checkpoints = this.checkpoints(op.id); const stages = new Set(checkpoints.filter(c => c.disposition === 'done').map(c => c.stage));
    if (manifest.requiredStages.some(s => !stages.has(s))) throw new Error('REQUIRED_STAGE_FAILED');
    const ids = manifest.catalogue.map(c => c.id); if (new Set(ids).size !== ids.length || manifest.pages.length !== ids.length || new Set(manifest.pages.map(p => p.id)).size !== ids.length || manifest.pages.some(p => !ids.includes(p.id))) throw new Error('INVALID_CATALOGUE');
    const done = manifest.pages.filter(p => p.disposition === 'done'); const failed = manifest.pages.filter(p => p.disposition === 'failed').map(p => p.id);
    if (manifest.mode === 'full' && ids.length && !done.length) throw new Error('ALL_PAGES_FAILED');
    const source = checkpoints.find(c => c.stage === 'source' && c.itemId === '' && c.disposition === 'done');
    if (!source || !Array.isArray(source.parsed) || source.parsed.some((item: unknown) => !item || typeof item !== 'object' || typeof (item as { path?: unknown }).path !== 'string' || typeof (item as { hash?: unknown }).hash !== 'string')) throw new Error('SOURCE_SNAPSHOT_REQUIRED');
    const sourceManifest = source.parsed as Array<{ path: string; hash: string }>;
    const normalizeScope = (input: unknown, fallback: string[]): string[] => {
      if (input === undefined) return fallback;
      if (!Array.isArray(input) || input.some(value => typeof value !== 'string' || !value)) throw new Error('INVALID_SOURCE_SCOPE');
      return [...new Set(input as string[])].sort();
    };
    const sourceScope = { include: normalizeScope(op.plan.include, ['**']), exclude: normalizeScope(op.plan.exclude, []) };
    const prior = this.partition(op.branch, op.locale); if (manifest.expectedPriorPublicationId === undefined || (prior?.id ?? null) !== manifest.expectedPriorPublicationId) throw new Error('BASELINE_CHANGED'); const pages = { ...(prior?.pages ?? {}) };
    for (const p of manifest.pages) { const cp = checkpoints.find(c => c.stage === 'page' && c.itemId === p.id); if (!cp || cp.disposition !== p.disposition) throw new Error('CHECKPOINT_MISMATCH'); if (p.disposition === 'done') { const body = cp.parsed as { markdown?: unknown } | null; if (!body || typeof body.markdown !== 'string' || !body.markdown.trim()) throw new Error('INVALID_PAGE_BODY'); pages[p.id] = cp.parsed; } }
    for (const id of manifest.deletedPageIds) delete pages[id];
    const publication: WikiPublication = { id: randomUUID(), operationId: op.id, branch: op.branch, locale: op.locale, baseline: manifest.baseline, sourceManifest, sourceScope, catalogue: manifest.catalogue, pages, requiredPageIds: done.map(p => p.id), coverage: { partial: !!failed.length, planned: ids.length, published: done.length, readable: Object.keys(pages).length, failed }, manifest };
    this.db.prepare('INSERT INTO publications VALUES(?,?,?,?,?)').run(publication.id, op.id, op.branch, op.locale, json(publication));
    this.db.prepare('INSERT INTO partitions VALUES(?,?,?) ON CONFLICT(branch,locale) DO UPDATE SET publication_id=excluded.publication_id').run(op.branch, op.locale, publication.id);
    this.db.prepare("UPDATE operations SET state='completed',publication_id=?,revision=revision+1 WHERE id=?").run(publication.id, op.id);
    this.db.prepare("UPDATE runs SET state='completed',finished_at=? WHERE id=?").run(Date.now(), op.runId!);
    this.event(this.get(op.id));
    this.db.prepare("INSERT INTO outbox(id,kind,payload) VALUES(?,'publication',?)").run(publication.id, json({ publicationId: publication.id, operationId: op.id, branch: op.branch, locale: op.locale })); return publication;
  }); }
  stage(f: WikiFence, stage: string, detail?: unknown): void { this.tx(() => { const op = this.check(f); this.db.prepare("INSERT INTO outbox(id,kind,payload) VALUES(?,'stage',?)").run(randomUUID(), json({ operationId: op.id, runId: op.runId, stage, ...(detail && typeof detail === 'object' ? { detail: Object.fromEntries(Object.entries(detail).filter(([key, value]) => ['total','processed','active','failed','completed','waiting'].includes(key) && typeof value === 'number' && Number.isFinite(value))) } : {}) })); }); }
  outbox(afterSeq = 0, limit = 100): Array<{ seq: number; id: string; kind: string; payload: unknown }> { if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_OUTBOX_PAGE'); return (this.db.prepare('SELECT seq,id,kind,payload FROM outbox WHERE acknowledged=0 AND seq>? ORDER BY seq LIMIT ?').all(afterSeq, limit) as Row[]).map(r => ({ ...r, payload: parse(r.payload) } as { seq: number; id: string; kind: string; payload: unknown })); }
  ackOutbox(id: string): void { this.db.prepare('UPDATE outbox SET acknowledged=1 WHERE id=?').run(id); }
}
















