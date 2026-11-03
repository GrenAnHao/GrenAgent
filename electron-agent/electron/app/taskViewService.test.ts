import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../agentData/jobStore';
import { TaskViewStore } from '../agentData/taskViewStore';
import { taskFixture } from '../agentData/taskTestFixture';
import { TaskViewService, type TaskViewServiceOptions } from './taskViewService';
import { DEFAULT_KNOWLEDGE_BUDGETS } from '../../shared/knowledgeKernelContracts';
import { projectKnowledgeSnapshot } from '../agentData/knowledgeKernel/projection';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
function fixture(overrides: Partial<TaskViewServiceOptions> = {}) {
  const f = taskFixture(); cleanups.push(f.cleanup); const views = new TaskViewStore(f.db);
  const readTarget = vi.fn(async () => ({ exists: true, busy: false }));
  const dispatch = vi.fn(async (job: Job, metadata: { retryOf: string }) => f.jobs.create({ kind: job.kind, workspace: job.workspace, metadata: { ...job.metadata, ...metadata } }));
  const previewWikiRetry = vi.fn(async () => ({ sourceIds: ['original'], targetCount: 1, model: 'fixture/model' }));
  const service = new TaskViewService({ views, jobs: f.jobs, readTarget, dispatch, previewWikiRetry, canCancel: () => true, ...overrides });
  const failed = (kind = 'codegraph.sync') => { const job = f.jobs.create({ kind, workspace: '/repo', metadata: kind === 'wiki.ingest' ? { target: { type: 'wiki', id: 'kb' }, payload: { kbId: 'kb', sourceIds: ['original', 'deleted'] } } : undefined }); f.jobs.fail(job.id, 'old failure'); return job; };
  return { ...f, views, service, readTarget, dispatch, previewWikiRetry, failed };
}

