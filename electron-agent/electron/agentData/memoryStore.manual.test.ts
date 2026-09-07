import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './memoryStore';
import type { MemoryDraft } from './memoryContracts';

const dbs: DatabaseSync[] = [];
const scope = { userId: 'u', workspace: '/origin', projectId: 'A', sessionId: 's' };
const draft: MemoryDraft = { content: 'manual fact', level: 1, owner: { scope: 'project', projectId: 'A' }, source: 'session:s' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
function setup() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return { db, store: new MemoryStore(db) };
}
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe('MemoryStore manual management', () => {
  it('creates independent UUID identities with explicit owners and no invented session source', () => {
    const { db, store } = setup();
    const first = store.create({ userId: 'u', draft: { ...draft, content: '  manual fact  ' } });
    const second = store.create({ userId: 'u', draft });
    expect(first.id).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
    expect(second.id).not.toBe(first.id);
    expect(first).toMatchObject({ content: 'manual fact', origin: 'manual', revision: 1, contentHash: hash('1:manual fact'), sourceWorkspace: 'A', sourceProjectId: 'A', sourceSessionId: undefined });
    expect(db.prepare('SELECT fingerprint FROM memories WHERE id=?').get(first.id)).toMatchObject({ fingerprint: `manual:${first.id}` });
    const global = store.create({ userId: 'u', draft: { ...draft, owner: { scope: 'global' } } });
    expect(db.prepare('SELECT workspace,project_id,memory_scope FROM memories WHERE id=?').get(global.id)).toMatchObject({ workspace: '', project_id: null, memory_scope: 'global' });
    expect(global.sourceProjectId).toBeUndefined();
  });

  it('rejects empty content, missing owner and newly requested L0', () => {
    const { store } = setup();
    for (const invalid of [{ ...draft, content: '  ' }, { ...draft, level: 0 }, { ...draft, owner: undefined }, { ...draft, owner: { scope: 'project', projectId: ' ' } }]) {
      expect(() => store.create({ userId: 'u', draft: invalid as MemoryDraft })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    }
    expect(store.list({ userId: 'u', filter: { scope: 'all' } }).items).toEqual([]);
  });

  it('moves owner while preserving the original workspace, source session, ID and created time', () => {
    const { db, store } = setup();
    const automatic = store.upsert(scope, { level: 1, content: 'automatic fact', source: 'session:s' });
    const updated = store.update({ userId: 'u', id: automatic.id, expectedRevision: 1, draft: { ...draft, owner: { scope: 'project', projectId: 'B' } } });
    expect(updated).toMatchObject({ id: automatic.id, createdAt: automatic.createdAt, scope: 'project', sourceProjectId: 'B', sourceWorkspace: '/origin', sourceSessionId: 's', origin: 'manual', revision: 2 });
    expect(db.prepare('SELECT workspace,project_id,session_id,fingerprint FROM memories WHERE id=?').get(updated.id)).toMatchObject({ workspace: '/origin', project_id: 'B', session_id: 's', fingerprint: `manual:${updated.id}` });
    expect(store.search(scope, 'fact')).toEqual([]);
    expect(store.search({ ...scope, projectId: 'B' }, 'fact')).toHaveLength(1);
    const changedSource = store.update({ userId: 'u', id: updated.id, expectedRevision: 2, draft: { ...draft, source: 'session:made-up', owner: { scope: 'global' } } });
    expect(changedSource).toMatchObject({ source: 'session:made-up', sourceSessionId: undefined, sourceWorkspace: '/origin', sourceProjectId: undefined, scope: 'global', revision: 3 });
  });

  it('allows existing L0 content edits without permitting a level change to or from L0', () => {
    const { store } = setup();
    const legacy = store.upsert(scope, { level: 0, content: 'legacy' });
    expect(store.update({ userId: 'u', id: legacy.id, expectedRevision: 1, draft: { ...draft, level: 0 } }).level).toBe(0);
    expect(() => store.update({ userId: 'u', id: legacy.id, expectedRevision: 2, draft })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    const modern = store.create({ userId: 'u', draft });
    expect(() => store.update({ userId: 'u', id: modern.id, expectedRevision: 1, draft: { ...draft, level: 0 } })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });

  it('rejects stale revisions and foreign users without mutating any columns', () => {
    const { db, store } = setup();
    const record = store.create({ userId: 'u', draft });
    store.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, content: 'edited' } });
    const before = db.prepare('SELECT * FROM memories').all();
    expect(() => store.update({ userId: 'u', id: record.id, expectedRevision: 1, draft })).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT', message: 'memory version conflict' }));
    for (const id of [record.id, 'missing']) expect(() => store.update({ userId: 'other', id, expectedRevision: 1, draft })).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'memory not found' }));
    expect(db.prepare('SELECT * FROM memories').all()).toEqual(before);
    expect(store.update({ userId: 'u', id: record.id, expectedRevision: 2, draft }).revision).toBe(3);
  });

  it.each([undefined, 's'])('protects two manual generations and reuses the automatic slot (session %s)', (sessionId) => {
    const { db, store } = setup();
    const captureScope = { ...scope, sessionId };
    const original = { level: 1 as const, content: 'original fact', source: 'session:s' };
    const first = store.upsert(captureScope, original);
    const expectedId = hash(`u:A:project:${sessionId ?? ''}:${hash('1:original fact')}`);
    expect(first.id).toBe(expectedId);
    store.update({ userId: 'u', id: first.id, expectedRevision: 1, draft: { ...draft, content: 'first edit' } });
    const second = store.upsert(captureScope, original);
    expect(second.id).toBe(hash(`${expectedId}:auto:1`));
    store.update({ userId: 'u', id: second.id, expectedRevision: 1, draft: { ...draft, content: 'second edit' } });
    const third = store.upsert(captureScope, original);
    expect(third.id).toBe(hash(`${expectedId}:auto:2`));
    expect(store.upsert(captureScope, original).id).toBe(third.id);
    const rows = db.prepare('SELECT id,content,origin,revision FROM memories ORDER BY content').all();
    expect(rows).toEqual([
      expect.objectContaining({ id: first.id, content: 'first edit', origin: 'manual', revision: 2 }),
      expect.objectContaining({ id: third.id, content: 'original fact', origin: 'automatic', revision: 2 }),
      expect.objectContaining({ id: second.id, content: 'second edit', origin: 'manual', revision: 2 }),
    ]);
  });

  it('rejects explicit automatic writes onto manual, foreign-user and foreign-scope IDs', () => {
    const { db, store } = setup();
    const manual = store.create({ userId: 'u', draft });
    const automatic = store.upsert(scope, { id: 'explicit', level: 1, content: 'automatic' });
    const before = db.prepare('SELECT * FROM memories ORDER BY id').all();
    expect(() => store.upsert(scope, { id: manual.id, level: 1, content: 'overwrite' })).toThrow(expect.objectContaining({ code: 'MANUAL_MEMORY_LOCKED' }));
    expect(() => store.upsert({ ...scope, userId: 'other' }, { id: automatic.id, level: 1, content: 'overwrite' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => store.upsert({ ...scope, projectId: 'B' }, { id: automatic.id, level: 1, content: 'overwrite' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(db.prepare('SELECT * FROM memories ORDER BY id').all()).toEqual(before);
  });

  it('retains an explicit automatic identity and updates its fingerprint for subsequent deduplication', () => {
    const { db, store } = setup();
    const first = store.upsert(scope, { id: 'explicit', level: 1, content: 'before' });
    const updated = store.upsert(scope, { id: first.id, level: 1, content: 'after' });
    expect(updated).toMatchObject({ id: first.id, content: 'after', createdAt: first.createdAt });
    expect(db.prepare('SELECT fingerprint,content_hash,revision,origin FROM memories WHERE id=?').get(first.id)).toEqual({ fingerprint: hash('1:after'), content_hash: hash('1:after'), revision: 2, origin: 'automatic' });
    expect(store.upsert(scope, { level: 1, content: 'after' }).id).toBe(first.id);
  });

  it('finds the matching scope among same-content legacy NULL-session automatic records', () => {
    const { db, store } = setup();
    const shared = { userId: 'u', workspace: '/shared' };
    store.upsert({ ...shared, scope: 'global' }, { id: 'legacy-global', level: 1, content: 'same' });
    store.upsert({ ...shared, scope: 'project' }, { id: 'legacy-project', level: 1, content: 'same' });
    db.prepare('UPDATE memories SET created_at=1 WHERE id=?').run('legacy-global');
    db.prepare('UPDATE memories SET created_at=2 WHERE id=?').run('legacy-project');
    expect(store.upsert({ ...shared, scope: 'project' }, { level: 1, content: 'same' }).id).toBe('legacy-project');
    expect(store.upsert({ ...shared, scope: 'global' }, { level: 1, content: 'same' }).id).toBe('legacy-global');
  });

  it('rejects a manual fallback slot from another source workspace without confusing an owner move', () => {
    const { db, store } = setup();
    const original = { level: 1 as const, content: 'origin' };
    const first = store.upsert(scope, original);
    store.update({ userId: 'u', id: first.id, expectedRevision: 1, draft: { ...draft, owner: { scope: 'global' } } });
    const foreign = store.upsert({ ...scope, workspace: '/other', projectId: 'B' }, { ...original, id: hash(`${first.id}:auto:1`) });
    store.update({ userId: 'u', id: foreign.id, expectedRevision: 1, draft });
    const before = db.prepare('SELECT * FROM memories ORDER BY id').all();
    expect(() => store.upsert(scope, original)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(db.prepare('SELECT * FROM memories ORDER BY id').all()).toEqual(before);
  });

  it('refuses an occupied automatic fallback ID from another actual scope without modifying it', () => {
    const { db, store } = setup();
    const original = { level: 1 as const, content: 'original' };
    const first = store.upsert(scope, original);
    store.update({ userId: 'u', id: first.id, expectedRevision: 1, draft });
    store.upsert({ ...scope, projectId: 'B', workspace: '/other' }, { ...original, id: hash(`${first.id}:auto:1`) });
    const before = db.prepare('SELECT * FROM memories ORDER BY id').all();
    expect(() => store.upsert(scope, original)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(db.prepare('SELECT * FROM memories ORDER BY id').all()).toEqual(before);
  });

  it('requires one affected row even when a SQLite trigger ignores the update', () => {
    const { db, store } = setup();
    const record = store.create({ userId: 'u', draft });
    const before = db.prepare('SELECT * FROM memories').all();
    db.exec('CREATE TRIGGER ignore_memory_update BEFORE UPDATE ON memories BEGIN SELECT RAISE(IGNORE); END');
    expect(() => store.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, content: 'ignored' } })).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(db.prepare('SELECT * FROM memories').all()).toEqual(before);
  });

  it('reuses a legacy NULL-session automatic row by fingerprint instead of creating a new content-derived ID', () => {
    const { db, store } = setup();
    const first = store.upsert({ userId: 'u', workspace: 'A' }, { id: 'legacy-id', level: 1, content: 'same' });
    db.prepare(`INSERT INTO memories(id,user_id,workspace,project_id,level,content,fingerprint,created_at,updated_at,content_hash)
      VALUES('legacy-duplicate','u','A','A',1,'same',?,9999999999999,9999999999999,?)`).run(hash('1:same'), hash('1:same'));
    const retried = store.upsert({ userId: 'u', workspace: 'A' }, { level: 1, content: 'same' });
    expect(retried.id).toBe(first.id);
    expect(store.list({ userId: 'u', filter: { scope: 'all' } }).items).toHaveLength(2);
    expect(store.read({ userId: 'u', id: 'legacy-duplicate' }).revision).toBe(1);
  });

  it('rolls back failed manual and automatic transactions and remains usable', () => {
    const { db, store } = setup();
    const automatic = store.upsert(scope, { level: 1, content: 'automatic' });
    const before = db.prepare('SELECT * FROM memories').all();
    db.exec("CREATE TRIGGER fail_memory_update BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    expect(() => store.update({ userId: 'u', id: automatic.id, expectedRevision: 1, draft })).toThrow('forced failure');
    expect(() => store.upsert(scope, { level: 1, content: 'automatic' })).toThrow('forced failure');
    expect(db.prepare('SELECT * FROM memories').all()).toEqual(before);
    db.exec('DROP TRIGGER fail_memory_update');
    expect(store.update({ userId: 'u', id: automatic.id, expectedRevision: 1, draft }).revision).toBe(2);
  });

  it('adds metadata to legacy schema without rewriting IDs, fingerprints, duplicates or revisions on reopening', () => {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    db.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT,
      level INTEGER NOT NULL, content TEXT NOT NULL, source TEXT, fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(user_id, workspace, session_id, level, fingerprint)
    ); INSERT INTO memories VALUES('old-1','u','A',NULL,1,'same',NULL,'legacy-fingerprint',1,2);
    INSERT INTO memories VALUES('old-2','u','A',NULL,1,'same',NULL,'legacy-fingerprint',3,4)`);
    const store = new MemoryStore(db);
    expect(store.read({ userId: 'u', id: 'old-1' })).toMatchObject({ contentHash: hash('1:same'), origin: 'automatic', revision: 1, createdAt: 1, updatedAt: 2 });
    const before = db.prepare('SELECT * FROM memories ORDER BY id').all();
    new MemoryStore(db);
    expect(db.prepare('SELECT * FROM memories ORDER BY id').all()).toEqual(before);
    expect(before.map((row) => row.fingerprint)).toEqual(['legacy-fingerprint', 'legacy-fingerprint']);
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get();
    expect(schema?.sql).toContain('UNIQUE(user_id, workspace, session_id, level, fingerprint)');
  });
});
