import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexTaskStore } from '../app/codeGraph/indexTaskStore';
import { assembleAgentData } from './assemble';
import { AgentDataRuntime } from './runtime';

/**
 * 任务 3.1：传了 indexTasks 后，codegraph.sync 走 codegraph 自己的库，
 * 不再创建 agent_jobs 行；执行器的回调也只更新索引任务记录。
 */
let dir: string;
let tasks: IndexTaskStore;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codegraph-routing-')); tasks = new IndexTaskStore(join(dir, 'index-tasks.sqlite')); });
afterEach(() => { tasks.close(); rmSync(dir, { recursive: true, force: true }); });

describe('codegraph task routing', () => {
  it('creates an index task instead of an agent_jobs row', async () => {
    const runs: string[] = [];
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'agent-data.db'),
      indexTasks: tasks,
      jobRunners: {
        'codegraph.sync': { run: async (id: string, workspace: string) => { runs.push(workspace); tasks.start(id); tasks.complete(id); }, cancel: async () => {} },
      },
    });
    const endpoint = await runtime.start();
    try {
      const job = await runtime.requestAdmin<{ id: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace: 'D:/repo' });
      await vi.waitFor(() => expect(tasks.get(job.id)?.state).toBe('completed'));
      expect(runs).toEqual(['D:/repo']);
      // 共享库里的 agent_jobs 不应出现 codegraph.sync
      const sharedTables = runtime['storage']!.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => (row as { name: string }).name);
      if (sharedTables.includes('agent_jobs')) {
        const rows = runtime['storage']!.db.prepare("SELECT count(*) AS c FROM agent_jobs WHERE kind='codegraph.sync'").get() as { c: number };
        expect(rows.c).toBe(0);
      }
      expect(endpoint.port).toBeGreaterThan(0);
    } finally { runtime.close(); await runtime.waitClosed(); }
  });

  it('assemble forwards indexTasks to the runtime so manual sync is not retired', async () => {
    const runs: string[] = [];
    const assembled = assembleAgentData({
      dataPath: join(dir, 'agent-data.db'),
      indexTasks: tasks,
      model: { describe: async () => 'stub', complete: async () => '' },
      codeGraph: {
        projects: () => [],
        status: async (workspace: string) => ({ workspace, connected: true, indexed: true, sdkAvailable: true, sdkVersion: '1.6.2', state: 'indexed' as const }),
        search: async (workspace: string) => ({ workspace, available: true, results: [] }),
        call: async () => ({ content: [], isError: false, structuredContent: { schemaVersion: 1 as const, rows: [], nodes: [], edges: [] } }),
        runSync: async (_id: string, workspace: string) => { runs.push(workspace); },
        cancelSync: async () => {},
        close: async () => {},
      },
      resolveSession: async () => false,
      methods: { 'turn.start': async () => null, 'permission.authorize': async () => null, 'mcp.state.publish': async () => null },
    });
    try {
      await assembled.runtime.start();
      const job = await assembled.runtime.requestAdmin<{ id: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace: 'D:/repo' });
      await vi.waitFor(() => expect(tasks.get(job.id)?.state).toBe('completed'));
      expect(runs).toEqual(['D:/repo']);
    } finally { await assembled.close(); }
  });

  it('does not dispatch a second sync for the same workspace while one is active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const runs: string[] = [];
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'agent-data.db'),
      indexTasks: tasks,
      jobRunners: { 'codegraph.sync': { run: async (id: string, workspace: string) => { runs.push(workspace); tasks.start(id); await gate; tasks.complete(id); }, cancel: async () => {} } },
    });
    await runtime.start();
    try {
      const first = await runtime.requestAdmin<{ id: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace: 'D:/repo' });
      const second = await runtime.requestAdmin<{ id: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace: 'D:/repo' });
      expect(second.id).toBe(first.id);
      expect(runs).toHaveLength(1);
      release();
      await vi.waitFor(() => expect(tasks.get(first.id)?.state).toBe('completed'));
    } finally { runtime.close(); await runtime.waitClosed(); }
  });
});
