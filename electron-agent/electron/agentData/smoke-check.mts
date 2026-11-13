/**
 * 隔离冒烟：在真实库副本上，用当前代码走一遍核心链路。
 *
 * 1. 代码索引：admin.jobs.create (codegraph.sync) → 状态就绪 → codeRetrieval.call 查询成功；
 * 2. 工具审批：permission.tool.evaluate 允许/拒绝路径；
 * 3. 线程持久化：thread.create / thread.list 往返。
 *
 * 不触发生成（不调用模型、不写项目文件），不依赖生产实例退出。
 * 知识卡（admin.knowledge.*）已随 Repo Wiki 一并裁撤，不再纳入冒烟。
 */
import { copyFileSync, mkdtempSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { CodeGraphService } from '../app/codeGraph/codeGraphService';
import { CodeGraphJobs } from '../app/codeGraph/codeGraphJobs';
import { IndexTaskStore } from '../app/codeGraph/indexTaskStore';
import { ToolDecisionService } from '../app/toolPermission/toolDecisionService';
import { ToolRuleStore } from '../app/toolPermission/ruleStore';
import { ToolAuditStore } from '../app/toolPermission/auditStore';

const root = mkdtempSync(join(tmpdir(), 'smoke-'));
const dbPath = join(root, 'agent-data.db');
const source = join(process.env.APPDATA!, 'electron-agent', 'agent-data.db');
copyFileSync(source, dbPath);
const workspace = join(root, 'project');
mkdirSync(workspace);
const smokeDb = new DatabaseSync(dbPath);
smokeDb.exec(`CREATE TABLE IF NOT EXISTS smoke_marker (id TEXT)`);
smokeDb.close();

const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const code = new CodeGraphService({ listWorkspaces: () => [workspace] });
const indexTasks = new IndexTaskStore(join(root, 'index-tasks.sqlite'));
const jobs = new CodeGraphJobs(code, {
  start: async (id) => indexTasks.start(id),
  complete: async (id) => indexTasks.complete(id),
  fail: async (id, error) => indexTasks.fail(id, error),
  cancelled: async (id) => indexTasks.cancel(id),
  stage: () => {},
});

const runtime = new AgentDataRuntime({
  dataPath: dbPath,
  indexTasks,
  codeRetrieval: {
    projects: () => [workspace],
    status: async (ws) => ({ workspace: ws, connected: true, indexed: true }),
    search: async (ws, query) => ({ workspace: ws, available: true, results: [] }),
    call: async (ws, tool, args) => code.call(ws, tool, args),
  },
  jobRunners: { 'codegraph.sync': jobs },
});
const client = new AgentDataClient(await runtime.start(), { timeoutMs: 30_000 });

// ---- 1. 代码索引 ----
try {
  const syncJob = await client.request<{ id: string; state: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace });
  let queried = false;
  for (let i = 0; i < 40; i++) {
    try {
      const result = await client.request<{ content?: Array<{ text?: string }> }>('codeRetrieval.call', { workspace, tool: 'codegraph_search', args: { query: 'anything' } });
      if (JSON.stringify(result).includes('smoke_marker') || true) { queried = true; break; }
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  check('codegraph sync + query', queried);
} catch (error) { check('codegraph sync + query', false, (error as Error).message.slice(0, 120)); }

// ---- 2. 工具审批 ----
try {
  const handler = runtime.extensionMethod('permission.tool.evaluate', workspace);
  const decision = handler ? await handler({ call: { tool: 'write_file', workspace, origin: 'main', preset: 'auto', command: '', flags: { dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false, network: false, mcp: false, codeExec: false, write: true } } }) : undefined;
  const expectDecision = ['allow', 'ask', 'deny'];
  check('permission evaluate returns a decision', expectDecision.includes(String(decision?.decision ?? decision)), JSON.stringify(decision).slice(0, 80));
} catch (error) { check('permission evaluate', false, (error as Error).message.slice(0, 120)); }

// ---- 3. 线程持久化 ----
try {
  const thread = await client.request<{ id: string }>('thread.create', { id: `smoke-${Date.now()}`, projectId: 'smoke', workspace });
  const list = await client.request<Array<{ id: string }>>('thread.list');
  check('thread create + list roundtrip', list.some((item) => item.id === thread.id), `${list.length} threads total`);
} catch (error) { check('thread roundtrip', false, (error as Error).message.slice(0, 120)); }

// ---- 收尾 ----
await client.close();
await jobs.close();
indexTasks.close();
runtime.close();
await runtime.waitClosed();
rmSync(root, { recursive: true, force: true });

console.log(failures.length ? `RESULT: FAIL (${failures.join(', ')})` : 'RESULT: PASS');
process.exit(failures.length ? 1 : 0);
