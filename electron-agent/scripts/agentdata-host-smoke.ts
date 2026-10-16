// agentdata-host 冒烟：AgentData 在子进程里时，主进程在真实负载下是否还卡。
//
// 本脚本扮演 Electron 主进程（用应用自带的 Electron Node 跑）：
//   child：用 AgentProcessClient 拉起构建产物里真实的 agentdata-host.js，经 AgentDataService(child) 访问；
//   inproc：AgentDataRuntime 直接在本进程里（改动前的做法），作对照。
// 两种模式在同一份真实 agent-data.db 的副本上跑同一份负载，全程记本进程的事件循环延迟与 10ms 心跳间隔。
// 负载：回合持久化（每 50ms 一条 7 KB item.upsert）、每 200ms 一次工具授权评估、最大线程 thread.read、
// 审计查询、记忆对话列表与检索、任务列表；另验证崩溃重拉（kill 子进程）后扩展端点仍可用，以及关停后库完好。
//
//   electron-vite build --mode localrun，然后：
//   ELECTRON_RUN_AS_NODE=1 <electron> node_modules/tsx/dist/cli.mjs scripts/agentdata-host-smoke.ts --db <真实库副本> [--seconds 20]
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AgentDataClient } from '../electron/agentData/client';
import { AgentDataRuntime } from '../electron/agentData/runtime';
import { AgentProcessClient } from '../electron/agentProcess/agentProcessClient';
import { AgentDataService } from '../electron/app/agentDataService';
import type { AgentDataHostConfig } from '../electron/agentDataProcess/contract';
import { agentDataPipePath } from '../electron/agentDataProcess/pipePath';

const argv = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const sourceDb = option('db');
if (!sourceDb) { console.error('--db <agent-data.db 副本> 必填'); process.exit(2); }
const seconds = Number(option('seconds', '20'));
const modes = (option('modes', 'child,inproc') ?? '').split(',');
const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(option('entry', join(here, '..', 'out', 'main', 'agentdata-host.js'))!);
const failures: string[] = [];
const check = (ok: boolean, label: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures.push(label); };

function meter() {
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let last = performance.now(); let maxGap = 0;
  const beat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
  return () => { clearInterval(beat); lag.disable(); return { p99Ms: Math.round(lag.percentile(99) / 1e6), maxMs: Math.round(lag.max / 1e6), maxHeartbeatGapMs: Math.round(maxGap) }; };
}

function pick(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const big = db.prepare('select thread_id id from items group by thread_id order by sum(length(payload)) desc limit 1').get() as { id: string };
  const mid = db.prepare('select thread_id id from items group by thread_id having sum(length(payload)) < 900000 order by sum(length(payload)) desc limit 1').get() as { id: string };
  const turn = db.prepare('select id from turns where thread_id=? limit 1').get(big.id) as { id: string };
  const user = (db.prepare('select user_id from memories limit 1').get() as { user_id?: string } | undefined)?.user_id ?? 'local';
  const counts = Object.fromEntries(['items', 'memories', 'tool_audit', 'service_tasks', 'threads', 'agent_jobs'].map((t) => [t, Number((db.prepare(`select count(*) c from ${t}`).get() as { c: number }).c)]));
  db.close();
  return { bigThread: big.id, midThread: mid.id, turn: turn.id, user, counts };
}

