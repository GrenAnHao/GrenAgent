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

  it('stores project and global scope metadata and filters across projects', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    store.upsert({ userId: 'u', projectId: 'project-A', workspace: '/a', scope: 'global' }, { level: 1, content: 'global fact' });
    store.upsert({ userId: 'u', projectId: 'project-A', workspace: '/a' }, { level: 1, content: 'a fact' });
    store.upsert({ userId: 'u', projectId: 'project-B', workspace: '/b' }, { level: 1, content: 'b fact' });
    // Scope membership is independent of the ordering of equal-millisecond writes.
    expect(store.search({ userId: 'u', projectId: 'project-A', workspace: '/a' }, 'fact').map((item) => item.content).sort()).toEqual(['a fact', 'global fact']);
    expect(store.search({ userId: 'u', projectId: 'project-A', workspace: '/a', includeOtherProjects: true }, 'fact')).toHaveLength(3);
    db.close();
  });

  it('backfills project_id on rows written before that column existed, on every open', () => {
    const db = new DatabaseSync(':memory:');
    // 复现 project_id 加列前遗留下的行：直接绕过 MemoryStore 写入旧形状的记录
    // （memory_scope 默认 'project'，project_id 缺省为 NULL）。
    db.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT,
      level INTEGER NOT NULL, content TEXT NOT NULL, source TEXT, fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.prepare(`INSERT INTO memories(id,user_id,workspace,level,content,fingerprint,created_at,updated_at)
      VALUES('legacy-1','u','/legacy',0,'legacy content','fp-legacy',1,1)`).run();

    // 打开（构造）时立即补齐缺失的列并回填 project_id，同一次 open 内就必须生效——
    // 不能要等到 project_id 列本就存在的「下一次」打开才生效，否则历史数据永久搜不到。
    const store = new MemoryStore(db);
    expect((db.prepare('SELECT project_id FROM memories WHERE id=?').get('legacy-1') as { project_id: string | null }).project_id).toBe('/legacy');
    expect(store.search({ userId: 'u', workspace: '/legacy' }, 'legacy').map((item) => item.content)).toEqual(['legacy content']);
    expect(store.overview({ userId: 'u', workspace: '/legacy' })).toMatchObject({ total: 1, byLevel: { L0: 1, L1: 0, L2: 0, L3: 0 } });
    db.close();
  });

  it('removes a record owned by the user even when queried from another project scope', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const recordInB = store.upsert({ userId: 'u', projectId: 'project-B', workspace: '/b' }, { level: 1, content: 'b fact' });

    // 全局视图停留在 project-A，却要删掉 project-B 的记录。
    store.remove({ userId: 'u', workspace: '/a' }, recordInB.id);

    expect(store.search({ userId: 'u', workspace: '/a', includeOtherProjects: true }, 'fact')).toHaveLength(0);
    db.close();
  });

  it('does not remove a record owned by a different user', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const mine = store.upsert({ userId: 'u', workspace: '/a' }, { level: 1, content: 'mine' });

    store.remove({ userId: 'intruder', workspace: '/a' }, mine.id);

    expect(store.search({ userId: 'u', workspace: '/a' }, 'mine')).toHaveLength(1);
    db.close();
  });

  it('retains uncommitted text when a later capture appends a new turn', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const scope = { userId: 'u', workspace: '/a', sessionId: 's' };
    store.capture(scope, 'session:s', 'user: first', 'fp1');
    expect(store.capture(scope, 'session:s', 'user: first\nuser: second', 'fp2').delta).toBe('user: first\nuser: second');
    // An earlier job may complete after another turn has updated the cursor.
    store.commitCapture(scope, 'session:s', 'fp1', 'user: first');
    expect(store.capture(scope, 'session:s', 'user: first\nuser: second', 'fp2').delta).toBe('user: second');
    store.commitCapture(scope, 'session:s', 'fp2', 'user: second');
    expect(store.capture(scope, 'session:s', 'user: first\nuser: second', 'fp2').changed).toBe(false);
    db.close();
  });

  it('searches captured conversations with source metadata and bounded matching snippets', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const scope = { userId: 'u', projectId: 'project-A', workspace: '/a', sessionId: 's' };
    store.capture(scope, 'session:s', `user: ${'x'.repeat(2000)} raw needle ${'y'.repeat(2000)}`, 'fp');
    store.capture({ ...scope, projectId: 'project-B', workspace: '/b' }, 'session:b', 'other raw needle', 'other');
    store.capture({ ...scope, userId: 'other' }, 'session:other', 'private raw needle', 'private');
    store.upsert(scope, { level: 1, content: 'derived-only fact' });
    const result = store.searchConversations(scope, 'raw needle');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: expect.any(String), source: 'session:s', sessionId: 's', workspace: '/a', sourceProjectId: 'project-A', updatedAt: expect.any(Number) });
    expect(result[0].snippet).toContain('raw needle');
    expect(result[0].snippet.length).toBeLessThanOrEqual(1200);
    expect(result[0]).not.toHaveProperty('transcript');
    expect(store.searchConversations(scope, 'derived-only')).toEqual([]);
    expect(store.searchConversations({ ...scope, includeOtherProjects: true }, 'raw needle')).toHaveLength(2);
    expect(store.searchConversations({ ...scope, includeOtherProjects: true }, 'raw needle', 1)).toHaveLength(1);
    expect(store.searchConversations(scope, '   ')).toEqual([]);
    expect(store.searchConversations(scope, '%')).toEqual([]);
    db.close();
  });
});
