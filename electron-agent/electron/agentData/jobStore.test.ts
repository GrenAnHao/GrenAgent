import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from './jobStore';
import { AuditViewStore } from './auditViewStore';

describe('JobStore', () => {
  it.each(['fail', 'complete', 'cancel'] as const)('retains resource snapshots for %s and removal after the task is deleted', (finish) => {
    const db = new DatabaseSync(':memory:'); const store = new JobStore(db); const audit = new AuditViewStore(db);
    try {
      const job = store.create({ kind: 'wiki.ingest', workspace: '', metadata: { target: { type: 'wiki', id: 'original-kb' }, resourceName: '原始库名' } });
      if (finish === 'fail') store.fail(job.id, 'fixture failure'); else store[finish](job.id);
      store.remove(job.id);
      const events = audit.query({ resource: { type: 'wiki', id: 'original-kb' } }).items;
      expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(['job.create', `job.${finish}`, 'job.remove']));
      expect(events.every((event) => event.resourceName === '原始库名')).toBe(true);
      expect(store.get(job.id)).toBeUndefined();
    } finally { db.close(); }
  });

  it('snapshots every cleared resource independently without assigning one name to multiple resources', () => {
    const db = new DatabaseSync(':memory:'); const store = new JobStore(db); const audit = new AuditViewStore(db);
    try {
      const ids = ['first', 'second'].map((id) => {
        const job = store.create({ kind: 'wiki.ingest', workspace: '', metadata: { target: { type: 'wiki', id }, resourceName: `${id} 原名` } });
        store.complete(job.id); return job.id;
      });
      store.clear(ids);
      for (const id of ['first', 'second']) {
        const cleanup = audit.query({ resource: { type: 'wiki', id } }).items.find((event) => event.action === 'job.remove' || event.action === 'job.clear');
        expect(cleanup).toMatchObject({ resource: { type: 'wiki', id }, resourceName: `${id} 原名` });
      }
    } finally { db.close(); }
  });

  it('keeps cancellation requested distinct from confirmed cancellation and records only changed active stages', () => {
    const db = new DatabaseSync(':memory:'); const store = new JobStore(db);
    try {
      const job = store.create({ kind: 'codegraph.sync', workspace: '/repo', metadata: { target: { type: 'project', id: '/repo' }, payload: { workspace: '/repo' }, retryOf: 'old' } });
      expect(store.requestCancellation(job.id)).toMatchObject({ state: 'pending', metadata: { cancellationRequested: true, retryOf: 'old' } });
      store.start(job.id);
      expect(store.recordStage(job.id, '正在构建')).toMatchObject({ state: 'running', metadata: { stage: '正在构建', cancellationRequested: true } });
      store.recordStage(job.id, '正在构建');
      expect(store.audit().filter((event) => event.action === 'job.stage')).toHaveLength(1);
      store.updateMetadata(job.id, { cancellationRequested: false });
      expect(store.requestCancellation(job.id)?.state).toBe('running');
      store.cancel(job.id);
      expect(store.recordStage(job.id, 'too late')).toMatchObject({ state: 'cancelled', metadata: { stage: '正在构建' } });
      expect(store.requestCancellation(job.id)?.state).toBe('cancelled');
    } finally { db.close(); }
  });

  it('isolates corrupt metadata and rolls back stage changes when their audit fails', () => {
    const db = new DatabaseSync(':memory:'); const store = new JobStore(db);
    try {
      const damaged = store.create({ kind: 'wiki.sync', workspace: '/repo' });
      db.prepare('UPDATE agent_jobs SET metadata=? WHERE id=?').run('{bad json', damaged.id);
      expect(store.get(damaged.id)?.metadata).toBeUndefined();
      expect(store.list()).toHaveLength(1);
      db.exec("CREATE TRIGGER reject_stage BEFORE INSERT ON agent_audit WHEN NEW.action='job.stage' BEGIN SELECT RAISE(ABORT, 'stage audit unavailable'); END");
      expect(() => store.recordStage(damaged.id, '正在读取', { processed: 0, total: 2 })).toThrow('stage audit unavailable');
      expect(store.get(damaged.id)?.metadata).toBeUndefined();
    } finally { db.close(); }
  });

  it('supports metadata writes inside a caller transaction even on runtimes without isTransaction', () => {
    const db = new DatabaseSync(':memory:');
    const legacyDb = new Proxy(db, { get(target, property) { const value = Reflect.get(target, property, target); return property === 'isTransaction' ? undefined : typeof value === 'function' ? value.bind(target) : value; } });
    const store = new JobStore(legacyDb);
    try {
      const job = store.create({ kind: 'wiki.ingest', workspace: '' });
      db.exec('BEGIN IMMEDIATE');
      expect(store.recordStage(job.id, '正在生成', { processed: 0, total: 1 })?.metadata?.stage).toBe('正在生成');
      db.exec('ROLLBACK');
      expect(store.get(job.id)?.metadata).toBeUndefined();
      expect(store.audit().filter((event) => event.action === 'job.stage')).toEqual([]);
    } finally { db.close(); }
  });

  it('migrates old job rows and persists optional Wiki metadata without changing workspace', () => {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE TABLE agent_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, workspace TEXT NOT NULL, state TEXT NOT NULL, progress INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO agent_jobs VALUES('legacy','wiki.sync','/repo','completed',100,NULL,1,2)");
    const store = new JobStore(db);
    const metadata = { target: { type: 'wiki' as const, id: 'kb-1' }, payload: { kbId: 'kb-1', sourceIds: ['source-1'] }, retryOf: 'previous' };
    try {
      const job = store.create({ kind: 'wiki.ingest', workspace: '', metadata });
      expect(store.get('legacy')).toMatchObject({ workspace: '/repo', state: 'completed', metadata: undefined });
      expect(store.get(job.id)).toMatchObject({ workspace: '', metadata });
      expect(new JobStore(db).list()).toEqual(expect.arrayContaining([expect.objectContaining({ id: job.id, metadata })]));
      expect(db.prepare('PRAGMA table_info(agent_jobs)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'workspace', notnull: 1 })]));
    } finally { db.close(); }
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('deletes a %s job while retaining its audit history', (state) => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const job = store.create({ kind: 'wiki.sync', workspace: '/repo' });
    db.prepare('UPDATE agent_jobs SET state=? WHERE id=?').run(state, job.id);
    const auditBefore = store.audit();
    try {
      expect(store).toHaveProperty('remove');
      expect(store.remove(job.id)).toEqual({ deleted: true });
      expect(store.get(job.id)).toBeUndefined();
      expect(store.audit()).toEqual(expect.arrayContaining(auditBefore));
      expect(store.audit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'job.remove', detail: { id: job.id } })]));
      expect(store.remove(job.id)).toEqual({ deleted: false });
    } finally { db.close(); }
  });

  it.each(['pending', 'running'] as const)('rejects deleting a %s job', (state) => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const job = store.create({ kind: 'codegraph.sync', workspace: '/repo' });
    db.prepare('UPDATE agent_jobs SET state=? WHERE id=?').run(state, job.id);
    try {
      expect(store).toHaveProperty('remove');
      expect(() => store.remove(job.id)).toThrow('JOB_ACTIVE');
      expect(store.get(job.id)).toMatchObject({ state });
      expect(store.audit().map((entry) => entry.action)).not.toContain('job.remove');
    } finally { db.close(); }
  });

  it('clears only requested terminal IDs, preserving active jobs and unrelated records', () => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const completed = store.create({ kind: 'wiki.sync', workspace: '/repo' });
    const cancelled = store.create({ kind: 'codegraph.sync', workspace: '/repo' });
    const other = store.create({ kind: 'wiki.sync', workspace: '/other' });
    const active = store.create({ kind: 'codegraph.sync', workspace: '/active' });
    store.complete(completed.id); store.cancel(cancelled.id); store.fail(other.id, 'failure'); store.start(active.id);
    const auditBefore = store.audit();
    try {
      expect(store).toHaveProperty('clear');
      expect(store.clear([completed.id, cancelled.id, active.id, completed.id, 'missing'])).toEqual({ deletedIds: [completed.id, cancelled.id] });
      expect(store.list().map((job) => job.id).sort()).toEqual([other.id, active.id].sort());
      expect(store.audit()).toEqual(expect.arrayContaining(auditBefore));
      expect(store.clear([])).toEqual({ deletedIds: [] });
      expect(store.clear([completed.id])).toEqual({ deletedIds: [] });
    } finally { db.close(); }
  });

  it('rolls back record deletion when writing the cleanup audit fails', () => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const job = store.create({ kind: 'wiki.sync', workspace: '/repo' });
    store.complete(job.id);
    db.exec("CREATE TRIGGER reject_cleanup_audit BEFORE INSERT ON agent_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    try {
      expect(store).toHaveProperty('clear');
      expect(() => store.clear([job.id])).toThrow('audit unavailable');
      expect(store.get(job.id)).toMatchObject({ state: 'completed' });
    } finally { db.close(); }
  });

  it('creates jobs, records audit events, and rejects stale config versions', () => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const job = store.create({ kind: 'wiki-sync', workspace: '/repo' });
    expect(store.get(job.id)).toMatchObject({ state: 'pending', kind: 'wiki-sync' });
    expect(store.list()).toHaveLength(1);
    db.prepare("UPDATE agent_jobs SET state='running' WHERE id=?").run(job.id);
    expect(store.list('running')).toHaveLength(1);
    expect(store.list('completed')).toHaveLength(0);
    expect(() => store.updateConfig('memory', { enabled: true }, 1)).toThrow('VERSION_CONFLICT');
    expect(store.updateConfig('memory', { enabled: true }, 0)).toMatchObject({ version: 1, value: { enabled: true } });
    expect(store.audit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'config.update' })]));
    db.close();
  });

  it('advances a job through running, progress, and completion', () => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const job = store.create({ kind: 'wiki.sync', workspace: '/repo' });

    expect(store.start(job.id)).toMatchObject({ state: 'running', progress: 0 });
    expect(store.progress(job.id, 40)).toMatchObject({ state: 'running', progress: 40 });
    expect(store.progress(job.id, 999)).toMatchObject({ progress: 100 });
    expect(store.complete(job.id)).toMatchObject({ state: 'completed', progress: 100 });
    db.close();
  });

  it('records a failure reason and refuses to advance a cancelled job', () => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const failing = store.create({ kind: 'codegraph.sync', workspace: '/repo' });
    store.start(failing.id);
    expect(store.fail(failing.id, 'codegraph exited with 1')).toMatchObject({ state: 'failed', error: 'codegraph exited with 1' });

    const cancelled = store.create({ kind: 'codegraph.sync', workspace: '/other' });
    store.cancel(cancelled.id);
    expect(store.start(cancelled.id)).toMatchObject({ state: 'cancelled' });
    expect(store.progress(cancelled.id, 50)).toMatchObject({ state: 'cancelled', progress: 0 });
    db.close();
  });

  it('reports whether a workspace already has an active job of a kind', () => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const job = store.create({ kind: 'codegraph.sync', workspace: '/repo' });

    expect(store.hasActive('codegraph.sync', '/repo')).toBe(true);
    expect(store.hasActive('codegraph.sync', '/other')).toBe(false);
    expect(store.hasActive('wiki.sync', '/repo')).toBe(false);
    store.complete(job.id);
    expect(store.hasActive('codegraph.sync', '/repo')).toBe(false);
    db.close();
  });
});
