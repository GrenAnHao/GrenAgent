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
    expect(() => store.updateConfig('memory', { enabled: true }, 1)).toThrow('VERSION_CONFLICT');
    expect(store.updateConfig('memory', { enabled: true }, 0)).toMatchObject({ version: 1, value: { enabled: true } });
    expect(store.audit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'config.update' })]));
    db.close();
  });
});