async function scenario(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), `adh-${mode}-`));
  const dbPath = join(dir, 'agent-data.db');
  copyFileSync(sourceDb!, dbPath);
  const fixture = pick(dbPath);
  const workspace = join(dir, 'ws');
  let service: AgentDataService;
  let proc: AgentProcessClient | undefined;
  let runtime: AgentDataRuntime | undefined;
  const startT = performance.now();
  if (mode === 'child') {
    service = new AgentDataService({
      mode: 'child',
      listenPath: agentDataPipePath(),
      createProcess: (launchState) => (proc = new AgentProcessClient({
        entry,
        execPath: process.execPath,
        env: () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTDATA_HOST_CONFIG: JSON.stringify({ ...launchState(), dataPath: dbPath, worksDir: join(dir, 'works'),
          codeGraph: { hostEntry: '', workerEntry: '', jobGuardExe: '', execPath: process.execPath } } satisfies AgentDataHostConfig) }),
        hostMethods: {
          'main.model.describe': () => 'smoke/none',
          'main.model.complete': async () => { throw new Error('MODEL_UNAVAILABLE: smoke'); },
          'main.model.abort': () => null,
          'main.resolveSession': () => false,
          'main.method': () => ({ status: 'allowed', decision: 'allow' }),
        },
        onEvent: () => {},
        log: (stream, line) => { if (stream === 'stderr' && !/ExperimentalWarning|trace-warnings/.test(line)) console.error(`[agentdata-host] ${line}`); },
        readyTimeoutMs: 60_000,
      })),
    });
  } else {
    runtime = new AgentDataRuntime({ dataPath: dbPath });
    service = new AgentDataService({ runtime });
  }
  await service.start();
  const startupMs = Math.round(performance.now() - startT);
  const endpoint = await service.agentEndpoint(workspace);
  const extension = new AgentDataClient(endpoint, { timeoutMs: 30_000, closeOnTimeout: false });

  const stop = meter();
  const latency: Record<string, number[]> = {};
  const errors: Record<string, number> = {};
  const errorSamples: Record<string, Set<string>> = {};
  const timed = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    try { await fn(); (latency[name] ??= []).push(performance.now() - t0); } catch (error) {
      errors[name] = (errors[name] ?? 0) + 1;
      const e = error as { code?: string; message?: string };
      (errorSamples[name] ??= new Set()).add(`${e.code ?? ''} ${String(e.message).slice(0, 160)} @${Math.round(performance.now() - t0)}ms`);
    }
  };
  const until = performance.now() + seconds * 1000;
  const loop = async (everyMs: number, name: string, fn: () => Promise<unknown>) => {
    let due = performance.now();
    while (performance.now() < until) {
      due += everyMs;
      await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
      if (performance.now() >= until) break;
      await timed(name, fn);
    }
  };
  const payload = { text: 'x'.repeat(7000) };
  const call = { tool: 'bash', workspace, origin: 'main', preset: 'workspace', command: 'ls',
    flags: { dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false, network: false, mcp: false, codeExec: false, write: false } };
  await Promise.all([
    loop(50, 'item.upsert', () => service.upsertItem({ id: randomUUID(), threadId: fixture.bigThread, turnId: fixture.turn, type: 'tool_result', status: 'completed', payload })),
    loop(200, 'permission.tool.evaluate', () => extension.request('permission.tool.evaluate', { call })),
    loop(1500, 'thread.read(mid)', () => service.readThread(fixture.midThread)),
    loop(4000, 'thread.read(largest)', () => service.readThread(fixture.bigThread).catch((e: { code?: string }) => { if (e?.code !== 'FRAME_TOO_LARGE') throw e; })),
    loop(2000, 'audit.query', () => service.requestAdmin('admin.audit.query', { limit: 50 })),
    loop(2000, 'memory.conversations.list', () => service.requestAdmin('memory.conversations.list', { userId: fixture.user, filter: { scope: 'all' }, limit: 50 })),
    loop(1000, 'memory.conversations.search', () => extension.request('memory.conversations.search', { userId: fixture.user, workspace, query: 'agent', limit: 20, includeOtherProjects: true })),
    loop(2000, 'tasks.list', () => service.requestAdmin('admin.tasks.list', { limit: 100 })),
  ]);
  const loopStats = stop();
  const summary = Object.fromEntries(Object.entries(latency).map(([k, v]) => {
    const s = [...v].sort((a, b) => a - b);
    return [k, { n: s.length, p50: Math.round(s[Math.floor(s.length / 2)]), p95: Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), max: Math.round(s.at(-1)!) }];
  }));

  const result: Record<string, unknown> = { mode, startupMs, fixture: fixture.counts, mainLoop: loopStats, ops: summary, errors,
    errorSamples: Object.fromEntries(Object.entries(errorSamples).map(([k, v]) => [k, [...v].slice(0, 5)])) };

  if (mode === 'child' && proc) {
    // 崩溃重拉：直接杀子进程。之后主进程的下一条请求把它拉回来；扩展手里旧的端点（同一管道、同一令牌）继续可用。
    const pid = proc.pid!;
    process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    const after = await service.requestAdmin<{ items: unknown[] }>('admin.tasks.list', { limit: 5 }).then(() => 'ok', (e: Error) => e.message);
    result.restart = { requestAfterKill: after, relaunchMs: Math.round(performance.now() - t0), newPid: proc.pid, oldPid: pid };
    const ext2 = new AgentDataClient(endpoint, { timeoutMs: 10_000 });
    result.restart = { ...(result.restart as object), extensionAfterRestart: await ext2.request('permission.tool.evaluate', { call }).then(() => 'ok', (e: Error) => e.message) };
    await ext2.close();
  }
  await extension.close();
  const t0 = performance.now();
  await service.stop();
  runtime?.close(); await runtime?.waitClosed();
  result.shutdownMs = Math.round(performance.now() - t0);
  const check2 = new DatabaseSync(dbPath, { readOnly: true });
  result.integrity = (check2.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  check2.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
  return result as { mainLoop: { p99Ms: number; maxMs: number; maxHeartbeatGapMs: number }; errors: Record<string, number>; ops: Record<string, { n: number }>; restart?: { requestAfterKill: string; extensionAfterRestart: string; newPid?: number; oldPid: number }; integrity: string };
}

async function main() {
  const results: Record<string, Awaited<ReturnType<typeof scenario>>> = {};
  for (const mode of modes) results[mode] = await scenario(mode);
  const c = results.child;
  if (c) {
    check(c.mainLoop.p99Ms < 50, `child: 负载期间主进程事件循环 p99 ${c.mainLoop.p99Ms}ms < 50ms`);
    check(c.mainLoop.maxMs < 200 && c.mainLoop.maxHeartbeatGapMs < 200, `child: 主进程最长卡顿 ${c.mainLoop.maxMs}ms / 心跳间隔 ${c.mainLoop.maxHeartbeatGapMs}ms < 200ms`);
    check(Object.keys(c.errors).length === 0, `child: 负载中请求错误 ${JSON.stringify(c.errors)}`);
    check((c.ops['item.upsert']?.n ?? 0) > seconds * 10, `child: item.upsert 完成 ${c.ops['item.upsert']?.n} 次`);
    check(c.restart?.requestAfterKill === 'ok' && c.restart.newPid !== c.restart.oldPid, `child: kill 子进程后主进程请求自动重拉（${JSON.stringify(c.restart)}）`);
    check(c.restart?.extensionAfterRestart === 'ok', 'child: 重拉后扩展手里原来的端点（同一管道、令牌）仍可用');
    check(c.integrity === 'ok', `child: 关停后库 integrity_check = ${c.integrity}`);
  }
  if (results.inproc) {
    const i = results.inproc;
    console.log(`对照 inproc：主进程事件循环 p99 ${i.mainLoop.p99Ms}ms，最长卡顿 ${i.mainLoop.maxMs}ms，心跳最大间隔 ${i.mainLoop.maxHeartbeatGapMs}ms`);
  }
  console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
  process.exit(failures.length ? 1 : 0);
}
void main();