describe('TaskViewService', () => {
  it('preserves the filtered active count when attaching task capabilities', async () => {
    const f = fixture();
    for (let index = 0; index < 101; index += 1) f.system(`history-${index}`, 'completed', 10);
    f.system('older-active', 'running', 1);
    const page = await f.service.list({ limit: 100 });
    expect(page.activeCount).toBe(1);
    expect(page.items.every((item) => item.status === 'completed')).toBe(true);
  });

  it('retries a failed known job as a new ID without mutating its history', async () => {
    const f = fixture(); const old = f.failed();
    const result = await f.service.retry({ source: 'user', id: old.id });
    expect(result).toMatchObject({ ref: { source: 'user' }, kind: old.kind, status: 'pending', retryOf: old.id });
    expect(result.ref.id).not.toBe(old.id);
    expect(f.jobs.get(old.id)).toMatchObject({ state: 'failed', error: 'old failure' });
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.previewWikiRetry).not.toHaveBeenCalled();
    expect(f.readTarget).toHaveBeenCalledTimes(2);
  });

  it('derives capabilities from a live executor and current target, keeping all system actions read-only', async () => {
    const f = fixture({ canCancel: (job) => job.kind === 'wiki.sync' });
    const retryable = f.failed(); const unknown = f.failed('unknown');
    const knownActive = f.jobs.create({ kind: 'wiki.sync', workspace: '/repo' });
    const unknownActive = f.jobs.create({ kind: 'unknown', workspace: '/repo' });
    f.system('system');
    const rows = (await f.service.list()).items;
    expect(rows.find((row) => row.ref.id === retryable.id)?.capabilities.retry).toBe(true);
    expect(rows.find((row) => row.ref.id === unknown.id)?.capabilities.retry).toBe(false);
    expect(rows.find((row) => row.ref.id === knownActive.id)?.capabilities.cancel).toBe(true);
    expect(rows.find((row) => row.ref.id === unknownActive.id)?.capabilities.cancel).toBe(false);
    expect((await f.service.read({ source: 'system', id: 'system' }))?.capabilities).toEqual({ cancel: false, retry: false, remove: false });
  });

  it.each(['missing', 'system', 'unknown', 'deleted', 'busy', 'active'] as const)('rejects %s retries before dispatch', async (reason) => {
    const f = fixture(); const job = reason === 'active' ? f.jobs.create({ kind: 'codegraph.sync', workspace: '/repo' }) : f.failed(reason === 'unknown' ? 'unknown' : undefined);
    if (reason === 'deleted') f.readTarget.mockResolvedValue({ exists: false, busy: false });
    if (reason === 'busy') f.readTarget.mockResolvedValue({ exists: true, busy: true });
    if (reason === 'system') f.system(job.id);
    await expect(f.service.retry({ source: reason === 'system' ? 'system' : 'user', id: reason === 'missing' ? 'missing' : job.id })).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
    if (!['system', 'missing', 'active'].includes(reason)) expect((await f.service.read({ source: 'user', id: job.id }))?.capabilities.retry).toBe(false);
  });

  it('rechecks target availability after a deferred lookup and prevents concurrent same-resource retry', async () => {
    const initial = deferred<{ exists: boolean; busy: boolean }>();
    const lookup = vi.fn().mockImplementationOnce(() => initial.promise).mockResolvedValue({ exists: false, busy: false });
    const f = fixture({ readTarget: lookup }); const one = f.failed(); const two = f.failed();
    const first = f.service.retry({ source: 'user', id: one.id });
    await expect(f.service.retry({ source: 'user', id: two.id })).rejects.toThrow('TASK_TARGET_BUSY');
    initial.resolve({ exists: true, busy: false });
    await expect(first).rejects.toThrow('TASK_TARGET_NOT_FOUND');
    expect(f.dispatch).not.toHaveBeenCalled();
    lookup.mockResolvedValue({ exists: true, busy: false });
    await expect(f.service.retry({ source: 'user', id: one.id })).resolves.toMatchObject({ retryOf: one.id });
  });

  it('requires model confirmation for both Wiki paths and rejects unavailable or changed models without new jobs', async () => {
    const f = fixture(); const old = f.failed('wiki.ingest'); const ref = { source: 'user' as const, id: old.id };
    await expect(f.service.previewRetry(ref)).resolves.toMatchObject({ callsModel: true, sourceIds: ['original'], targetCount: 1, model: 'fixture/model' });
    await expect(f.service.retry(ref)).rejects.toThrow('MODEL_CONFIRMATION_REQUIRED');
    await expect(f.service.retry(ref, { expectedModel: 'other/model' })).rejects.toThrow('MODEL_CHANGED');
    f.previewWikiRetry.mockResolvedValueOnce({ sourceIds: ['original'], targetCount: 1, model: '' });
    await expect(f.service.retry(ref, { expectedModel: 'fixture/model' })).rejects.toThrow('MODEL_UNAVAILABLE');
    const legacy = f.failed('wiki.sync');
    await expect(f.service.retry({ source: 'user', id: legacy.id })).rejects.toThrow('MODEL_CONFIRMATION_REQUIRED');
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.jobs.list()).toHaveLength(2);
  });

  it('passes only still-pending original source IDs to retry and never incorporates newer sources', async () => {
    const f = fixture(); const old = f.failed('wiki.ingest');
    f.previewWikiRetry.mockResolvedValue({ sourceIds: ['original', 'new-source'], targetCount: 2, model: 'fixture/model' });
    const result = await f.service.retry({ source: 'user', id: old.id }, { expectedModel: 'fixture/model' });
    expect(result.retryOf).toBe(old.id);
    expect(f.dispatch.mock.calls[0]?.[0].metadata?.payload).toEqual({ kbId: 'kb', sourceIds: ['original'] });
    expect(f.dispatch).toHaveBeenCalledWith(expect.anything(), { retryOf: old.id }, { expectedModel: 'fixture/model' });
    f.readTarget.mockResolvedValue({ exists: false, busy: false });
    expect((await f.service.read({ source: 'user', id: old.id }))?.capabilities.retry).toBe(false);
  });

  it('never resolves a model or starts a worker while listing or reading task capabilities', async () => {
    const f = fixture(); const old = f.failed('wiki.ingest');
    await expect(f.service.list()).resolves.toMatchObject({ items: [expect.objectContaining({ capabilities: expect.objectContaining({ retry: true }) })] });
    await expect(f.service.read({ source: 'user', id: old.id })).resolves.toMatchObject({ capabilities: { retry: true } });
    expect(f.previewWikiRetry).not.toHaveBeenCalled();
  });

  it('does not dispatch when the original record is removed during the final target recheck', async () => {
    const final = deferred<{ exists: boolean; busy: boolean }>();
    const target = vi.fn().mockResolvedValueOnce({ exists: true, busy: false }).mockImplementationOnce(() => final.promise);
    const f = fixture({ readTarget: target }); const old = f.failed();
    const retry = f.service.retry({ source: 'user', id: old.id });
    await vi.waitFor(() => expect(target).toHaveBeenCalledTimes(2));
    f.jobs.remove(old.id); final.resolve({ exists: true, busy: false });
    await expect(retry).rejects.toThrow('TASK_NOT_FOUND');
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

it('routes kernel repair through the coordinator and projects server capabilities',async()=>{
 const metadata=()=>({version:1 as const,key:{workspaceInstanceId:'w',projectId:'p',portableProjectId:'p',branch:'main',language:'en',domain:'wiki' as const},intent:'generate' as const,revision:0,phase:'prepare' as const,pipelineConfigHash:'p',budgets:structuredClone(DEFAULT_KNOWLEDGE_BUDGETS),resumePolicy:'auto' as const,counts:{planned:0,prepared:0,failed:0,blocked:0,published:0}});
 let f:ReturnType<typeof fixture>;const readKnowledgeSnapshot=vi.fn(async(job:Job)=>projectKnowledgeSnapshot(job));const actKnowledgeTask=vi.fn(async(job:Job)=>f.jobs.create({kind:job.kind,workspace:job.workspace,metadata:{...job.metadata,retryOf:job.id}}));
 f=fixture({readKnowledgeSnapshot,actKnowledgeTask,previewKnowledgeRetry:async()=>({model:'model',modelIdentity:'identity',planToken:'plan'})});const job=f.jobs.create({kind:'repoWiki.generate',workspace:'/repo',metadata:{repoWiki:metadata()}});f.jobs.fail(job.id,'failure');const ref={source:'user' as const,id:job.id};
 expect((await f.service.read(ref))?.knowledge?.run?.capabilities.repair).toBe(true);await f.service.retry(ref,{expectedModel:'model',expectedModelIdentity:'identity',expectedPlanToken:'plan'});expect(actKnowledgeTask).toHaveBeenCalledOnce();expect(f.dispatch).not.toHaveBeenCalled();
});
it('refuses kernel retry when the server snapshot disables repair',async()=>{
 const key={workspaceInstanceId:'w',projectId:'p',portableProjectId:'p',branch:'main',language:'en',domain:'wiki' as const};const meta={version:1 as const,key,intent:'generate' as const,revision:0,phase:'publish' as const,pipelineConfigHash:'p',budgets:structuredClone(DEFAULT_KNOWLEDGE_BUDGETS),resumePolicy:'auto' as const,counts:{planned:0,prepared:0,failed:1,blocked:0,published:0},publication:{id:'p',claimId:'c',intentHash:'h',state:'claimed' as const}};
 const action=vi.fn();const f=fixture({readKnowledgeSnapshot:async job=>projectKnowledgeSnapshot(job),actKnowledgeTask:action,previewKnowledgeRetry:async()=>({model:'model',modelIdentity:'identity',planToken:'plan'})});const job=f.jobs.create({kind:'repoWiki.generate',workspace:'/repo',metadata:{repoWiki:meta}});f.jobs.fail(job.id,'failure');await expect(f.service.retry({source:'user',id:job.id},{expectedModel:'model',expectedModelIdentity:'identity',expectedPlanToken:'plan'})).rejects.toThrow();expect(action).not.toHaveBeenCalled();
});
it('rejects same-name kernel retries when model identity or plan token changed',async()=>{
 const meta={version:1 as const,key:{workspaceInstanceId:'w',projectId:'p',portableProjectId:'p',branch:'main',language:'en',domain:'wiki' as const},intent:'generate' as const,revision:0,phase:'prepare' as const,pipelineConfigHash:'p',budgets:structuredClone(DEFAULT_KNOWLEDGE_BUDGETS),resumePolicy:'auto' as const,counts:{planned:0,prepared:0,failed:0,blocked:0,published:0}};
 const action=vi.fn();const f=fixture({readKnowledgeSnapshot:async job=>projectKnowledgeSnapshot(job),actKnowledgeTask:action,previewKnowledgeRetry:async()=>({model:'same name',modelIdentity:'new-identity',planToken:'new-plan'})});const job=f.jobs.create({kind:'repoWiki.generate',workspace:'/repo',metadata:{repoWiki:meta}});f.jobs.fail(job.id,'failure');const ref={source:'user' as const,id:job.id};
 await expect(f.service.retry(ref,{expectedModel:'same name',expectedModelIdentity:'old-identity',expectedPlanToken:'new-plan'})).rejects.toThrow('MODEL_CHANGED');await expect(f.service.retry(ref,{expectedModel:'same name',expectedModelIdentity:'new-identity',expectedPlanToken:'old-plan'})).rejects.toThrow('PLAN_CHANGED');expect(action).not.toHaveBeenCalled();
});
