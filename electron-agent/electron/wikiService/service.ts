import { randomUUID } from 'node:crypto';
import type { WikiOperation, WikiServicePorts, WikiStartInput } from './contracts';
import type { WikiFence } from './contracts';
import { WikiStore } from './store';

/** The runner owns its internal pool and must resolve only after all work has drained. */
export class WikiService {
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly fences = new Map<string, WikiFence>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(private readonly store: WikiStore, private readonly ports: WikiServicePorts) {}
  start(input: WikiStartInput): WikiOperation { if (this.closed) throw new Error('SERVICE_CLOSED'); return this.store.accept(input); }
  recoverInterrupted(id: string): WikiOperation { if (this.isActive(id)) throw new Error('OPERATION_ACTIVE'); return this.store.recoverInterrupted(id); }
  isActive(id: string): boolean { return this.active.has(id); }
  requestDispatched(id: string, requestId: string): void { const fence = this.fences.get(id); if (!fence) throw new Error('NOT_ACTIVE'); if (!this.store.usageRecords(id).some(usage => usage.requestId === requestId && usage.state === 'dispatched')) throw new Error('REQUEST_NOT_DISPATCHABLE'); const submitted = this.store.events(id).reverse().find(event => event.kind === 'model-submitted' && event.requestId === requestId); if (!submitted) throw new Error('REQUEST_NOT_FOUND'); if (this.store.events(id).some(event => event.kind === 'model-dispatched' && event.requestId === requestId)) return; this.store.sessionEvent(fence, { ...submitted, kind: 'model-dispatched' }); }
  query(id: string): WikiOperation { return this.store.get(id); }
  partition(branch: string, locale: string) { return this.store.partition(branch, locale); }
  publication(id: string) { return this.store.publication(id); }
  outbox(afterSeq = 0, limit = 100) { return this.store.outbox(afterSeq, limit); }
  ackOutbox(id: string): void { this.store.ackOutbox(id); }
  control(id: string, action: 'pause' | 'cancel' | 'resume', expectedRevision: number): WikiOperation {
    const op = this.store.control(id, action, expectedRevision);
    if (action !== 'resume') this.active.get(id)?.controller.abort();
    return op;
  }
  run(id: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('SERVICE_CLOSED'));
    const existing = this.active.get(id); if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.execute(id, controller).finally(() => this.active.delete(id));
    this.active.set(id, { controller, promise }); return promise;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const pending = [...this.active.entries()];
    for (const [id, active] of pending) {
      const op = this.store.get(id);
      if (op.state === 'queued' || op.state === 'running') this.store.control(id, 'pause', op.revision, 'application_exit');
      active.controller.abort();
    }
    this.closePromise = Promise.allSettled(pending.map(([, active]) => active.promise)).then(() => undefined);
    return this.closePromise;
  }
  private async execute(id: string, controller: AbortController): Promise<void> {
    const initial = this.store.get(id); if (initial.state !== 'queued') throw new Error('INVALID_STATE');
    let admission: Awaited<ReturnType<WikiServicePorts['admission']['acquire']>> | undefined;
    try { admission = await this.ports.admission.acquire(initial, controller.signal); }
    catch (error) { if (controller.signal.aborted) return; this.store.admissionError(id, error instanceof Error ? error.message : 'ADMISSION_FAILED'); throw error; }
    let fence: ReturnType<WikiStore['claim']> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      if (controller.signal.aborted || this.store.get(id).state !== 'queued') return;
      const leaseMs = this.ports.leaseMs ?? 30000;
      fence = this.store.claim(id, randomUUID(), leaseMs);
      const activeFence = fence; this.fences.set(id, fence);
      timer = setInterval(() => { try { this.store.heartbeat(activeFence, leaseMs); } catch { controller.abort(); } }, Math.max(1, Math.floor(leaseMs / 3)));
      const op = this.store.get(id);
      await this.ports.executeOperation(op, {
        signal: controller.signal,
        checkpoints: () => this.store.checkpoints(id),
        checkpointHistory: () => this.store.checkpointHistory(id),
        usageRecords: () => this.store.aggregateUsageRecords(id),
        aggregateUsageRecords: () => this.store.aggregateUsageRecords(id),
        publication: publicationId => this.store.publication(publicationId),
        event: value => this.store.sessionEvent(activeFence, value),
        published: () => this.store.partition(op.branch, op.locale),
        stage: (stage, detail) => this.store.stage(activeFence, stage, detail),
        checkpoint: value => this.store.checkpoint(activeFence, value),
        usage: value => this.store.usage(activeFence, value),
        publish: manifest => this.store.publish(activeFence, manifest),
      });
      this.store.settle(activeFence);
    } catch (error) {
      if (!fence) { this.store.admissionError(id, error instanceof Error ? error.message : 'ADMISSION_FAILED'); throw error; }
      // A lost fence belongs to its new owner; never overwrite its state.
      try { this.store.settle(fence, error instanceof Error ? error.message : 'RUN_FAILED'); } catch { /* lease lost */ }
    } finally {
      this.fences.delete(id);
      if (timer) clearInterval(timer);
      if (fence) { try { this.store.release(fence); } catch { /* already expired or replaced */ } }
      await admission.release();
    }
  }
}




