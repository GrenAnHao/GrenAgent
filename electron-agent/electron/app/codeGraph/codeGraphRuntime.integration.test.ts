import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentDataRuntime } from '../../agentData/runtime';
import { AgentDataClient } from '../../agentData/client';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';
import { CodeGraphService } from './codeGraphService';
import { IndexTaskStore, type IndexTask } from './indexTaskStore';
import { CodeGraphJobs } from './codeGraphJobs';

it('indexes through AgentData jobs and serves the same SDK graph to an authenticated agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-sdk-rpc-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  await writeFile(join(workspace, 'source.ts'), 'export function parse(value: string) { return value.trim(); }\n');
  const code = new CodeGraphService({ listWorkspaces: () => [workspace] });
  let admin: AgentDataClient | undefined;
  let agent: AgentDataClient | undefined;
  const indexTasks = new IndexTaskStore(join(root, 'index-tasks.sqlite'));
  // 与生产 assemble 一致：回调直接写 IndexTaskStore，不再经共享库 admin.jobs.* 回写。
  const progress: IndexTask[] = [];
  const jobs = new CodeGraphJobs(code, {
    start: async (id) => indexTasks.start(id),
    complete: async (id) => indexTasks.complete(id),
    fail: async (id, error) => indexTasks.fail(id, error),
    cancelled: async (id) => indexTasks.cancel(id),
    stage: (id, stage, processed, total) => {
      const update = indexTasks.stage(id, stage, processed !== undefined ? { processed, total } : undefined);
      if (update) progress.push(update);
    },
  });
  const runtime = new AgentDataRuntime({
    dataPath: join(root, 'agent-data.db'),
    indexTasks,
    jobRunners: { 'codegraph.sync': jobs },
    codeRetrieval: {
      projects: () => code.projects(), status: async (path) => ({ ...await code.status(path) }),
      search: async (path, query, limit) => ({ ...await code.search(path, query, limit) }),
      call: (path, tool, args) => code.call(path, tool, args),
    },
  });
  try {
    admin = new AgentDataClient(await runtime.start(), { timeoutMs: 30000 });
    const job = await runtime.requestAdmin<{ id: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace });
    const desktopStatus = () => runtime.requestAdmin<{manualTask?:IndexTask; indexed:boolean; lastIndexedAt:number | null; syncedAt:number | null}>('codeRetrieval.admin.status',{workspace});
    await expect.poll(async () => (await desktopStatus()).manualTask?.state, { timeout:20000 }).toBe('completed');
    expect(await desktopStatus()).toMatchObject({indexed:true,manualTask:{id:job.id,progress:100}});
    expect(progress.some(s => s.id === job.id && s.state === 'running' && s.stage === '解析代码' && s.total === 1)).toBe(true);

    await writeFile(join(workspace,'consumer.ts'), "import { parse } from './source'; export const trim = parse('x');\n");
    const sync = await runtime.requestAdmin<{id:string}>('admin.jobs.create',{kind:'codegraph.sync',workspace});
    await expect.poll(async () => (await desktopStatus()).manualTask, {timeout:20000}).toMatchObject({id:sync.id,state:'completed'});
    expect(progress.some(s=>s.id===sync.id && s.state==='running' && typeof s.processed==='number' && (s.total??0)>0)).toBe(true);
    const committedAt = (await desktopStatus()).syncedAt!;
    expect(committedAt).toBeGreaterThan(0);
    const noop = await runtime.requestAdmin<{id:string}>('admin.jobs.create', {kind:'codegraph.sync', workspace});
    await expect.poll(async () => (await desktopStatus()).manualTask, {timeout:20000}).toMatchObject({id: noop.id, state:'completed'});
    const checked = await desktopStatus();
    expect(checked.manualTask!.updatedAt).toBeGreaterThan(committedAt);
    expect(checked.syncedAt).toBe(committedAt);

    const rebuild = await runtime.requestAdmin<{id:string}>('admin.jobs.create', {kind:'codegraph.sync', workspace, rebuild:true});
    await expect.poll(async () => (await desktopStatus()).manualTask, {timeout:20000}).toMatchObject({id: rebuild.id, state:'completed'});
    expect(progress.some((row) => row.id === rebuild.id && row.stage === '解析代码' && row.total === 2)).toBe(true);
    expect((await desktopStatus()).syncedAt).toBeGreaterThan(committedAt);
    const overview=await runtime.requestAdmin<CodeRetrievalResult>('codeRetrieval.call',{workspace,tool:'codegraph_files',args:{sort:'references',hideIgnored:true,languageCounts:true,limit:10}});
    expect(overview.structuredContent).toMatchObject({extra:{languages:{typescript:2}}});
    expect(overview.structuredContent.rows[0]).toMatchObject({file:'source.ts',incomingFiles:1});
    agent = new AgentDataClient(runtime.agentEndpoint(workspace), { timeoutMs: 30000 });
    const result = await agent.request<CodeRetrievalResult>('codeRetrieval.call', { workspace, tool: 'codegraph_search', args: { query: 'parse' } });
    expect(result.structuredContent.rows).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'parse', file: 'source.ts', id: expect.any(String) })]));
    const status = await admin.request<{ files: number; connected: boolean; sdkVersion: string }>('codeRetrieval.admin.status', { workspace });
    expect(status).toMatchObject({ files: 2, connected: true, sdkVersion: '1.6.4' });
    expect(status).not.toHaveProperty('manualTask'); // The loopback port cannot see the local desktop's task ledger.
    await expect(agent.request('codeRetrieval.call', { workspace: root, tool: 'codegraph_search', args: { query: 'parse' } })).rejects.toThrow();

    // Removing a file changes the graph but cannot advance MAX(files.indexed_at).
    const beforeDelete = (await desktopStatus()).syncedAt!;
    await rm(join(workspace, 'consumer.ts'));
    const deletion = await runtime.requestAdmin<{id:string}>('admin.jobs.create', { kind:'codegraph.sync', workspace });
    await expect.poll(async () => (await desktopStatus()).manualTask,{timeout:20000}).toMatchObject({id:deletion.id,state:'completed'});
    expect((await desktopStatus()).syncedAt).toBeGreaterThan(beforeDelete);
  } finally {
    await jobs.close();
    indexTasks.close();
    await agent?.close();
    await admin?.close();
    runtime.close();
    await runtime.waitClosed();
    // Windows 上 SQLite 的 -shm 释放有延迟；重试几次再删。
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 4) throw error; await new Promise((resolve) => setTimeout(resolve, 300)); }
    }
  }
}, 30000);
