import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiStore } from './store';
import { WikiService } from './service';
import type { WikiStartInput } from './contracts';

const request: WikiStartInput = { requestId: 'x', projectId: 'p', repositoryRoot: '/repo', branch: 'main', locale: 'zh', action: 'full', targetCommit: 'c', engine: 'qoder-wiki-local-v1', templateVersion: '1', model: { id: 'm' }, author: {}, plan: {}, spendingPolicy: {}, effectiveProfile: {}, authorization: { confirmed: true } };
const admission = { acquire: async () => ({ release() {} }) };
describe('native wiki lifecycle', () => {
  it('persists pause before abort and waits for the runner to drain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const store = new WikiStore(dir);
    let entered!: () => void, finish!: () => void; const ready = new Promise<void>(r => { entered = r; }); const drain = new Promise<void>(r => { finish = r; });
    const service = new WikiService(store, { admission, executeOperation: async (_op, ctx) => { entered(); await drain; ctx.checkpoint({ stage: 'page', itemId: 'a', disposition: 'done', raw: 'raw', parsed: { markdown: 'body' } }); } });
    try { const op = service.start(request); const run = service.run(op.id); await ready; const pausing = service.control(op.id, 'pause', service.query(op.id).revision); expect(pausing.state).toBe('pausing'); finish(); await run; expect(service.query(op.id).state).toBe('paused'); expect(store.checkpoints(op.id)[0].raw).toBe('raw'); const resumed = service.control(op.id, 'resume', service.query(op.id).revision); expect(resumed.state).toBe('queued'); expect(store.checkpoints(op.id)).toHaveLength(1); const paused = service.control(op.id, 'pause', resumed.revision); const cancelled = service.control(op.id, 'cancel', paused.revision); expect(cancelled.state).toBe('cancelled'); expect(store.checkpoints(op.id)).toHaveLength(1); expect(() => service.control(op.id, 'resume', cancelled.revision)).toThrow('INVALID_STATE'); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects publication after cancellation and rejects an expired owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const store = new WikiStore(dir);
    try { const op = store.accept(request); const fence = store.claim(op.id, 'owner', 60_000); store.control(op.id, 'cancel', store.get(op.id).revision); expect(() => store.publish(fence, { catalogue: [], pages: [], requiredStages: [], deletedPageIds: [], baseline: 'c', mode: 'full', expectedPriorPublicationId: null })).toThrow('CONTROL_PENDING'); store.release(fence); expect(() => store.checkpoint(fence, { stage: 'page', itemId: 'a', disposition: 'done', raw: '', parsed: {} })).toThrow('STALE_FENCE'); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects nonempty all-failed full publication', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const store = new WikiStore(dir);
    try { const op = store.accept(request); const f = store.claim(op.id, 'owner', 60_000); store.checkpoint(f, { stage: 'page', itemId: 'a', disposition: 'failed', raw: 'bad', parsed: null }); expect(() => store.publish(f, { catalogue: [{ id: 'a' }], pages: [{ id: 'a', disposition: 'failed' }], requiredStages: [], deletedPageIds: [], baseline: 'c', mode: 'full', expectedPriorPublicationId: null })).toThrow('ALL_PAGES_FAILED'); expect(store.partition('main', 'zh')).toBeUndefined(); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('partial publication', () => {
  it('retains an old failed page and records all eleven planned pages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const store = new WikiStore(dir);
    try {
      const first = store.accept(request); const f1 = store.claim(first.id, 'one', 60_000);
      store.checkpoint(f1, { stage: 'source', itemId: '', disposition: 'done', raw: '', parsed: [] });
      store.checkpoint(f1, { stage: 'page', itemId: 'p9', disposition: 'done', raw: 'old', parsed: { markdown: 'old' } });
      store.publish(f1, { mode: 'full', expectedPriorPublicationId: null, baseline: 'c', catalogue: [{ id: 'p9' }], requiredStages: [], pages: [{ id: 'p9', disposition: 'done' }], deletedPageIds: [] }); store.release(f1);
      const second = store.accept({ ...request, requestId: 'y', action: 'update', targetCommit: 'd' }); const f2 = store.claim(second.id, 'two', 60_000);
      store.checkpoint(f2, { stage: 'source', itemId: '', disposition: 'done', raw: '', parsed: [] });
      const catalogue = Array.from({ length: 11 }, (_, n) => ({ id: `p${n}` }));
      for (let n = 0; n < 11; n++) store.checkpoint(f2, { stage: 'page', itemId: `p${n}`, disposition: n < 9 ? 'done' : 'failed', raw: `raw${n}`, parsed: n < 9 ? { markdown: `body${n}` } : null });
      const publication = store.publish(f2, { mode: 'incremental', expectedPriorPublicationId: store.partition('main', 'zh')!.id, baseline: 'd', catalogue, requiredStages: [], pages: catalogue.map((p, n) => ({ id: p.id, disposition: n < 9 ? 'done' : 'failed' })), deletedPageIds: [] });
      expect(publication.requiredPageIds).toHaveLength(9); expect(publication.coverage.failed).toEqual(['p9', 'p10']); expect(publication.pages.p9).toEqual({ markdown: 'old' }); expect(publication.pages.p10).toBeUndefined(); expect(publication.coverage.readable).toBe(10);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('spending ledger', () => {
  it('reserves before dispatch, accounts actual usage across repair and rejects without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const store = new WikiStore(dir);
    try {
      const input = { ...request, spendingPolicy: { maxModelRequests: 2, maxTotalTokens: 100 } };
      const parent = store.accept(input); const f = store.claim(parent.id, 'one', 60_000);
      store.usage(f, { requestId: 'model1', state: 'dispatched', reservationTokens: 60 });
      expect(() => store.usage(f, { requestId: 'model2', state: 'dispatched', reservationTokens: 41 })).toThrow('SPENDING_LIMIT');
      expect(store.usageRecords(parent.id)).toHaveLength(1);
      store.usage(f, { requestId: 'model1', state: 'actual', totalTokens: 30 });
      const failed = store.settle(f, 'FAILED'); store.release(f);
      const child = store.accept({ ...input, requestId: 'repair', action: 'repair', parentOperationId: parent.id, expectedRevision: failed.revision });
      const f2 = store.claim(child.id, 'two', 60_000);
      store.usage(f2, { requestId: 'model2', state: 'dispatched', reservationTokens: 70 });
      store.usage(f2, { requestId: 'model2', state: 'unknown' });
      expect(store.aggregateUsageRecords(child.id)).toHaveLength(2);
      expect(store.aggregateUsageRecords(child.id)[1].reservationTokens).toBe(70);
      expect(() => store.usage(f2, { requestId: 'model3', state: 'dispatched', reservationTokens: 1 })).toThrow('SPENDING_LIMIT');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('admission and shutdown', () => {
  it('persists a safe admission error without starting work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const store = new WikiStore(dir);
    const service = new WikiService(store, { admission: { acquire: async () => { throw new Error('MODEL_CHANGED'); } }, executeOperation: async () => { throw new Error('unexpected'); } });
    try { const op = service.start(request); await expect(service.run(op.id)).rejects.toThrow('MODEL_CHANGED'); expect(service.query(op.id)).toMatchObject({ state: 'queued', error: 'MODEL_CHANGED' }); expect(service.outbox().some(e => e.kind === 'operation')).toBe(true); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('close aborts and waits for drain before leaving resumable paused state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const store = new WikiStore(dir);
    let entered!: () => void, finish!: () => void; const ready = new Promise<void>(r => { entered = r; }); const drain = new Promise<void>(r => { finish = r; });
    const service = new WikiService(store, { admission, executeOperation: async (_op, ctx) => { entered(); await drain; expect(ctx.signal.aborted).toBe(true); } });
    try { const op = service.start(request); const running = service.run(op.id); await ready; let closed = false; const close = service.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false); expect(service.query(op.id).state).toBe('pausing'); finish(); await Promise.all([close, running]); expect(service.query(op.id)).toMatchObject({ state: 'paused', error: 'APPLICATION_EXIT' }); await expect(service.run(op.id)).rejects.toThrow('SERVICE_CLOSED'); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});



describe('publication baseline CAS', () => {
  it('rejects publication when the partition changed since planning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const store = new WikiStore(dir);
    try {
      const first = store.accept(request); const f = store.claim(first.id, 'first', 60_000);
      store.checkpoint(f, { stage: 'source', itemId: '', disposition: 'done', raw: '', parsed: [] });
      store.checkpoint(f, { stage: 'page', itemId: 'p', disposition: 'done', raw: 'body', parsed: { markdown: 'body' } });
      const manifest = { mode: 'full' as const, baseline: 'c', expectedPriorPublicationId: null, catalogue: [{ id: 'p' }], requiredStages: [], pages: [{ id: 'p', disposition: 'done' as const }], deletedPageIds: [] };
      store.publish(f, manifest); store.release(f);
      const next = store.accept({ ...request, requestId: 'cas-next' }); const f2 = store.claim(next.id, 'next', 60_000);
      store.checkpoint(f2, { stage: 'source', itemId: '', disposition: 'done', raw: '', parsed: [] }); store.checkpoint(f2, { stage: 'page', itemId: 'p', disposition: 'done', raw: 'body', parsed: { markdown: 'body' } });
      expect(() => store.publish(f2, manifest)).toThrow('BASELINE_CHANGED');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
