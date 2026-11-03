import { resolve, isAbsolute } from 'node:path';
import { WikiService } from './service';
import { WikiStore } from './store';
import { createWikiExecutor } from './runner';
import type { WikiModelRequest, WikiModelTurn } from './sessionRuntime';
import type { WikiStartInput } from './contracts';

type Reverse = (kind: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
type Instance = { store: WikiStore; service: WikiService };

/** Lives in the existing repo-wiki-host. The main process owns trust and dataDir mapping. */
export class NativeWikiHost {
  private enabled = false;
  private drained = false;
  private draining?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly instances = new Map<string, Instance>();
  private readonly notifications = new Set<string>();
  constructor(private readonly reverse: Reverse, private readonly project?: { invoke(method: string, input: any): Promise<unknown> }) {}
  private instance(dataDir: unknown): Instance {
    if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) throw new Error('INVALID_DATA_DIR');
    const dir = resolve(dataDir); const old = this.instances.get(dir); if (old) return old;
    const store = new WikiStore(dir);
    const executor = createWikiExecutor({ requestModel: ({ signal, ...request }: WikiModelRequest) => this.reverse('native.model', { dataDir: dir, ...request }, signal) as Promise<WikiModelTurn> });
    const executeOperation: typeof executor = (operation, context) => executor(operation, {
      ...context,
      stage: (stage, detail) => { context.stage(stage, detail); this.notify(dir); },
      event: value => { context.event(value); this.notify(dir); },
      publish: manifest => { const publication = context.publish(manifest); this.notify(dir); return publication; },
    });
    const service = new WikiService(store, {
      admission: { acquire: async (operation, signal) => {
        const result = await this.reverse('native.admission', { dataDir: dir, operation }, signal) as { leaseId?: unknown };
        if (!result || typeof result.leaseId !== 'string' || !result.leaseId) throw new Error('ADMISSION_FAILED');
        return { release: async () => { await this.reverse('native.release', { dataDir: dir, operation, leaseId: result.leaseId }); } };
      } }, executeOperation,
    });
    const instance = { store, service }; this.instances.set(dir, instance); return instance;
  }
  private notify(dataDir: string): void { if (this.notifications.has(dataDir)) return; this.notifications.add(dataDir); queueMicrotask(() => { this.notifications.delete(dataDir); if (!this.closed) void this.reverse('native.event', { dataDir }).catch(() => {}); }); }
  async invoke(method: string, value: any): Promise<unknown> {
    if (this.closed) throw new Error('NATIVE_HOST_CLOSED');
    if (this.closing && !['native.query', 'native.list', 'native.partition', 'native.publication', 'native.publicationChunk', 'native.outbox', 'native.ack', 'native.project.project', 'native.project.projectionStatus'].includes(method)) throw new Error('NATIVE_HOST_CLOSING');
    if (!value || typeof value !== 'object') throw new Error('INVALID_NATIVE_REQUEST');
    if (method === 'native.drain') { this.enabled = false; this.drained = true; this.draining ??= Promise.all([...this.instances.values()].map(({ service }) => service.close())).then(() => undefined); await this.draining; return { drained: true }; }
    if (['native.project.prepare', 'native.project.authorRead', 'native.project.authorSave', 'native.project.authorConvert', 'native.project.project', 'native.project.projectionStatus'].includes(method)) {
      if (!this.project) throw new Error('PROJECT_ADAPTER_UNAVAILABLE');
      if (['native.project.project', 'native.project.projectionStatus'].includes(method) && value.publicationId) {
        const publication = this.instance(value.dataDir).store.publication(value.publicationId);
        if (!publication) throw new Error('PUBLICATION_NOT_FOUND');
        return this.project.invoke(method, { ...value, publication });
      }
      return this.project.invoke(method, value);
    }
    if (method === 'native.configure') { if (this.drained && value.enabled === true) throw new Error('NATIVE_HOST_DRAINED'); if (typeof value.enabled !== 'boolean') throw new Error('INVALID_NATIVE_REQUEST'); this.enabled = value.enabled; return { enabled: this.enabled }; }
    if (!['native.inspect', 'native.events', 'native.draftChunk', 'native.requestDispatched', 'native.start', 'native.query', 'native.list', 'native.control', 'native.dispatch', 'native.partition', 'native.publication', 'native.publicationChunk', 'native.outbox', 'native.ack', 'native.recover'].includes(method)) throw new Error('UNKNOWN_NATIVE_METHOD');
    if (typeof value.dataDir !== 'string' || !isAbsolute(value.dataDir)) throw new Error('INVALID_DATA_DIR');
    const dataDir = resolve(value.dataDir); const { service, store } = this.instance(dataDir);
    switch (method) {
      case 'native.start': {
        const input = value.input as WikiStartInput;
        const existing = store.list();
        if (!input || existing.some(op => op.projectId !== input.projectId || op.repositoryRoot !== input.repositoryRoot)) throw new Error('DATA_DIR_IDENTITY_MISMATCH');
        const result = service.start(input); this.notify(dataDir); return result;
      }
      case 'native.list': {
        const all = store.list(); if (value.summary !== true) return all;
        const offset = value.offset ?? 0, limit = value.limit ?? 100;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
        return { items: all.slice(offset, offset + limit).map(({ id, revision, state, branch, locale, publicationId }) => ({ id, revision, state, branch, locale, ...(publicationId ? { publicationId } : {}) })), nextOffset: offset + limit < all.length ? offset + limit : null };
      }
      case 'native.inspect': {
        const all = store.checkpoints(value.operationId); const offset = value.offset ?? 0; const limit = value.limit ?? 100;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
        const operation = service.query(value.operationId); const active = service.isActive(value.operationId); const events = store.events(value.operationId); const currentEvents = active ? events.filter(e => e.runId === operation.runId) : []; const usage = store.aggregateUsageRecords(value.operationId);
        const count = (kind: string) => events.filter(e => e.kind === kind).length;
        const submitted = count('model-submitted'), dispatched = count('model-dispatched'), completed = count('model-completed'); const submittedIds = new Set(currentEvents.filter(e => e.kind === 'model-submitted').map(e => e.requestId)); const dispatchedIds = new Set(currentEvents.filter(e => e.kind === 'model-dispatched').map(e => e.requestId)); const currentUsage = active ? store.usageRecords(value.operationId).filter(u => submittedIds.has(u.requestId)) : [];
        return { operation, active, checkpoints: all.slice(offset, offset + limit).map(({ stage, itemId, disposition, attempt, error }) => ({ stage, itemId, disposition, attempt, error })), nextOffset: offset + limit < all.length ? offset + limit : null, accounting: { activeSessions: Math.max(0, currentEvents.filter(e => e.kind === 'session-start').length - currentEvents.filter(e => e.kind === 'session-finish').length), submitted, waiting: currentUsage.filter(u => u.state === 'dispatched' && !dispatchedIds.has(u.requestId)).length, dispatched, inFlight: currentUsage.filter(u => u.state === 'dispatched' && dispatchedIds.has(u.requestId)).length, settled: completed, toolsStarted: count('tool-start'), toolsFinished: count('tool-finish'), unknown: usage.filter(u => u.state === 'unknown').length } };
      }
      case 'native.events': { const offset = value.offset ?? 0, limit = value.limit ?? 100; if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE'); const events = store.events(value.operationId); return { events: events.slice(offset, offset + limit), nextOffset: offset + limit < events.length ? offset + limit : null }; }
      case 'native.requestDispatched': service.requestDispatched(value.operationId, value.requestId); this.notify(dataDir); return { recorded: true };
      case 'native.draftChunk': { const checkpoint = store.checkpoints(value.operationId).find(c => c.stage === value.stage && c.itemId === value.itemId); if (!checkpoint) throw new Error('CHECKPOINT_NOT_FOUND'); const serialized = JSON.stringify(checkpoint); const offset = value.offset ?? 0; if (!Number.isSafeInteger(offset) || offset < 0 || offset > serialized.length || (offset > 0 && offset < serialized.length && /[\uD800-\uDBFF]/.test(serialized[offset - 1]) && /[\uDC00-\uDFFF]/.test(serialized[offset]))) throw new Error('INVALID_CHUNK_OFFSET'); let end = Math.min(serialized.length, offset + 262144); if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1]) && /[\uDC00-\uDFFF]/.test(serialized[end])) end--; return { chunk: serialized.slice(offset, end), nextOffset: end < serialized.length ? end : null }; }
      case 'native.query': return service.query(value.operationId);
      case 'native.control': { if (!['pause', 'cancel', 'resume'].includes(value.action) || !Number.isSafeInteger(value.expectedRevision)) throw new Error('INVALID_NATIVE_REQUEST'); const op = service.control(value.operationId, value.action, value.expectedRevision); this.notify(dataDir); return op; }
      case 'native.dispatch': {
        if (!this.enabled) throw new Error('NATIVE_EXECUTION_DISABLED');
        const op = service.query(value.operationId); if (op.state !== 'queued') throw new Error('INVALID_STATE');
        void service.run(op.id).catch(() => {}).finally(() => this.notify(dataDir));
        return service.query(op.id);
      }
      case 'native.partition': { const publication = service.partition(value.branch, value.locale); if (!publication) return null; return value.summary === true ? { id: publication.id, operationId: publication.operationId, branch: publication.branch, locale: publication.locale, baseline: publication.baseline, coverage: publication.coverage } : publication; }
      case 'native.publication': return service.publication(value.publicationId) ?? null;
      case 'native.publicationChunk': {
        const publication = service.publication(value.publicationId); if (!publication) throw new Error('PUBLICATION_NOT_FOUND');
        const serialized = JSON.stringify(publication); const offset = value.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > serialized.length || (offset > 0 && offset < serialized.length && /[\uD800-\uDBFF]/.test(serialized[offset - 1]) && /[\uDC00-\uDFFF]/.test(serialized[offset]))) throw new Error('INVALID_CHUNK_OFFSET');
        let end = Math.min(serialized.length, offset + 262144);
        if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1]) && /[\uDC00-\uDFFF]/.test(serialized[end])) end--;
        return { chunk: serialized.slice(offset, end), nextOffset: end < serialized.length ? end : null };
      }
      case 'native.outbox': return service.outbox(value.afterSeq ?? 0, value.limit ?? 100);
      case 'native.ack': service.ackOutbox(value.id); return { acknowledged: true };
      case 'native.recover': {
        if (service.isActive(value.operationId)) throw new Error('OPERATION_ACTIVE');
        if (value.previousExecutorExited !== true) throw new Error('PREVIOUS_EXECUTOR_EXIT_REQUIRED');
        const op = service.recoverInterrupted(value.operationId); this.notify(dataDir); return op;
      }
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await Promise.all([...this.instances.values()].map(({ service }) => service.close()));
      for (const { store } of this.instances.values()) store.close();
      this.instances.clear(); this.closed = true;
    })();
    return this.closing;
  }
}




