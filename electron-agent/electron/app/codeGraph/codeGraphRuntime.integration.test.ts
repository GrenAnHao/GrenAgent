import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentDataRuntime } from '../../agentData/runtime';
import { AgentDataClient } from '../../agentData/client';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';
import { CodeGraphService } from './codeGraphService';
import { CodeGraphJobs } from './codeGraphJobs';

it('indexes through AgentData jobs and serves the same SDK graph to an authenticated agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-sdk-rpc-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  await writeFile(join(workspace, 'source.ts'), 'export function parse(value: string) { return value.trim(); }\n');
  const code = new CodeGraphService({ listWorkspaces: () => [workspace] });
  let admin: AgentDataClient | undefined;
  let agent: AgentDataClient | undefined;
  const jobs = new CodeGraphJobs(code, {
    start: (id) => admin!.request('admin.jobs.start', { id }),
    complete: (id) => admin!.request('admin.jobs.complete', { id }),
    fail: (id, error) => admin!.request('admin.jobs.fail', { id, error }),
    cancelled: (id) => admin!.request('admin.jobs.markCancelled', { id }),
    stage: (id, stage, processed, total) => runtime.recordJobStage(id, stage, processed, total),
  });
  const runtime = new AgentDataRuntime({
    dataPath: join(root, 'agent-data.db'), validateProject: async () => workspace,
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
    await expect.poll(async () => ['completed', 'failed', 'cancelled'].includes((await admin!.request<{ state: string }>('admin.jobs.get', { id: job.id })).state), { timeout: 20000 }).toBe(true);
    const finished = await admin.request<{ state: string; error?: string }>('admin.jobs.get', { id: job.id });
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
    await agent?.close();
    await admin?.close();
    runtime.close();
    await runtime.waitClosed();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
