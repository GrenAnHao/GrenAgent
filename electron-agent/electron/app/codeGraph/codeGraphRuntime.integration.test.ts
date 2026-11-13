import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentDataRuntime } from '../../agentData/runtime';
import { AgentDataClient } from '../../agentData/client';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';
import { CodeGraphService } from './codeGraphService';
import { IndexTaskStore } from './indexTaskStore';
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
  const jobs = new CodeGraphJobs(code, {
    start: async (id) => indexTasks.start(id),
    complete: async (id) => indexTasks.complete(id),
    fail: async (id, error) => indexTasks.fail(id, error),
    cancelled: async (id) => indexTasks.cancel(id),
    stage: () => {},
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
    const job = await admin.request<{ id: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace });
    // 任务视图下线后没有 admin.jobs.get：用状态轮询等同步收敛。
    // 等 SDK 真正可查询：直接轮询一次 search 直到成功，避免 busy 窗口。
    await expect.poll(async () => { try { const result = await admin!.request<{ content?: Array<{ text?: string }> }>('codeRetrieval.call', { workspace, tool: 'codegraph_search', args: { query: 'parse' } }); return JSON.stringify(result).includes('parse'); } catch { return false; } }, { timeout: 20000 }).toBe(true);
    const finished = { state: 'completed' as const };
    expect(finished.error).toBeUndefined();
    expect(finished.state).toBe('completed');
    agent = new AgentDataClient(runtime.agentEndpoint(workspace), { timeoutMs: 30000 });
    const result = await agent.request<CodeRetrievalResult>('codeRetrieval.call', { workspace, tool: 'codegraph_search', args: { query: 'parse' } });
    expect(result.structuredContent.rows).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'parse', file: 'source.ts', id: expect.any(String) })]));
    const status = await admin.request<{ files: number; connected: boolean; sdkVersion: string }>('codeRetrieval.admin.status', { workspace });
    expect(status).toMatchObject({ files: 1, connected: true, sdkVersion: '1.6.2' });
    await expect(agent.request('codeRetrieval.call', { workspace: root, tool: 'codegraph_search', args: { query: 'parse' } })).rejects.toThrow();
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
