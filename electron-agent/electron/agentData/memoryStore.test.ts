import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from './memoryStore';

describe('MemoryStore', () => {
  it('upserts idempotently and filters by workspace/session scope', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const scope = { userId: 'u', workspace: '/a', sessionId: 's' };
    const first = store.upsert(scope, { level: 0, content: '{"x":1}' });
    const second = store.upsert(scope, { level: 0, content: '{"x":1}' });
    store.upsert({ ...scope, workspace: '/b' }, { level: 0, content: 'other' });
    expect(second.id).toBe(first.id);
    expect(store.search(scope, 'x')).toHaveLength(1);
    expect(store.search({ ...scope, workspace: '/b' }, 'x')).toHaveLength(0);
    db.close();
  });
});
