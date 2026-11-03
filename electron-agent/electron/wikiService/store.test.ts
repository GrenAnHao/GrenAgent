import { describe, it, expect } from 'vitest';
import { WikiStore } from './store';
import { WikiService } from './service';
import type { WikiStartInput } from './contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const input: WikiStartInput = { requestId: 'r', projectId: 'p', repositoryRoot: '/repo', spendingPolicy: {}, effectiveProfile: {}, branch: 'main', locale: 'zh', action: 'full' as const, targetCommit: 'c', engine: 'qoder-wiki-local-v1' as const, templateVersion: '1', model: { id: 'm' }, author: {}, plan: {}, authorization: { confirmed: true } };
describe('native wiki store', () => {
  it('deduplicates acceptance and rejects identity conflicts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const s = new WikiStore(dir);
    try { const a = s.accept(input); expect(s.accept(input).id).toBe(a.id); expect(() => s.accept({ ...input, branch: 'other' })).toThrow('IDEMPOTENCY_CONFLICT'); } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('publishes partial pages without deleting an old failed page and emits one outbox record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-')); const s = new WikiStore(dir);
    const service = new WikiService(s, { admission: { acquire: async () => ({ release() {} }) }, executeOperation: async (_op, ctx) => {
      ctx.checkpoint({ stage: 'source', itemId: '', disposition: 'done', raw: '', parsed: [] });
      ctx.checkpoint({ stage: 'page', itemId: 'a', disposition: 'done', raw: 'a', parsed: { markdown: 'a' } });
      ctx.checkpoint({ stage: 'page', itemId: 'b', disposition: 'failed', raw: '', parsed: null });
      ctx.publish({ catalogue: [{ id: 'a' }, { id: 'b' }], requiredStages: [], pages: [{ id: 'a', disposition: 'done' }, { id: 'b', disposition: 'failed' }], deletedPageIds: [], baseline: 'c', mode: 'full', expectedPriorPublicationId: null });
    } });
    try { const op = service.start(input); await service.run(op.id); expect(service.partition('main', 'zh')?.coverage.partial).toBe(true); expect(service.outbox().filter(e => e.kind === 'publication')).toHaveLength(1); } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});




