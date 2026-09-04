import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from './jobStore';

describe('JobStore', () => {
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
