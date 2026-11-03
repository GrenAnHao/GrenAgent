import { afterEach, describe, expect, it } from 'vitest';
import { TaskViewStore } from './taskViewStore';
import { taskFixture } from './taskTestFixture';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() { const f = taskFixture(); cleanups.push(f.cleanup); return { ...f, views: new TaskViewStore(f.db) }; }

describe('TaskViewStore', () => {
  it('keeps a persisted Repo Wiki language on the navigation resource', () => {
    const f = fixture();
    const job = f.jobs.create({ kind: 'repoWiki.generate', workspace: '/repo', metadata: {
      target: { type: 'repoWiki', id: '/repo', language: 'zh-Hant' },
      payload: { projectId: 'project', language: 'zh-Hant', target: 'wiki', force: false, confirmExternal: true },
    } });
    expect(f.jobs.get(job.id)?.metadata?.target).toEqual({ type: 'repoWiki', id: '/repo', language: 'zh-Hant' });
    expect(f.views.read({ source: 'user', id: job.id })?.resource).toEqual({ type: 'repoWiki', id: '/repo', language: 'zh-Hant' });
  });

  it('derives legacy Repo Wiki navigation language from the confirmed payload and discards invalid target languages', () => {
    const f = fixture();
    for (const target of [{ type: 'repoWiki' as const, id: '/repo' }, { type: 'repoWiki' as const, id: '/repo', language: 'en/../zh' }]) {
      const job = f.jobs.create({ kind: 'repoWiki.generate', workspace: '/repo', metadata: {
        target, payload: { projectId: 'project', language: 'en', target: 'wiki', force: false, confirmExternal: true },
      } });
      expect(f.jobs.get(job.id)?.metadata?.target).toEqual({ type: 'repoWiki', id: '/repo' });
      expect(f.views.read({ source: 'user', id: job.id })?.resource).toEqual({ type: 'repoWiki', id: '/repo', language: 'en' });
    }
    const ordinary = f.jobs.create({ kind: 'codegraph.sync', workspace: '/repo', metadata: { target: { type: 'project', id: '/repo', language: 'en' } } });
    expect(f.views.read({ source: 'user', id: ordinary.id })?.resource).toEqual({ type: 'project', id: '/repo' });
  });

  it('shows "cancelling" only while the job is still active; a settled cancel is removable', () => {
    const f = fixture(); const job = f.jobs.create({ kind: 'codegraph.sync', workspace: '/repo' });
    f.jobs.start(job.id); f.jobs.requestCancellation(job.id);
    expect(f.views.read({ source: 'user', id: job.id })).toMatchObject({ status: 'running', cancellationRequested: true, capabilities: { remove: false } });
    f.jobs.cancel(job.id);
    // 库里的标记还在，但任务已经落定：不能再显示「正在取消，等待确认」，也要能删。
    expect(f.jobs.get(job.id)?.metadata?.cancellationRequested).toBe(true);
    expect(f.views.read({ source: 'user', id: job.id })).toMatchObject({ status: 'cancelled', cancellationRequested: false, capabilities: { remove: true } });
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

});

it('includes paused kernel tasks as active without polling paused or blocked kernel tasks',()=>{
 const f=fixture();const base={version:1,key:{workspaceInstanceId:'w',projectId:'p',portableProjectId:'id',branch:'main',language:'en',domain:'cards'},intent:'generate',revision:0,phase:'prepare',pipelineConfigHash:'p',budgets:{version:1,unit:{maxModelRequests:12,maxToolCalls:40,maxAttempts:2,maxOutputTokens:8192,maxTotalTokens:120000,maxFileBytes:262144,maxReadBytes:2097152,maxReadLines:400,maxResultBytes:32768,maxSearchMatches:100,maxDirectoryEntries:200,modelTimeoutMs:120000,activeTimeMs:600000},run:{maxItems:500,maxDepth:6,maxModelRequests:1000,maxTotalTokens:2000000}},resumePolicy:'manual',counts:{planned:0,prepared:0,failed:0,blocked:0,published:0}};
 for(const [id,state] of [['paused','paused'],['blocked','blocked'],['running','running']]) f.db.prepare('INSERT INTO agent_jobs(id,kind,workspace,state,progress,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?)').run(id,'repoWiki.generate','/repo',state,0,1,1,JSON.stringify({repoWiki:base}));
 f.system('other-blocked','blocked');const page=f.views.list({group:'active'});expect(page.items.map(x=>x.ref.id)).toEqual(expect.arrayContaining(['paused','blocked','running','other-blocked']));expect(page.activeCount).toBe(4);expect(page.pollingCount).toBe(2);expect(page.items.find(x=>x.ref.id==='paused')?.label).toBe('Repo Wiki 知识卡生成');
});
it('does not present unknown kernel planning progress as a percentage',()=>{
 const f=fixture();const meta={version:1,key:{workspaceInstanceId:'w',projectId:'p',portableProjectId:'id',branch:'main',language:'en',domain:'wiki'},intent:'generate',revision:0,phase:'plan',pipelineConfigHash:'p',budgets:{version:1,unit:{maxModelRequests:12,maxToolCalls:40,maxAttempts:2,maxOutputTokens:8192,maxTotalTokens:120000,maxFileBytes:262144,maxReadBytes:2097152,maxReadLines:400,maxResultBytes:32768,maxSearchMatches:100,maxDirectoryEntries:200,modelTimeoutMs:120000,activeTimeMs:600000},run:{maxItems:500,maxDepth:6,maxModelRequests:1000,maxTotalTokens:2000000}},resumePolicy:'auto',counts:{planned:0,prepared:0,failed:0,blocked:0,published:0}};
 f.db.prepare('INSERT INTO agent_jobs(id,kind,workspace,state,progress,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?)').run('unknown','repoWiki.generate','/repo','running',100,1,1,JSON.stringify({repoWiki:meta}));expect(f.views.read({source:'user',id:'unknown'})?.progress).toBeUndefined();
});
