import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from './jobStore';
import { migrateKnowledgeKernel } from './knowledgeKernel/store';
import { NativeWikiProjection } from './nativeWikiProjection';
import { TaskViewStore } from './taskViewStore';
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
  it('projects partial publication and a later repaired file projection idempotently into task detail', () => {
    const db = new DatabaseSync(':memory:');
    try {
      new JobStore(db); migrateKnowledgeKernel(db); const projection = new NativeWikiProjection(db), views = new TaskViewStore(db);
      const op: any = { id: 'op', repositoryRoot: '/repo', locale: 'zh', revision: 3, state: 'completed', publicationId: 'pub' };
      projection.apply(op);
      const summary = { id: 'pub', coverage: { published: 9, readable: 10, failed: ['a', 'b'], partial: true }, projection: { status: 'error' as const } };
      projection.publication(op, summary); projection.publication(op, summary);
      expect(views.readDetail({ source: 'user', id: 'native:op' })).toMatchObject({ status: 'completed', nativeWiki: { engine: 'qoder-wiki-local-v1', operationId: 'op', revision: 3, publication: summary } });
      projection.publication(op, { ...summary, projection: { status: 'ready' } });
      expect(views.readDetail({ source: 'user', id: 'native:op' })?.nativeWiki?.publication?.projection.status).toBe('ready');
      projection.publication({ ...op, revision: 2 }, { ...summary, projection: { status: 'error' } });
      expect(views.readDetail({ source: 'user', id: 'native:op' })?.nativeWiki?.publication?.projection.status).toBe('ready');
      expect(() => projection.publication(op, { ...summary, id: 'different' })).toThrow('NATIVE_PUBLICATION_MISMATCH');
    } finally { db.close(); }
  });
  it('protects referenced completed native jobs from remove and clear while allowing legacy deletion', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const jobs = new JobStore(db); const projection = new NativeWikiProjection(db); const views = new TaskViewStore(db);
      const op: any = { id: 'op', repositoryRoot: '/repo', locale: 'zh', revision: 1, state: 'completed', publicationId: 'pub' };
      projection.apply(op);
      const legacy = jobs.create({ kind: 'repoWiki.generate', workspace: '/repo' });
      db.prepare("UPDATE agent_jobs SET state='completed' WHERE id=?").run(legacy.id);
      expect(views.read({ source: 'user', id: 'native:op' })).toMatchObject({ capabilities: { remove: false, removeReason: 'native_referenced' } });
      expect(() => jobs.remove('native:op')).toThrow('JOB_REFERENCED');
      expect(() => jobs.clear([legacy.id, 'native:op'])).toThrow('JOB_REFERENCED');
      expect(jobs.get(legacy.id)).toBeDefined(); // whole clear is transactional
      expect(jobs.remove(legacy.id).deleted).toBe(true);
      projection.publication(op, { id: 'pub', coverage: { published: 1, readable: 1, failed: [], partial: false }, projection: { status: 'ready' } });
      expect(views.readDetail({ source: 'user', id: 'native:op' })?.nativeWiki?.publication?.id).toBe('pub');
    } finally { db.close(); }
  });

});
