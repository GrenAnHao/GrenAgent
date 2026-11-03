import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeWikiHost } from './host';
import { WikiStore } from './store';
import type { WikiStartInput } from './contracts';

const input = { requestId: 'host-1', projectId: 'project', repositoryRoot: '/repo', branch: 'main', locale: 'zh', action: 'full', targetCommit: 'commit', engine: 'qoder-wiki-local-v1', templateVersion: '1', model: { id: 'm' }, author: {}, plan: {}, spendingPolicy: {}, effectiveProfile: {}, authorization: { confirmed: true } };
describe('native host RPC', () => {
  it('keeps queued on startup and gates dispatch without disabling reads', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'native-wiki-host-')); const calls: string[] = [];
    const host = new NativeWikiHost(async kind => { calls.push(kind); return {}; });
    try {
      const first = await host.invoke('native.start', { dataDir, input }) as { id: string; revision: number };
      await expect(host.invoke('native.dispatch', { dataDir, operationId: first.id })).rejects.toThrow('NATIVE_EXECUTION_DISABLED');
      expect(await host.invoke('native.query', { dataDir, operationId: first.id })).toMatchObject({ id: first.id, state: 'queued' });
      expect(await host.invoke('native.list', { dataDir })).toHaveLength(1);
      expect(await host.invoke('native.list', { dataDir, summary: true, limit: 1 })).toMatchObject({ items: [{ id: first.id, state: 'queued' }], nextOffset: null });
      expect(calls).not.toContain('native.model'); expect(calls).not.toContain('native.admission');
      expect(await host.invoke('native.outbox', { dataDir })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'operation' })]));
    } finally { await host.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  it('rejects reuse of a project data directory for a different project', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'native-wiki-host-')); const host = new NativeWikiHost(async () => ({}));
    try { await host.invoke('native.start', { dataDir, input }); await expect(host.invoke('native.start', { dataDir, input: { ...input, requestId: 'host-2', projectId: 'other' } })).rejects.toThrow('DATA_DIR_IDENTITY_MISMATCH'); } finally { await host.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
});

describe('native RPC bounded reads', () => {
  it('paginates the outbox and rejoins UTF-16-safe publication chunks', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'native-wiki-host-')); const store = new WikiStore(dataDir);
    const op = store.accept(input as WikiStartInput); const fence = store.claim(op.id, 'test', 60_000);
    store.checkpoint(fence, { stage: 'source', itemId: '', disposition: 'done', raw: '', parsed: [] });
    store.checkpoint(fence, { stage: 'page', itemId: 'p', disposition: 'done', raw: '', parsed: { markdown: 'a'.repeat(262100) + '🧭'.repeat(1000) } });
    const pub = store.publish(fence, { mode: 'full', expectedPriorPublicationId: null, baseline: 'commit', catalogue: [{ id: 'p' }], requiredStages: [], pages: [{ id: 'p', disposition: 'done' }], deletedPageIds: [] });
    store.release(fence); store.close();
    const host = new NativeWikiHost(async () => ({}));
    try {
      const page = await host.invoke('native.outbox', { dataDir, limit: 1 }) as Array<{ seq: number }>;
      const next = await host.invoke('native.outbox', { dataDir, afterSeq: page[0].seq, limit: 1 }) as Array<{ seq: number }>;
      expect(next[0].seq).toBeGreaterThan(page[0].seq);
      let offset: number | null = 0; let json = '';
      while (offset !== null) { const part = await host.invoke('native.publicationChunk', { dataDir, publicationId: pub.id, offset }) as { chunk: string; nextOffset: number | null }; json += part.chunk; offset = part.nextOffset; }
      expect(JSON.parse(json)).toEqual(pub);
    } finally { await host.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
});
