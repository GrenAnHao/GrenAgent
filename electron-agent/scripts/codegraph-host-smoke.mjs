#!/usr/bin/env node
// codegraph-host 子进程冒烟：同步代码时主进程还卡不卡。
//
// 本脚本扮演 Electron 主进程，在同一个代码副本上跑两遍全量索引 + 增量同步 + 并发检索：
//   child：经真实的 codegraph-host.js 子进程（生产路径）；
//   inproc：在本进程里直接用 CodeGraph SDK（改动前主进程的做法），作对照。
// 全程用 monitorEventLoopDelay 记本进程的事件循环延迟，另有 10ms 心跳记最大间隔。
// 源码先复制到临时目录再建索引，不碰仓库里已有的 .codegraph。
//
// 先构建：npx electron-vite build --mode localrun --outDir <dir>，再（用应用自带的 Electron Node）：
//   ELECTRON_RUN_AS_NODE=1 <electron> --liftoff-only scripts/codegraph-host-smoke.mjs --entry <dir>/main/codegraph-host.js --source <源码目录>
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const entry = resolve(option('entry', join(appDir, 'out/main/codegraph-host.js')));
const workerEntry = resolve(option('worker', join(dirname(entry), 'codegraph-worker.js')));
const source = resolve(option('source', join(appDir, '..', 'extensions')));
// child：多线程子进程（现在）；child-single：子进程但 GREN_CODEGRAPH_THREADS=off（上一版）；inproc：本进程单线程（最初的主进程做法）。
const modes = option('modes', 'child,child-single,inproc').split(',');
const electronPath = createRequire(join(appDir, 'package.json'))('electron');
if (!existsSync(entry)) { console.error(`找不到 ${entry}`); process.exit(2); }

const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures.push(label); };
const skip = new Set(['node_modules', '.git', '.codegraph', 'dist', 'out', 'coverage']);
const copySource = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-smoke-'));
  cpSync(source, join(dir, 'src'), { recursive: true, filter: (path) => !skip.has(path.split(/[\\/]/).pop()) });
  return dir;
};
const countFiles = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, entry) => n + (entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1), 0);

/** 量事件循环：直方图给 p99 / max，另起 10ms 心跳记两次心跳之间的最大间隔（不受直方图分辨率影响）。 */
function meter() {
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let last = performance.now();
  let maxGap = 0;
  const beat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
  return () => {
    clearInterval(beat); lag.disable();
    return { p99Ms: Math.round(lag.percentile(99) / 1e6), maxMs: Math.round(lag.max / 1e6), maxHeartbeatGapMs: Math.round(maxGap) };
  };
}

