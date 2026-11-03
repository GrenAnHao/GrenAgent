import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ clients: [] as any[] }));
vi.mock('../../vendor/repo-wiki/packages/process/src/client', () => ({
  RepoWikiProcessClient: class {
    pid = 123;
    calls: any[] = [];
    listeners: any[] = [];
    complete?: (...args: any[]) => Promise<string>;
    suppressCancelEvents = false;
    cancelStatus?: string;
    runResponse?: Promise<unknown>;
    constructor() { wire.clients.push(this); }
    async start() {}
    async stop() {}
    onLifecycle() { return () => {}; }
    subscribe(fn: any) { this.listeners.push(fn); return () => {}; }
    registerModelLease(_id: string, lease: any) { this.complete = lease.complete; return vi.fn(); }
    async cancelContext() {}
    async invokeScoped(action: string, input: any, scope: any) {
      this.calls.push({ action, input, scope });
      if (action === 'create') return { id: 'project', path: input.path, language: input.language, name: 'Project' };
      if (action === 'generate') return { run_id: input.resume_run_id, status: 'queued' };
      if (action === 'run') return this.runResponse ?? { id: 'task-1', status: this.cancelStatus ?? 'running', progress: 40, stage: 'generating', message: '生成 Architecture' };
      if (action === 'cancel') { this.cancelStatus = input.pause ? 'interrupted' : 'canceled'; if (!this.suppressCancelEvents) this.emit({ id: 'task-1', status: this.cancelStatus, progress: 40 }); return { status: 'cancel_requested' }; }
      return {};
    }
    emit(run: any) {
      const generation = this.calls.findLast((call) => call.action === 'generate');
      for (const listener of this.listeners) listener({ project_id: 'project', context_id: generation.scope.contextId, run, time: '2026-11-01T00:00:00Z' });
    }
  },
}));
import { RepoWikiService } from './repoWikiService';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); wire.clients.length = 0; });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'wiki-tasks-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b'); await mkdir(a); await mkdir(b);
  const commands = new Map<string, any>(), sent: any[] = [], stages: any[] = [];
  const jobs: any[] = [];
  let service: RepoWikiService;
  const requestAdmin = vi.fn(async (method: string, params: any = {}) => {
    if (method === 'admin.jobs.create') {
      const existing = jobs.find((job) => ['pending', 'running'].includes(job.state) && job.workspace === params.workspace);
      if (existing) return existing;
      const job = { id: 'task-1', ...params, state: 'pending', progress: 0, createdAt: 1, updatedAt: 1 }; jobs.push(job); return job;
    }
    if (method === 'admin.jobs.list') return jobs;
    if (method === 'admin.jobs.get') return jobs.find((job) => job.id === params.id);
    if (method === 'admin.jobs.stage') { stages.push(params); Object.assign(jobs[0], { progress: params.progress, metadata: { ...jobs[0].metadata, ...params } }); return jobs[0]; }
    if (method === 'admin.jobs.cancel') return (service as any).cancelTask({ id: params.id });
    if (method === 'admin.jobs.metadata') return jobs[0];
    throw new Error(method);
  });
  service = new RepoWikiService({ entry: 'fixture', dataDir: root, configurationPollMs: 0,
    allowedWorkspaces: async () => [a, b], projectSnapshot: () => [a, b], resolveModel: async () => ({ cacheKey: 'test', complete: async () => 'ok' }),
    registerCommand: (name, handler) => { commands.set(name, handler); }, isTrustedSender: () => true,
    tasks: { requestAdmin } } as any);
  cleanup.push(() => service.stop());
  const event = { sender: { id: 1, send: (...args: any[]) => sent.push(args) } };
  const raw = (action: string, input: any = {}) => commands.get('repoWiki_' + action)(event, input);
  const activate = async (path = a) => { const context = await raw('activate', { workspace: path, view_id: path === a ? 'view-a' : 'view-b' }); const result = await raw('hydrate', { __repoWikiContext: context.context_id }); return { ...context, project_id: result.project.id }; };
  const call = (context: any, action: string, input: any = {}) => raw(action, { ...input, __repoWikiContext: context.context_id });
  return { service, a, b, activate, call, raw, jobs, requestAdmin, stages, sent };
}

