import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AuditViewStore, redactAuditValue } from './auditViewStore';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  db.exec('CREATE TABLE agent_audit(id TEXT PRIMARY KEY,action TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL)');
  return { db, store: new AuditViewStore(db), add(id: string, action: string, detail: unknown, createdAt = 1000) {
    db.prepare('INSERT INTO agent_audit VALUES(?,?,?,?)').run(id, action, JSON.stringify(detail), createdAt);
  } };
}

describe('AuditViewStore', () => {
  it('paginates equal timestamps once in stable tuple order', () => {
    const { store, add } = fixture();
    for (const id of ['a', 'c', 'b']) add(id, 'job.stage', { id, stage: 'running' });
    const first = store.query({ limit: 2 }); const second = store.query({ limit: 2, cursor: first.nextCursor });
    expect(first.items.map((item) => item.id)).toEqual(['c', 'b']);
    expect(second.items.map((item) => item.id)).toEqual(['a']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('applies combined action, resource and inclusive time filters before limiting', () => {
    const { store, add } = fixture();
    add('match-new', 'wiki.ingest.publish', { resource: { type: 'wiki', id: 'kb' }, resourceName: '保留名称' }, 20);
    add('match-old', 'wiki.ingest.publish', { kbId: 'kb' }, 10);
    add('wrong-action', 'wiki.ingest.fail', { kbId: 'kb' }, 20);
    add('wrong-resource', 'wiki.ingest.publish', { kbId: 'other' }, 20);
    add('wrong-time', 'wiki.ingest.publish', { kbId: 'kb' }, 21);
    const first = store.query({ action: 'wiki.ingest.publish', resource: { type: 'wiki', id: 'kb' }, from: 10, to: 20, limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual(['match-new']);
    expect(store.query({ action: 'wiki.ingest.publish', resource: { type: 'wiki', id: 'kb' }, from: 10, to: 20, cursor: first.nextCursor }).items.map((item) => item.id)).toEqual(['match-old']);
  });

  it('rejects invalid ranges and cursor versions, tuples or changed filters', () => {
    const { store, add } = fixture(); add('a', 'job.stage', {}); add('b', 'job.stage', {});
    const cursor = store.query({ action: 'job.stage', limit: 1 }).nextCursor!;
    expect(() => store.query({ from: 2, to: 1 })).toThrow(/range/i);
    expect(() => store.query({ from: Number.NaN })).toThrow(/from/i);
    expect(() => store.query({ cursor: 'not-json' })).toThrow(/cursor/i);
    expect(() => store.query({ cursor, action: 'job.fail' })).toThrow(/cursor/i);
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    for (const bad of [{ ...decoded, version: 2 }, { ...decoded, createdAt: '1000' }, { ...decoded, id: '' }]) {
      expect(() => store.query({ cursor: Buffer.from(JSON.stringify(bad)).toString('base64url'), action: 'job.stage' })).toThrow(/cursor/i);
    }
  });

  it('redacts nested sensitive keys while retaining arrays and innocent structure', () => {
    expect(redactAuditValue({ count: 2, data: [{ accessToken: 'one', api_key: 'two', values: { Secret: 'three', credential: { nested: 'four' }, password: 'five', authorization: 'six', ok: true } }] }))
      .toEqual({ count: 2, data: [{ accessToken: '[redacted]', api_key: '[redacted]', values: { Secret: '[redacted]', credential: '[redacted]', password: '[redacted]', authorization: '[redacted]', ok: true } }] });
  });

  it('uses one safe projection for query and export and never emits raw task or LLM bodies', () => {
    const { store, add } = fixture();
    add('one', 'job.create', { id: 'job', kind: 'wiki.ingest', workspace: '/project', metadata: { target: { type: 'wiki', id: 'kb', token: 'nested-secret' }, resourceName: '知识库', payload: { kbId: 'kb', sourceIds: ['s'], content: 'source-body' }, apiKey: 'metadata-secret' }, input: 'raw-input', output: 'raw-output', transcript: 'captured-transcript', source: 'raw-source', content: 'llm-content' });
    const view = store.query().items[0];
    expect(view).toMatchObject({ resource: { type: 'wiki', id: 'kb' }, resourceName: '知识库', detail: { metadata: { apiKey: '[redacted]', target: { token: '[redacted]' } } } });
    expect(store.export().items).toEqual([view]);
    const output = JSON.stringify(view);
    for (const secret of ['nested-secret', 'metadata-secret', 'source-body', 'raw-input', 'raw-output', 'captured-transcript', 'raw-source', 'llm-content']) expect(output).not.toContain(secret);
  });

  it('preserves resource name snapshots after deletion and does not invent legacy names', () => {
    const { store, add } = fixture();
    add('named', 'job.remove', { id: 'gone-job', resource: { type: 'wiki', id: 'gone-kb' }, resourceName: '历史库名' });
    add('legacy', 'wiki.ingest.publish', { kbId: 'gone-kb' });
    const entries = store.query({ resource: { type: 'wiki', id: 'gone-kb' } }).items;
    expect(entries.find((item) => item.id === 'named')?.resourceName).toBe('历史库名');
    expect(entries.find((item) => item.id === 'legacy')?.resourceName).toBe('资源已移除（gone-kb）');
  });

  it('validates typed values even when secrets are embedded in allowlisted strings', () => {
    const { store, add } = fixture();
    add('job', 'job.create', { id: '{"apiKey":"FIXTURE_SECRET_JOB"}', workspace: 'https://user:FIXTURE_SECRET_URL@example.test', metadata: { target: { type: 'wiki', id: '{"token":"FIXTURE_SECRET_TARGET"}' }, resourceName: 'Bearer FIXTURE_SECRET_NAME', payload: { kbId: 'secret=FIXTURE_SECRET_KB', sourceIds: ['safe-source', '{"password":"FIXTURE_SECRET_SOURCE"}'] } } });
    add('wiki', 'wiki.ingest.fail', { kbId: '{"token":"FIXTURE_SECRET_RESOURCE"}', sourceId: 2, model: 'Basic FIXTURE_SECRET_MODEL', error: 'apiKey=FIXTURE_SECRET_ERROR' });
    const query = store.query(); const exported = store.export();
    expect(query.items.every((item) => item.resource === undefined)).toBe(true);
    expect(JSON.stringify([query, exported])).not.toContain('FIXTURE_SECRET');
    expect(query.items.find((item) => item.id === 'job')?.detail).toMatchObject({ metadata: { payload: { sourceIds: ['safe-source'] } } });
    expect(query.items.find((item) => item.id === 'wiki')?.detail).not.toHaveProperty('sourceId');
    expect(() => store.query({ resource: { type: 'wiki', id: '{"token":"FIXTURE_SECRET_FILTER"}' } })).toThrow('INVALID_AUDIT_QUERY');
  });

  it('retains normal model slugs, Unicode resource labels and absolute project paths', () => {
    const { store, add } = fixture();
    add('model', 'wiki.ingest.fail', { kbId: 'k', model: 'provider/model-v1:latest', error: 'MODEL_CHANGED: provider/model-v1:latest', resourceName: '知识库：研发 / 资料' });
    add('path', 'job.create', { workspace: 'D:/项目 Files/源码', resourceName: '代码项目' });
    expect(store.query({ resource: { type: 'wiki', id: 'k' } }).items[0]).toMatchObject({ resourceName: '知识库：研发 / 资料', detail: { model: 'provider/model-v1:latest', error: 'MODEL_CHANGED: provider/model-v1:latest' } });
    expect(store.query({ resource: { type: 'project', id: 'D:/项目 Files/源码' } }).items).toHaveLength(1);
    expect(() => store.query({ from: 2, to: 1 })).toThrow('INVALID_AUDIT_QUERY: invalid audit time range');
    expect(() => store.query({ cursor: 'not-json' })).toThrow('INVALID_AUDIT_CURSOR: invalid audit cursor');
  });

  it('retains safe legacy page paths with spaces and Unicode without relaxing other IDs', () => {
    const { store, add } = fixture();
    add('legacy', 'wiki.sync.skip', { workspace: '/repo', page: 'docs/Design Notes.md' });
    add('page', 'wiki.ingest.publish', { kbId: 'k', pageId: '设计 文档/入门 指南.md', target: { kind: 'page', kbId: 'k', pageId: '更多文档/概览 页.md' }, sourceId: 'source with spaces' });
    const items = store.query().items;
    expect(items.find((item) => item.id === 'legacy')?.detail).toMatchObject({ page: 'docs/Design Notes.md' });
    expect(items.find((item) => item.id === 'page')?.detail).toMatchObject({ pageId: '设计 文档/入门 指南.md', target: { pageId: '更多文档/概览 页.md' } });
    expect(items.find((item) => item.id === 'page')?.detail).not.toHaveProperty('sourceId');
    expect(store.export().items).toEqual(items);
  });

  it('rejects unsafe syntax and credentials from every audit page-path field', () => {
    const { store, add } = fixture();
    const unsafe = ['../escape.md', 'docs/../escape.md', '/absolute.md', 'C:/absolute.md', 'C:relative.md', 'docs/page.md:stream', 'docs/CON.md', 'docs/LPT1.txt', 'docs/trailing. ', 'docs//page.md', 'docs/./page.md', 'docs/line\npage.md', '[1,2]', '{"token":"FIXTURE_SECRET_PAGE"}', 'Bearer FIXTURE_SECRET_PAGE', 'https://user:FIXTURE_SECRET_PAGE@example.test/page.md'];
    for (const [index, path] of unsafe.entries()) add(String(index), 'wiki.ingest.skip', { kbId: 'k', page: path, pageId: path, target: { kind: 'page', kbId: 'k', pageId: path } });
    const items = store.query().items;
    for (const item of items) {
      expect(item.detail).not.toHaveProperty('page');
      expect(item.detail).not.toHaveProperty('pageId');
      expect(item.detail.target).not.toHaveProperty('pageId');
    }
    expect(JSON.stringify([items, store.export()])).not.toContain('FIXTURE_SECRET_PAGE');
  });

  it('returns a bounded parse diagnostic for malformed metadata without failing the page', () => {
    const { db, store, add } = fixture(); add('valid', 'job.stage', { stage: 'running' });
    db.prepare('INSERT INTO agent_audit VALUES(?,?,?,?)').run('broken', 'job.create', '{raw-input', 1000);
    const rows = store.query().items;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === 'broken')?.detail).toEqual({ parseError: '审计元数据无法解析' });
    expect(JSON.stringify(rows)).not.toContain('raw-input');
  });

  it('clamps page sizes and exports at most 500 from the filter beginning, with truncation', () => {
    const { store, add } = fixture();
    for (let i = 0; i < 502; i++) add(String(i).padStart(4, '0'), 'job.stage', { stage: 'running' }, i);
    add('ignored', 'job.fail', { error: 'failed' }, 600);
    expect(store.query().items).toHaveLength(50);
    expect(store.query({ limit: 0 }).items).toHaveLength(1);
    expect(store.query({ limit: 999 }).items).toHaveLength(100);
    const cursor = store.query({ action: 'job.stage', limit: 1 }).nextCursor;
    const result = store.export({ action: 'job.stage', cursor, limit: 1 });
    expect(result).toMatchObject({ limit: 500, truncated: true });
    expect(result.items).toHaveLength(500);
    expect(result.items[0].id).toBe('0501');
    expect(store.export({ action: 'job.fail' }).truncated).toBe(false);
    expect(() => store.export({ cursor: 'bad' })).toThrow(/cursor/i);
  });
});
