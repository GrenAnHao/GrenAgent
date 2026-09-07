import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './memoryStore';
import type { MemoryListInput } from './memoryContracts';

const dbs: DatabaseSync[] = [];
const all: MemoryListInput = { userId: 'u', filter: { scope: 'all' } };
const projectA: MemoryListInput = { userId: 'u', filter: { scope: 'project', projectId: 'A' } };
function setup() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return { db, store: new MemoryStore(db) };
}
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe('MemoryStore management browsing', () => {
  it('paginates 51 equal-timestamp memories with descending ID and no duplicates', () => {
    const { db, store } = setup();
    for (let i = 0; i < 51; i++) store.upsert({ userId: 'u', workspace: 'A' }, { level: 1, content: `fact ${i}` });
    db.exec('UPDATE memories SET updated_at=100');
    const first = store.list(all);
    const second = store.list({ ...all, cursor: first.nextCursor });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const ids = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(ids).size).toBe(51);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(store.list({ ...all, limit: 0 }).items).toHaveLength(1);
    expect(store.list({ ...all, limit: 500 }).items).toHaveLength(50);
  });

  it('keeps all/project/global filters separate, user-scoped, and literal-searchable', () => {
    const { store } = setup();
    store.upsert({ userId: 'u', workspace: '/a', projectId: 'A' }, { level: 1, content: 'alpha 100%_fact' });
    store.upsert({ userId: 'u', workspace: '/b', projectId: 'B' }, { level: 2, content: 'beta fact' });
    store.upsert({ userId: 'u', workspace: '/a', projectId: 'A', scope: 'global' }, { level: 3, content: 'global fact' });
    store.upsert({ userId: 'other', workspace: '/a', projectId: 'A' }, { level: 1, content: 'secret fact' });
    expect(store.list(all).items).toHaveLength(3);
    expect(store.list(projectA).items.map((row) => row.content)).toEqual(['alpha 100%_fact']);
    expect(store.list({ ...all, filter: { scope: 'global' } }).items.map((row) => row.content)).toEqual(['global fact']);
    expect(store.list({ ...all, query: '  %_FAct ' }).items.map((row) => row.content)).toEqual(['alpha 100%_fact']);
    expect(store.list({ ...all, query: '_', level: 2 }).items).toEqual([]);
    expect(store.list({ ...all, level: 2 }).items.map((row) => row.content)).toEqual(['beta fact']);
    expect(store.search({ userId: 'u', workspace: '/a', projectId: 'A' }, 'fact')).toHaveLength(2);
  });

  it('rejects malformed, wrong-version, invalid-field and mismatched cursors', () => {
    const { store } = setup();
    for (let i = 0; i < 2; i++) store.upsert({ userId: 'u', workspace: 'A' }, { level: 1, content: `fact ${i}` });
    const cursor = store.list({ ...all, limit: 1 }).nextCursor!;
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const value of ['garbage!', '', encode(null), encode({ ...payload, v: 2 }), encode({ ...payload, updatedAt: '100' }), encode({ ...payload, updatedAt: null }), encode({ ...payload, id: 9 }), encode({ ...payload, filterHash: 9 })]) {
      expect(() => store.list({ ...all, cursor: value })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS', message: 'invalid memory cursor' }));
    }
    for (const input of [{ ...all, userId: 'other' }, projectA, { ...all, query: 'fact' }, { ...all, level: 1 as const }]) {
      expect(() => store.list({ ...input, cursor })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    }
    expect(() => store.listConversations({ ...all, cursor })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    const normalized = store.list({ ...all, query: ' FACT ', limit: 1 }).nextCursor;
    expect(store.list({ ...all, query: 'fact', cursor: normalized }).items).toHaveLength(1);
  });

  it('reads a managed record without leaking other users or inventing source sessions', () => {
    const { store } = setup();
    const record = store.upsert({ userId: 'u', workspace: '/origin', projectId: 'A', sessionId: 's' }, { level: 1, content: 'fact', source: 'session:s' });
    expect(store.read({ userId: 'u', id: record.id })).toMatchObject({ scope: 'project', sourceProjectId: 'A', sourceWorkspace: '/origin', sourceSessionId: 's', revision: 1, origin: 'automatic', contentHash: expect.any(String) });
    for (const id of [record.id, 'missing']) expect(() => store.read({ userId: 'other', id })).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'memory not found' }));
    expect(record).not.toHaveProperty('revision');
  });

  it('paginates equal-timestamp captures with snippets and reads untouched raw text', () => {
    const { db, store } = setup();
    const transcript = `  first\n${'x'.repeat(2200)} NEEDLE ${'y'.repeat(3000)}\nlast  `;
    for (let i = 0; i < 51; i++) store.capture({ userId: 'u', workspace: '/origin', projectId: 'A', sessionId: `s${i}` }, `session:s${i}`, transcript, `fp${i}`);
    store.capture({ userId: 'u', workspace: '/b', projectId: 'B' }, 'b', 'beta', 'b');
    store.capture({ userId: 'other', workspace: '/a', projectId: 'A' }, 'secret', transcript, 'secret');
    db.exec('UPDATE memory_captures SET updated_at=100');
    const before = db.prepare('SELECT * FROM memory_captures ORDER BY capture_key').all();
    const first = store.listConversations({ ...projectA, query: 'needle' });
    const second = store.listConversations({ ...projectA, query: 'needle', cursor: first.nextCursor });
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const ids = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(ids).size).toBe(51);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(first.items[0]).not.toHaveProperty('transcript');
    expect(first.items[0].snippet.toLowerCase().indexOf('needle')).toBeLessThanOrEqual(200);
    expect(first.items[0].snippet.length).toBeLessThanOrEqual(1200);
    expect(first.items[0]).toMatchObject({ sourceProjectId: 'A', workspace: '/origin', sourceSessionId: expect.any(String) });
    expect(store.readConversation({ userId: 'u', id: ids[0] }).transcript).toBe(transcript);
    expect(store.listConversations(projectA).items[0].snippet).toBe(transcript.slice(0, 1200));
    expect(store.listConversations({ ...all, filter: { scope: 'global' } }).items).toEqual([]);
    expect(store.listConversations({ ...projectA, query: '%' }).items).toEqual([]);
    for (const id of [ids[0], 'missing']) expect(() => store.readConversation({ userId: 'other', id })).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'conversation not found' }));
    expect(() => store.list({ ...projectA, query: 'needle', cursor: first.nextCursor })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    expect(db.prepare('SELECT * FROM memory_captures ORDER BY capture_key').all()).toEqual(before);
    expect(store.overview({ userId: 'u', workspace: 'A', includeOtherProjects: true }).byLevel.L0).toBe(0);
  });

  it('uses legacy workspace ownership fallbacks and indexed user/order columns', () => {
    const { db, store } = setup();
    store.upsert({ userId: 'u', workspace: 'A' }, { level: 0, content: 'legacy' });
    store.capture({ userId: 'u', workspace: 'A' }, 'legacy', 'legacy', 'fp');
    db.exec('UPDATE memories SET project_id=NULL; UPDATE memory_captures SET project_id=NULL');
    expect(store.list(projectA).items).toHaveLength(1);
    expect(store.listConversations(projectA).items).toHaveLength(1);
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all().map((row) => String(row.sql));
    expect(indexes.some((sql) => /ON memories\(user_id,\s*updated_at DESC,\s*id DESC\)/i.test(sql))).toBe(true);
    expect(indexes.some((sql) => /ON memory_captures\(user_id,\s*updated_at DESC,\s*capture_key DESC\)/i.test(sql))).toBe(true);
  });
});
