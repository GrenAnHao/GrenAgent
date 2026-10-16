import { afterEach, describe, expect, it } from 'vitest';
import { TaskViewStore } from './taskViewStore';
import { taskFixture } from './taskTestFixture';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() { const f = taskFixture(); cleanups.push(f.cleanup); return { ...f, views: new TaskViewStore(f.db) }; }

describe('TaskViewStore', () => {
  it('shows "cancelling" only while the job is still active; a settled cancel is removable', () => {
    const f = fixture(); const job = f.jobs.create({ kind: 'codegraph.sync', workspace: '/repo' });
    f.jobs.start(job.id); f.jobs.requestCancellation(job.id);
    expect(f.views.read({ source: 'user', id: job.id })).toMatchObject({ status: 'running', cancellationRequested: true, capabilities: { remove: false } });
    f.jobs.cancel(job.id);
    // 库里的标记还在，但任务已经落定：不能再显示「正在取消，等待确认」，也要能删。
    expect(f.jobs.get(job.id)?.metadata?.cancellationRequested).toBe(true);
    expect(f.views.read({ source: 'user', id: job.id })).toMatchObject({ status: 'cancelled', cancellationRequested: false, capabilities: { remove: true } });
  });

  it('lists memory tasks without parsing their payload, while Wiki tasks still resolve kbId', () => {
    const f = fixture();
    f.system('wiki', 'completed', 10, { kbId: 'kb-1' });
    const insert = f.db.prepare('INSERT INTO service_tasks(id,kind,source_project_id,status,input,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
    insert.run('mem-object', 'memory_extract', '/repo', 'completed', JSON.stringify({ kbId: 'never-a-wiki', delta: 'x'.repeat(10_000) }), 1, 1, 9);
    insert.run('mem-broken', 'memory_scene', '/repo', 'failed', '{not json', 2, 1, 8);
    const items = f.views.list().items;
    expect(items.find((item) => item.ref.id === 'wiki')?.resource).toEqual({ type: 'wiki', id: 'kb-1' });
    expect(items.find((item) => item.ref.id === 'mem-object')?.resource).toEqual({ type: 'project', id: '/repo' });
    expect(items.find((item) => item.ref.id === 'mem-broken')).toMatchObject({ status: 'failed', resource: { type: 'project', id: '/repo' } });
  });

  it('keeps identical IDs separate and preserves system queued/blocked without progress or capabilities', () => {
    const f = fixture(); const job = f.jobs.create({ kind: 'codegraph.sync', workspace: '/repo' });
    f.jobs.start(job.id); f.system(job.id); f.system('blocked', 'blocked');
    const rows = f.views.list().items;
    expect(rows.map((row) => row.key)).toEqual(expect.arrayContaining([`user:${job.id}`, `system:${job.id}`]));
    expect(f.views.read({ source: 'user', id: job.id })).toMatchObject({ status: 'running', stage: '正在构建', progress: undefined });
    expect(f.views.read({ source: 'system', id: job.id })).toMatchObject({ status: 'queued', progress: undefined, capabilities: { cancel: false, retry: false, remove: false } });
    expect(f.views.read({ source: 'system', id: 'blocked' })?.status).toBe('blocked');
  });

  it('pages a single SQL union stably at equal timestamps and binds opaque cursors to filters', () => {
    const f = fixture();
    for (let index = 0; index < 101; index += 1) {
      const id = `id-${String(index).padStart(3, '0')}`;
      f.system(id, 'queued', 10);
      f.db.prepare('INSERT INTO agent_jobs(id,kind,workspace,state,progress,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, 'wiki.sync', '/repo', 'pending', 0, 1, 10);
    }
    const all: string[] = []; let cursor: string | undefined;
    do { const page = f.views.list({ limit: 17, workspace: '/repo', cursor }); all.push(...page.items.map((item) => item.key)); cursor = page.nextCursor; } while (cursor);
    expect(all).toEqual([...Array.from({ length: 101 }, (_, i) => `system:id-${String(i).padStart(3, '0')}`), ...Array.from({ length: 101 }, (_, i) => `user:id-${String(i).padStart(3, '0')}`)]);
    const first = f.views.list({ limit: 3, source: 'system', group: 'active', query: 'id-' });
    expect(() => f.views.list({ cursor: first.nextCursor, source: 'user', group: 'active', query: 'id-' })).toThrow('INVALID_TASK_CURSOR');
    expect(() => f.views.list({ cursor: 'e30' })).toThrow('INVALID_TASK_CURSOR');
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()); decoded.id = 'forged';
    expect(() => f.views.list({ source: 'system', group: 'active', query: 'id-', cursor: Buffer.from(JSON.stringify(decoded)).toString('base64url') })).toThrow('INVALID_TASK_CURSOR');
    expect(f.views.list({ limit: 1000 }).items).toHaveLength(100);
    expect(f.views.list().items).toHaveLength(50);
    expect(f.views.list({ group: 'history' }).items).toEqual([]);
  });

  it('counts all filtered active tasks independently of history pagination and cursor position', () => {
    const f = fixture();
    for (let index = 0; index < 101; index += 1) f.system(`history-${index}`, 'completed', 10);
    expect(f.views.list({ limit: 100 })).toMatchObject({ activeCount: 0, nextCursor: expect.any(String) });
    f.system('older-active', 'running', 1);
    const first = f.views.list({ limit: 100 });
    expect(first.activeCount).toBe(1);
    expect(first.items.every((item) => item.status === 'completed')).toBe(true);
    f.system('newest-active', 'blocked', 20);
    const second = f.views.list({ limit: 100, cursor: first.nextCursor });
    expect(second.activeCount).toBe(2);
    expect(second.items.map((item) => item.ref.id)).toContain('older-active');
    expect(second.items.map((item) => item.ref.id)).not.toContain('newest-active');
    expect(f.views.list({ query: 'older-active' }).activeCount).toBe(1);
    expect(f.views.list({ workspace: '/other' }).activeCount).toBe(0);
    expect(f.views.list({ source: 'user' }).activeCount).toBe(0);
    expect(f.views.list({ group: 'history' }).activeCount).toBe(0);
  });

  it('isolates damaged metadata, searches safe labels, and hides active writer removal', () => {
    const f = fixture();
    const damaged = f.jobs.create({ kind: 'wiki.ingest', workspace: '' });
    f.db.prepare('UPDATE agent_jobs SET metadata=? WHERE id=?').run('{broken', damaged.id);
    const good = f.jobs.create({ kind: 'wiki.ingest', workspace: '', metadata: { target: { type: 'wiki', id: 'kb-1' }, resourceName: 'Research', stage: '正在生成', processed: 1, total: 4 } });
    f.jobs.fail(good.id, 'failure');
    f.db.prepare('INSERT INTO wiki_task_targets VALUES(?,?,?,?,?,?,?)').run('agent_job', good.id, 'kb-1', '', '', 1, 1);
    expect(f.views.list().items).toHaveLength(2);
    expect(f.views.read({ source: 'user', id: damaged.id })).toMatchObject({ error: expect.stringContaining('元数据') });
    expect(f.views.list({ query: 'Research' }).items).toMatchObject([{ resource: { type: 'wiki', id: 'kb-1' }, progress: 25, capabilities: { remove: false, retry: false } }]);
  });

  it('exposes only allowlisted system summaries and fixed stage events, never source bodies or tokens', () => {
    const f = fixture();
    f.system('system-1', 'running', 10, { kbId: 'kb-safe', sourceId: 'source-1', sourceRevision: 3, source: 'PRIVATE SOURCE', transcript: 'PRIVATE TRANSCRIPT', token: 'SECRET', expectedModel: 'fixture/model' });
    const detail = f.views.readDetail({ source: 'system', id: 'system-1' })!;
    expect(detail).toMatchObject({ resource: { type: 'wiki', id: 'kb-safe' }, inputSummary: { kbId: 'kb-safe', sourceId: 'source-1', sourceRevision: 3, model: 'fixture/model' }, outputSummary: { generated: 1 } });
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE|SECRET|transcript/);
    expect(detail.inputSummary).not.toHaveProperty('source');
    const job = f.jobs.create({ kind: 'wiki.sync', workspace: '/repo' });
    f.jobs.recordStage(job.id, '正在读取', { processed: 0, total: 3 });
    f.jobs.requestCancellation(job.id);
    f.db.prepare('INSERT INTO agent_audit VALUES(?,?,?,?)').run('unsafe', 'job.stage', JSON.stringify({ id: job.id, stage: 'SECRET arbitrary source body' }), 10);
    const user = f.views.readDetail({ source: 'user', id: job.id })!;
    expect(user.events.map((event) => event.message)).toEqual(expect.arrayContaining(['正在读取', '已请求取消，等待执行器确认']));
    expect(JSON.stringify(user)).not.toContain('SECRET');
  });

  it('keeps a detail readable when a persisted ingest summary has an invalid object shape', () => {
    const f = fixture(); const job = f.jobs.create({ kind: 'wiki.ingest', workspace: '' });
    f.db.exec('CREATE TABLE wiki_ingest_runs(job_id TEXT,model TEXT,summary TEXT)');
    f.db.prepare('INSERT INTO wiki_ingest_runs VALUES(?,?,?)').run(job.id, 'fixture/model', 'null');
    expect(f.views.readDetail({ source: 'user', id: job.id })).toMatchObject({ inputSummary: { model: 'fixture/model' }, outputSummary: {} });
  });

  it('rejects credentials and serialized objects in typed summaries and resource IDs', () => {
    const f = fixture();
    f.system('unsafe-system', 'running', 10, { kbId: '{"apiKey":"FIXTURE_SECRET_KB"}', sourceId: '{"token":"FIXTURE_SECRET_SOURCE"}', expectedModel: 'Bearer FIXTURE_SECRET_MODEL' });
    const job = f.jobs.create({ kind: 'wiki.ingest', workspace: '', metadata: { target: { type: 'wiki', id: '{"token":"FIXTURE_SECRET_TARGET"}' }, resourceName: 'apiKey=FIXTURE_SECRET_NAME' } });
    f.db.exec('CREATE TABLE wiki_ingest_runs(job_id TEXT,model TEXT,summary TEXT)');
    f.db.prepare('INSERT INTO wiki_ingest_runs VALUES(?,?,?)').run(job.id, 'Basic FIXTURE_SECRET_USER_MODEL', '{}');
    const system = f.views.readDetail({ source: 'system', id: 'unsafe-system' })!;
    const user = f.views.readDetail({ source: 'user', id: job.id })!;
    expect(system.inputSummary).toEqual({});
    expect(system.resource).toEqual({ type: 'project', id: '/repo' });
    expect(user.resource).toBeUndefined();
    expect(JSON.stringify([system, user, f.views.list()])).not.toContain('FIXTURE_SECRET');
  });

  it('uses actual Wiki task targets before input claims and retains safe Unicode project paths', () => {
    const f = fixture();
    f.system('linked', 'running', 10, { kbId: 'wrong-kb', sourceId: 'wrong-source', expectedModel: 'provider/model-v1:latest' });
    f.db.prepare('INSERT INTO wiki_task_targets VALUES(?,?,?,?,?,?,?)').run('service_task', 'linked', 'actual-kb', 'actual-source', '', 1, 0);
    expect(f.views.readDetail({ source: 'system', id: 'linked' })).toMatchObject({ resource: { type: 'wiki', id: 'actual-kb' }, inputSummary: { kbId: 'actual-kb', sourceId: 'actual-source', model: 'provider/model-v1:latest' } });
    const job = f.jobs.create({ kind: 'codegraph.sync', workspace: 'D:/项目 Files/源码', metadata: { resourceName: '索引：研发 Wiki / 说明' } });
    expect(f.views.readDetail({ source: 'user', id: job.id })).toMatchObject({ resource: { type: 'project', id: 'D:/项目 Files/源码' }, resourceName: '索引：研发 Wiki / 说明' });
  });

  it('summarizes completed memory_scene with status stage and counts, never scene or transcript bodies', () => {
    const f = fixture();
    f.db.prepare('INSERT INTO service_tasks(id,kind,source_project_id,status,input,output,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
      'scene-1', 'memory_scene', 'D:/System Dir/Downloads/Python代码', 'completed',
      JSON.stringify({
        mode: 'work', source: 'session:s1', sessionId: 's1', userId: 'local', maxScenes: 15,
        memories: [{ content: 'SECRET_L1', type: 'work_method' }],
        scenes: [{ filename: 'sop.md', content: 'SECRET_SCENE' }],
        sceneSummaries: 'SECRET_SUMMARIES',
      }),
      JSON.stringify({
        scenes: [
          { filename: 'sop.md', action: 'write', content: 'SECRET_OUT' },
          { filename: 'old.md', action: 'delete' },
        ],
        persona_update_request: 'SECRET_HINT',
      }),
      1, 1, 10,
    );
    const detail = f.views.readDetail({ source: 'system', id: 'scene-1' })!;
    expect(detail).toMatchObject({
      status: 'completed',
      stage: '已完成',
      progress: 100,
      processed: 2,
      total: 2,
      resource: { type: 'project', id: 'D:/System Dir/Downloads/Python代码' },
      inputSummary: { mode: 'work', source: 'session:s1', sessionId: 's1', userId: 'local', maxScenes: 15, memoryCount: 1, sceneCount: 1 },
      outputSummary: { written: 1, deleted: 1, personaUpdateRequested: true },
    });
    expect(JSON.stringify(detail)).not.toMatch(/SECRET/);
    expect(detail.inputSummary).not.toHaveProperty('memories');
    expect(detail.outputSummary).not.toHaveProperty('scenes');
  });

  it('marks running memory extract as generating without leaking the transcript delta', () => {
    const f = fixture();
    f.db.prepare('INSERT INTO service_tasks(id,kind,source_project_id,status,input,output,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
      'extract-1', 'memory_extract', '/repo', 'running',
      JSON.stringify({ mode: 'work', delta: 'SECRET_DELTA', previousSceneName: 'sop.md', userId: 'local' }),
      '{}', 0, 1, 10,
    );
    const detail = f.views.readDetail({ source: 'system', id: 'extract-1' })!;
    expect(detail).toMatchObject({ status: 'running', stage: '正在生成', progress: undefined, inputSummary: { mode: 'work', userId: 'local' }, outputSummary: {} });
    expect(JSON.stringify(detail)).not.toMatch(/SECRET/);
    expect(detail.inputSummary).not.toHaveProperty('delta');
  });
});