describe('Repo Wiki durable task execution boundary', () => {
  it('records a task before provider work and uses the stable task id across page release and reentry', async () => {
    const t = await setup(), context = await t.activate();
    const submitted = await t.call(context, 'generate', { project_id: 'project', confirm_external: true, target: 'wiki' });
    expect(submitted).toMatchObject({ run_id: 'task-1', status: 'queued' });
    expect(wire.clients[0].calls.filter((call: any) => call.action === 'generate')).toHaveLength(0);
    expect(t.jobs[0].metadata.payload).toMatchObject({ projectId: 'project', language: 'zh', target: 'wiki', confirmExternal: true });
    const execution = (t.service as any).runTask({ id: 'task-1', workspace: t.a, payload: t.jobs[0].metadata.payload });
    await vi.waitFor(() => expect(wire.clients[0].calls.some((call: any) => call.action === 'generate')).toBe(true));
    const generation = wire.clients[0].calls.find((call: any) => call.action === 'generate');
    expect(generation.input.resume_run_id).toBe('task-1');
    expect(generation.scope.contextId).not.toBe(context.context_id);
    await t.call(context, 'release'); await t.activate(t.b);
    wire.clients[0].emit({ id: 'task-1', status: 'running', progress: 40, stage: 'generating', message: '生成 Architecture' });
    await vi.waitFor(() => expect(t.stages.some((stage) => stage.message === '生成 Architecture')).toBe(true));
    const reopened = await t.activate();
    expect(await t.call(reopened, 'run', { project_id: 'project', target: 'wiki' })).toMatchObject({ id: 'task-1', progress: 40 });
    wire.clients[0].emit({ id: 'task-1', status: 'completed', progress: 100 });
    expect(await execution).toEqual({ cancelled: false });
  });
  it('deduplicates same-task execution and explicitly cancels through the persistent ledger', async () => {
    const t = await setup(), context = await t.activate();
    await t.call(context, 'generate', { project_id: 'project', confirm_external: true });
    const input = { id: 'task-1', workspace: t.a, payload: t.jobs[0].metadata.payload };
    const first = (t.service as any).runTask(input), second = (t.service as any).runTask(input);
    await vi.waitFor(() => expect(wire.clients[0].calls.some((call: any) => call.action === 'generate')).toBe(true));
    expect(wire.clients[0].calls.filter((call: any) => call.action === 'generate')).toHaveLength(1);
    await t.call(context, 'cancel', { project_id: 'project' });
    expect(t.requestAdmin).toHaveBeenCalledWith('admin.jobs.cancel', { id: 'task-1' });
    expect(await first).toEqual({ cancelled: true }); expect(await second).toEqual({ cancelled: true });
  });
  it('settles cancellation through the polling fallback when the terminal event is lost', async () => {
    const t = await setup(), context = await t.activate();
    await t.call(context, 'generate', { project_id: 'project', confirm_external: true });
    wire.clients[0].suppressCancelEvents = true;
    const execution = t.service.runTask({ id: 'task-1', workspace: t.a, payload: t.jobs[0].metadata.payload });
    await vi.waitFor(() => expect(wire.clients[0].calls.some((call: any) => call.action === 'generate')).toBe(true));
    await t.service.cancelTask({ id: 'task-1', pause: true });
    expect(await execution).toEqual({ cancelled: true });
    expect(wire.clients[0].calls.some((call: any) => call.action === 'run')).toBe(true);
  });
  it('rejects a changed retry model before dispatching a generation', async () => {
    const t = await setup(), context = await t.activate();
    await t.call(context, 'generate', { project_id: 'project', confirm_external: true });
    await expect(t.service.runTask({ id: 'task-1', workspace: t.a, payload: t.jobs[0].metadata.payload, expectedModel: 'confirmed/model' })).rejects.toThrow('MODEL_CHANGED');
    expect(wire.clients[0].calls.some((call: any) => call.action === 'generate')).toBe(false);
  });
  it('keeps the namespace queue intact when a waiting task is cancelled', async () => {
    const t = await setup(), context = await t.activate();
    await t.call(context, 'generate', { project_id: 'project', confirm_external: true });
    const input = { workspace: t.a, payload: t.jobs[0].metadata.payload };
    const first = t.service.runTask({ ...input, id: 'task-1' });
    await vi.waitFor(() => expect(wire.clients[0].calls.some((call: any) => call.action === 'generate')).toBe(true));
    const second = t.service.runTask({ ...input, id: 'task-2' });
    await vi.waitFor(() => expect(t.stages.some((stage) => stage.id === 'task-2' && stage.stage === '排队等待')).toBe(true));
    await t.service.cancelTask({ id: 'task-2' }); expect(await second).toEqual({ cancelled: true });
    const third = t.service.runTask({ ...input, id: 'task-3' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wire.clients[0].calls.filter((call: any) => call.action === 'generate')).toHaveLength(1);
    wire.clients[0].emit({ id: 'task-1', status: 'completed', progress: 100 }); await first;
    await vi.waitFor(() => expect(wire.clients[0].calls.filter((call: any) => call.action === 'generate')).toHaveLength(2));
    wire.clients[0].emit({ id: 'task-3', status: 'completed', progress: 100 }); await third;
  });
  it('ignores a stale poll snapshot after a newer progress event', async () => {
    const t = await setup(), context = await t.activate();
    await t.call(context, 'generate', { project_id: 'project', confirm_external: true });
    let release!: (value: unknown) => void;
    wire.clients[0].runResponse = new Promise((resolve) => { release = resolve; });
    const execution = t.service.runTask({ id: 'task-1', workspace: t.a, payload: t.jobs[0].metadata.payload });
    await vi.waitFor(() => expect(wire.clients[0].calls.some((call: any) => call.action === 'run')).toBe(true), { timeout: 3000 });
    wire.clients[0].emit({ id: 'task-1', status: 'running', progress: 70, page_id: 'latest-page', stage: 'generating' });
    await vi.waitFor(() => expect(t.stages.at(-1).progress).toBe(70));
    release({ id: 'task-1', status: 'running', progress: 20, page_id: 'stale-page' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.stages.at(-1).progress).toBe(70);
    wire.clients[0].emit({ id: 'task-1', status: 'completed', progress: 100 }); await execution;
  });
});