/** 扮演主进程那一侧的 RpcPeer（与 extensions/_shared/rpc-peer.ts 同一个线协议）。 */
function launchChild(threads = true) {
  const child = spawn(electronPath, [entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEGRAPH_WORKER_ENTRY: workerEntry, GREN_CODEGRAPH_THREADS: threads ? 'on' : 'off' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  child.on('message', (message) => {
    if (message?.t === 'res') { const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); message.ok ? waiter.resolve(message.result) : waiter.reject(Object.assign(new Error(message.error.message), message.error)); }
    else if (message?.t === 'evt') for (const listener of listeners) listener(message.channel, message.payload);
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => { for (const w of pending.values()) w.reject(new Error(`CODEGRAPH_HOST_EXITED: code=${code} signal=${signal}`)); pending.clear(); resolve({ code, signal }); }));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ready timeout; stderr: ${stderr}`)), 30_000);
    listeners.add((channel) => { if (channel === 'host.ready') { clearTimeout(timer); resolve(); } });
    exited.then(() => { clearTimeout(timer); reject(new Error(`exited before ready; stderr: ${stderr}`)); });
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); child.send({ t: 'req', id, method, params }); });
  return { child, ready, exited, request, onEvent: (fn) => listeners.add(fn), stderr: () => stderr };
}

async function inprocEngine() {
  const sdkRequire = createRequire(createRequire(join(appDir, 'package.json')).resolve('@colbymchenry/codegraph'));
  const sdk = sdkRequire('@colbymchenry/codegraph');
  const graphs = new Map();
  const graphOf = async (workspace) => {
    if (!graphs.has(workspace)) graphs.set(workspace, sdk.isInitialized(workspace) ? await sdk.CodeGraph.open(workspace, { sync: false }) : await sdk.CodeGraph.init(workspace, { index: false }));
    return graphs.get(workspace);
  };
  return {
    async runSync(_jobId, workspace) {
      const graph = await graphOf(workspace);
      if (graph.getIndexState() !== 'complete') { const r = await graph.indexAll({}); if (!r.success) throw new Error('indexAll failed'); }
      else await graph.sync({});
    },
    async search(workspace, query, limit) { const graph = await graphOf(workspace); return { results: graph.searchNodes(query, { limit }).map(({ node }) => ({ symbol: node.name, file: node.filePath })) }; },
    async status(workspace) { const graph = await graphOf(workspace); return { files: graph.getStats().fileCount, nodes: graph.getStats().nodeCount, state: 'indexed' }; },
    async close() { for (const graph of graphs.values()) graph.close(); },
  };
}

async function scenario(mode) {
  const dir = copySource();
  const workspace = join(dir, 'src');
  const files = countFiles(workspace);
  console.log(`\n== ${mode}: ${files} 个文件（${source}）`);
  let engine; let host;
  if (mode.startsWith('child')) {
    host = launchChild(mode === 'child');
    await host.ready;
    let progressEvents = 0;
    host.onEvent((channel) => { if (channel === 'codegraph.progress') progressEvents += 1; });
    engine = {
      runSync: (jobId, ws) => host.request('codegraph.runSync', { jobId, workspace: ws }),
      search: (ws, query, limit) => host.request('codegraph.search', { workspace: ws, query, limit }),
      status: (ws) => host.request('codegraph.status', { workspace: ws }),
      close: async () => { await host.request('host.shutdown').catch(() => {}); await host.exited; },
      progressEvents: () => progressEvents,
    };
  } else {
    engine = await inprocEngine();
  }

  const result = { mode, files };
  // 0. 另一个已索引的小工作区 B（取源码里的一个子目录），用来量「A 全量索引期间查 B 要等多久」。
  const side = join(dir, 'side');
  cpSync(join(source, option('side', 'multi-agent')), side, { recursive: true, filter: (path) => !skip.has(path.split(/[\\/]/).pop()) });
  await engine.runSync('side-1', side);
  const sideSymbol = (await engine.search(side, 'run', 1)).results?.[0]?.symbol ?? 'run';

  // 1. A 全量索引，期间每 200ms 查一次 B（模拟用户同时在用另一个项目的代码面板 / code_explore），记每次延迟
  let stop = meter();
  const latencies = []; let searchErrors = 0;
  const started = performance.now();
  let syncing = true;
  const pinger = (async () => {
    // 延迟从「该发出的时刻」算起：线程被占住时定时器本身也会晚到，那段等待也是用户感受到的。
    let due = performance.now();
    while (syncing) {
      due += 200;
      await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
      if (!syncing) break;
      const t0 = Math.min(due, performance.now());
      try {
        const view = await engine.search(side, sideSymbol, 5);
        if (view.available === false) searchErrors += 1; else latencies.push(performance.now() - t0);
      } catch { searchErrors += 1; }
    }
  })();
  await engine.runSync('full-1', workspace);
  syncing = false; await pinger;
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
  result.fullIndex = {
    ms: Math.round(performance.now() - started), loop: stop(),
    otherWorkspaceQueries: { n: latencies.length, errors: searchErrors, p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: Math.round(sorted.at(-1) ?? 0) },
  };

  // 2. 改一个文件后增量同步，再查新增的符号
  // 跳过点开头的目录：建完索引后排第一的是 .codegraph 自己，写进去不在索引范围内。
  const target = readdirSync(workspace).find((n) => !n.startsWith('.') && statSync(join(workspace, n)).isDirectory()) ?? '.';
  appendFileSync(join(workspace, target, 'cgSmokeAdded.ts'), 'export function cgSmokeAddedSymbol() { return 1; }\n');
  stop = meter();
  const incStarted = performance.now();
  await engine.runSync('inc-1', workspace);
  result.incrementalSync = { ms: Math.round(performance.now() - incStarted), loop: stop() };
  const found = await engine.search(workspace, 'cgSmokeAddedSymbol', 5);
  result.incrementalVisible = (found.results ?? []).some((row) => row.symbol === 'cgSmokeAddedSymbol');

  // 3. 8 路并发检索
  stop = meter();
  const qStarted = performance.now();
  await Promise.all(['request', 'client', 'session', 'tool', 'config', 'workspace', 'memory', 'sandbox'].map((q) => engine.search(workspace, q, 20)));
  result.concurrentSearch = { ms: Math.round(performance.now() - qStarted), loop: stop() };
  result.status = await engine.status(workspace);
  if (engine.progressEvents) result.progressEvents = engine.progressEvents();
  await engine.close();
  if (host) result.exit = await host.exited;
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const results = {};
for (const mode of modes) results[mode] = await scenario(mode);

if (results.child) {
  const c = results.child;
  check(c.fullIndex.loop.p99Ms < 50, `child: 全量索引期间主进程事件循环 p99 ${c.fullIndex.loop.p99Ms}ms < 50ms`);
  check(c.fullIndex.loop.maxMs < 200 && c.fullIndex.loop.maxHeartbeatGapMs < 200, `child: 全量索引期间主进程最长卡顿 ${c.fullIndex.loop.maxMs}ms / 心跳间隔 ${c.fullIndex.loop.maxHeartbeatGapMs}ms < 200ms`);
  check(c.incrementalSync.loop.maxMs < 200, `child: 增量同步期间主进程最长卡顿 ${c.incrementalSync.loop.maxMs}ms < 200ms`);
  check(c.concurrentSearch.loop.maxMs < 200, `child: 8 路并发检索期间主进程最长卡顿 ${c.concurrentSearch.loop.maxMs}ms < 200ms`);
  const q = c.fullIndex.otherWorkspaceQueries;
  check(q.n >= 5 && q.errors === 0, `child: A 全量索引期间查 B ${q.n} 次，失败 ${q.errors} 次`);
  check(q.maxMs < 500, `child: A 全量索引期间查 B p50 ${q.p50Ms}ms / p95 ${q.p95Ms}ms / 最长 ${q.maxMs}ms（最长 < 500ms）`);
  check(c.incrementalVisible, 'child: 增量同步后新符号可查');
  check(c.status.files > 0 && c.status.state === 'indexed', `child: 状态 indexed，${c.status.files} 个文件`);
  check((c.progressEvents ?? 0) > 0, `child: 收到 ${c.progressEvents} 条进度事件`);
  check(c.exit?.code === 0, `child: 关停后子进程以 0 退出（${JSON.stringify(c.exit)}）`);
}
if (results['child-single']) {
  const s = results['child-single'].fullIndex;
  console.log(`对照 child-single（上一版单线程子进程）：全量索引期间主进程最长卡顿 ${s.loop.maxMs}ms；查 B ${s.otherWorkspaceQueries.n} 次，p50 ${s.otherWorkspaceQueries.p50Ms}ms / p95 ${s.otherWorkspaceQueries.p95Ms}ms / 最长 ${s.otherWorkspaceQueries.maxMs}ms`);
}
if (results.inproc) {
  const i = results.inproc.fullIndex;
  console.log(`对照 inproc（单线程）：全量索引期间主进程 p99 ${i.loop.p99Ms}ms，最长卡顿 ${i.loop.maxMs}ms；查 B ${i.otherWorkspaceQueries.n} 次，p50 ${i.otherWorkspaceQueries.p50Ms}ms / p95 ${i.otherWorkspaceQueries.p95Ms}ms / 最长 ${i.otherWorkspaceQueries.maxMs}ms`);
}
writeFileSync(join(tmpdir(), 'codegraph-host-smoke.json'), JSON.stringify(results, null, 2));
console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
process.exit(failures.length ? 1 : 0);
