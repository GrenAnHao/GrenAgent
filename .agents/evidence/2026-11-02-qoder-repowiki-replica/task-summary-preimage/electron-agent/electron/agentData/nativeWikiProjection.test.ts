import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from './jobStore';
import { migrateKnowledgeKernel } from './knowledgeKernel/store';
import { NativeWikiProjection } from './nativeWikiProjection';
describe('native Wiki projection and target lease', () => {
  it('blocks legacy lease ownership and projects newer states without scheduling work', () => {
    const db = new DatabaseSync(':memory:');
    try {
      new JobStore(db); migrateKnowledgeKernel(db); const projection = new NativeWikiProjection(db);
      const op: any = { id: 'op', repositoryRoot: '/repo', locale: 'zh', revision: 0, state: 'queued' };
      projection.apply(op); const lease = projection.admit(op, 'scope');
      expect((db.prepare('SELECT pinned FROM agent_job_leases WHERE scope=?').get('scope') as any).pinned).toBe(1);
      expect(() => projection.admit({ ...op, id: 'other' }, 'scope')).toThrow('LEASE_BUSY');
      projection.apply({ ...op, revision: 2, state: 'completed' }); projection.apply({ ...op, revision: 1, state: 'running' });
      expect((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get('native:op') as any).state).toBe('completed');
      projection.release(op, lease); expect((db.prepare('SELECT pinned FROM agent_job_leases WHERE scope=?').get('scope') as any).pinned).toBe(0);
    } finally { db.close(); }
  });
});
