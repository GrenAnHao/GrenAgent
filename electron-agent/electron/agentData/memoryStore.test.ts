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

  it('persists capture cursors and returns only a new suffix', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const scope = { userId: 'u', workspace: '/a', sessionId: 's' };
    expect(store.capture(scope, 'session:s', 'user: one', 'fp1')).toEqual({ changed: true, delta: 'user: one', fingerprint: 'fp1' });
    store.commitCapture(scope, 'session:s', 'fp1');
    expect(store.capture(scope, 'session:s', 'user: one', 'fp1')).toEqual({ changed: false, delta: '', fingerprint: 'fp1' });
    expect(store.capture(scope, 'session:s', 'user: one\nassistant: two', 'fp2')).toEqual({ changed: true, delta: 'assistant: two', fingerprint: 'fp2' });
    db.close();
  });

  it('keeps a pending capture available until extraction commits it', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const scope = { userId: 'u', workspace: '/a', sessionId: 's' };
    store.capture(scope, 'session:s', 'user: one', 'fp1');
    expect(store.capture(scope, 'session:s', 'user: one', 'fp1')).toEqual({ changed: true, delta: 'user: one', fingerprint: 'fp1' });
    store.commitCapture(scope, 'session:s', 'fp1');
    expect(store.capture(scope, 'session:s', 'user: one', 'fp1')).toEqual({ changed: false, delta: '', fingerprint: 'fp1' });
    db.close();
  });

  it('recovers the cursor after reopening the store', () => {
    const db = new DatabaseSync(':memory:');
    const scope = { userId: 'u', workspace: '/a', sessionId: 's' };
    const first = new MemoryStore(db);
    first.capture(scope, 'session:s', 'user: one', 'fp1');
    first.commitCapture(scope, 'session:s', 'fp1');
    const reopened = new MemoryStore(db);
    expect(reopened.capture(scope, 'session:s', 'user: one\nassistant: two', 'fp2').delta).toBe('assistant: two');
    db.close();
  });
});
