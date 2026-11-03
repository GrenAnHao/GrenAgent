import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetForTest } from '../../../../extensions/_shared/runtime-config.js';
import { WikiService } from './service';

describe('knowledge model slot', () => {
  it('returns the work result through the shared limiter', async () => {
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root: '.', db, complete: async () => 'ok' });
    await expect(service.withKnowledgeModelSlot(async () => 42)).resolves.toBe(42);
    db.close();
  });

  it('shares one slot with old Wiki completion and cancels queued new turns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-slot-'));
    const previous = process.env.PI_RUNTIME_CONFIG;
    const config = join(root, 'config.json');
    writeFileSync(config, JSON.stringify({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '1' }));
    process.env.PI_RUNTIME_CONFIG = config; __resetForTest();
    const db = new DatabaseSync(':memory:');
    let release!: () => void, started = false, dispatched = false;
    const holding = new Promise<void>(resolve => { release = resolve; });
    const service = new WikiService({ root, db, complete: async () => { started = true; await holding; return 'ok'; } });
    try {
      const old = service.completeKnowledge({ user: 'old' });
      await vi.waitFor(() => expect(started).toBe(true));
      const abort = new AbortController();
      const next = service.withKnowledgeModelSlot(async () => { dispatched = true; }, abort.signal);
      abort.abort(); await expect(next).rejects.toThrow();
      expect(dispatched).toBe(false);
      release(); await old;
      await service.withKnowledgeModelSlot(async () => { dispatched = true; });
      expect(dispatched).toBe(true);
    } finally {
      release(); db.close(); if (previous === undefined) delete process.env.PI_RUNTIME_CONFIG; else process.env.PI_RUNTIME_CONFIG = previous;
      __resetForTest(); rmSync(root, { recursive: true, force: true });
    }
  });
});
