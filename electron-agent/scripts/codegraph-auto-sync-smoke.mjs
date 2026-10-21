#!/usr/bin/env node
// codegraph-host 自动同步冒烟：扮演 agentdata-host，经真实的 codegraph-host.js 子进程（多线程、真实 SDK）验证：
//   ① 已建索引的工作区被查询后挂上文件监听；新增文件里的符号在几秒内可查，期间没有用户可见的任务（不调 runSync）；
//   ② 删除文件后符号消失；
//   ③ 一次改动几百个文件时，同工作区的查询在增量同步期间照常应答（不报 busy），结果带 servingStale 标记；
//   ④ 删除整个目录（监听说不清具体文件，整树比对）后其中的符号消失；
//   ⑤ 别的进程持有 codegraph.lock：状态是 backoff + CODEGRAPH_LOCKED、不是 failed；锁释放后自动重试成功；
//   ⑥ 自动同步在跑时发起的手动同步排在后面、照常完成；
//   ⑦ 关停后子进程以 0 退出。
// 源码复制到临时目录再建索引，不碰仓库里的 .codegraph。
//
// 先构建（输出目录必须在 electron-agent 里，SDK 从入口所在目录向上解析）：
//   npx electron-vite build --mode localrun --outDir out/cg-smoke
// 再用应用自带的 Electron Node 跑：
//   ELECTRON_RUN_AS_NODE=1 <electron> --liftoff-only scripts/codegraph-auto-sync-smoke.mjs --entry out/cg-smoke/main/codegraph-host.js [--json <file>]
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const entry = resolve(option('entry', join(appDir, 'out/cg-smoke/main/codegraph-host.js')));
const workerEntry = resolve(option('worker', join(dirname(entry), 'codegraph-worker.js')));
const source = resolve(option('source', join(appDir, '..', 'extensions')));
const jsonOut = option('json', '');
const electronPath = createRequire(join(appDir, 'package.json'))('electron');
if (!existsSync(entry)) { console.error(`找不到 ${entry}`); process.exit(2); }

const failures = [];
const report = { checks: [], timings: {}, syncEvents: [] };
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  report.checks.push({ ok: Boolean(ok), label, ...(detail === undefined ? {} : { detail }) });
  if (!ok) failures.push(label);
};
const info = (label, value) => console.log(`INFO  ${label}  ${typeof value === 'string' ? value : JSON.stringify(value)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = new Set(['node_modules', '.git', '.codegraph', 'dist', 'out', 'coverage']);

function launchChild() {
  const child = spawn(electronPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEGRAPH_WORKER_ENTRY: workerEntry, GREN_CODEGRAPH_THREADS: 'on', GREN_CODEGRAPH_AUTO_SYNC: 'on' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true,
  });
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

const dir = mkdtempSync(join(tmpdir(), 'cg-autosync-'));
cpSync(source, join(dir, 'src'), { recursive: true, filter: (path) => !skip.has(path.split(/[\\/]/).pop()) });
const host = launchChild();
host.onEvent((channel, payload) => { if (channel === 'codegraph.syncEvent') report.syncEvents.push(payload); });

const status = () => host.request('codegraph.status', { workspace: dir });
const search = (query) => host.request('codegraph.call', { workspace: dir, tool: 'codegraph_search', args: { query, limit: 20 } });
const hasSymbol = (result, name) => (result?.structuredContent?.rows ?? []).some((row) => row.symbol === name);
async function until(predicate, timeoutMs, stepMs = 100) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return { ok: true, ms: Math.round(performance.now() - start), value };
    await sleep(stepMs);
  }
  return { ok: false, ms: Math.round(performance.now() - start) };
}
const idle = async () => { const s = await status(); return s.phase === 'idle' ? s : false; };

try {
  await host.ready;
  info('临时工作区', dir);

  // —— 先建索引（用户手动建立，是唯一会建 .codegraph 的路径）——
  let started = performance.now();
  await host.request('codegraph.runSync', { jobId: 'init', workspace: dir });
  report.timings.initialIndexMs = Math.round(performance.now() - started);
  const initial = await status();
  check(initial.state === 'indexed' && initial.files > 0, '手动建立索引完成', { files: initial.files, ms: report.timings.initialIndexMs });

  // —— ① 被查询后挂上监听，新增符号几秒内可查 ——
  await search('register');
  const armed = await until(async () => { const s = await status(); return s.watcher?.active && s.phase === 'idle' ? s : false; }, 30_000);
  check(armed.ok, '第一次查询后挂上文件监听、激活补同步结束', armed.value ? { watcher: armed.value.watcher, generation: armed.value.generation } : armed);
  writeFileSync(join(dir, 'src', 'auto-sync-probe.ts'), 'export function uniqueSymbolXyzAutoSync() { return 42; }\n');
  started = performance.now();
  let sawNotice = false;
  const appear = await until(async () => {
    const result = await search('uniqueSymbolXyzAutoSync');
    if (result.content?.some((block) => block.text?.includes('has not caught up') && block.text.includes('auto-sync-probe.ts'))) sawNotice = true;
    return hasSymbol(result, 'uniqueSymbolXyzAutoSync');
  }, 20_000, 100);
  report.timings.editToQueryableMs = appear.ms;
  check(appear.ok && appear.ms < 10_000, '新增文件的符号在 10 秒内可查（编辑到可查）', `${appear.ms} ms`);
  info('索引追上之前的结果里给过「还没追上」的提示', sawNotice);

  // —— ② 删除文件后符号消失 ——
  unlinkSync(join(dir, 'src', 'auto-sync-probe.ts'));
  const gone = await until(async () => !hasSymbol(await search('uniqueSymbolXyzAutoSync'), 'uniqueSymbolXyzAutoSync'), 20_000);
  report.timings.deleteToGoneMs = gone.ms;
  check(gone.ok, '删除文件后符号消失', `${gone.ms} ms`);

  // —— ③ 几百个文件的增量同步期间，同工作区查询照常应答 ——
  await until(idle, 20_000);
  mkdirSync(join(dir, 'src', 'bulk'), { recursive: true });
  for (let i = 0; i < 400; i += 1) {
    writeFileSync(join(dir, 'src', 'bulk', `m${i}.ts`), `export function bulkAutoSymbol${i}(input: number) { return input + ${i}; }\nexport class BulkAutoClass${i} { run() { return bulkAutoSymbol${i}(${i}); } }\n`);
  }
  started = performance.now();
  let queries = 0; let busy = 0; let errors = 0; let staleAnswers = 0; let sawSyncing = false;
  const latencies = [];
  const converge = await until(async () => {
    const t0 = performance.now();
    try {
      const result = await search('register');
      latencies.push(performance.now() - t0);
      queries += 1;
      if (result.structuredContent?.meta?.servingStale) staleAnswers += 1;
    } catch (error) {
      if (String(error.message).includes('busy indexing')) busy += 1; else errors += 1;
    }
    const s = await status();
    if (s.phase === 'syncing') sawSyncing = true;
    return hasSymbol(await search('bulkAutoSymbol399'), 'bulkAutoSymbol399') && s.phase === 'idle';
  }, 60_000, 50);
  latencies.sort((a, b) => a - b);
  report.timings.bulkSyncMs = converge.ms;
  report.timings.queryDuringSync = { count: queries, p50Ms: Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0), maxMs: Math.round(latencies.at(-1) ?? 0) };
  check(converge.ok, '400 个新文件同步完，新符号可查', `${converge.ms} ms`);
  check(sawSyncing, '期间看到过 phase: syncing');
  check(busy === 0 && errors === 0 && queries > 0, '增量同步期间同工作区查询没有 busy、没有报错', { queries, busy, errors });
  check(staleAnswers > 0, '期间的结果带 servingStale 标记', { staleAnswers });

  // —— ④ 删除整个目录 ——
  rmSync(join(dir, 'src', 'bulk'), { recursive: true, force: true });
  const dirGone = await until(async () => !hasSymbol(await search('bulkAutoSymbol7'), 'bulkAutoSymbol7'), 30_000);
  report.timings.dirDeleteToGoneMs = dirGone.ms;
  check(dirGone.ok, '删除整个目录后其中的符号消失', `${dirGone.ms} ms`);

  // —— ⑤ 别的进程持锁：延后而不是失败，释放后自动重试 ——
  await until(idle, 20_000);
  const lock = join(dir, '.codegraph', 'codegraph.lock');
  writeFileSync(lock, String(process.pid));
  writeFileSync(join(dir, 'src', 'locked-probe.ts'), 'export function lockedProbeSymbol() { return 1; }\n');
  const deferred = await until(async () => { const s = await status(); return s.phase === 'backoff' && s.lastError?.code === 'CODEGRAPH_LOCKED' ? s : false; }, 20_000);
  check(deferred.ok, '持锁时进入 backoff，lastError.code = CODEGRAPH_LOCKED', deferred.value ? { state: deferred.value.state, nextRetryInMs: deferred.value.nextRetryAt - Date.now(), consecutiveFailures: deferred.value.consecutiveFailures } : deferred);
  check(deferred.value && deferred.value.state !== 'failed' && deferred.value.consecutiveFailures === 0, '持锁不算失败（state 不是 failed、失败次数 0）');
  const answering = await search('register').then(() => true, () => false);
  check(answering, '持锁期间查询照常应答');
  unlinkSync(lock);
  const recovered = await until(async () => hasSymbol(await search('lockedProbeSymbol'), 'lockedProbeSymbol'), 40_000, 200);
  check(recovered.ok, '锁释放后自动重试成功、新符号可查', `${recovered.ms} ms`);

  // —— ⑥ 自动同步在跑时的手动同步：排队、照常完成 ——
  await until(idle, 20_000);
  for (let i = 0; i < 200; i += 1) writeFileSync(join(dir, 'src', `queued-${i}.ts`), `export function queuedSymbol${i}() { return ${i}; }\n`);
  await until(async () => (await status()).phase === 'syncing', 10_000, 20);
  const stages = [];
  host.onEvent((channel, payload) => { if (channel === 'codegraph.progress' && payload?.jobId === 'manual-while-auto') stages.push(payload.progress?.phase); });
  started = performance.now();
  const manual = await host.request('codegraph.runSync', { jobId: 'manual-while-auto', workspace: dir }).then(() => 'completed', (error) => `failed: ${error.message}`);
  check(manual === 'completed', '自动同步在跑时发起的手动同步照常完成（不再报 busy）', { result: manual, ms: Math.round(performance.now() - started), firstStage: stages[0] });
  info('手动同步收到的阶段', [...new Set(stages)]);
  check(hasSymbol(await search('queuedSymbol199'), 'queuedSymbol199'), '手动同步完成后新文件都已可查');

  report.final = await status();
  info('最终状态', { phase: report.final.phase, state: report.final.state, generation: report.final.generation, watcher: report.final.watcher, files: report.final.files });
  check(report.syncEvents.every((event) => event.outcome !== 'failed' && event.outcome !== 'breaker'), '全程没有同步失败事件', report.syncEvents);

  // —— ⑦ 关停 ——
  await host.request('host.shutdown');
  const exit = await Promise.race([host.exited, sleep(20_000).then(() => ({ code: 'timeout' }))]);
  check(exit.code === 0, '关停后子进程以 0 退出', exit);
} catch (error) {
  check(false, '冒烟中途出错', `${error.stack ?? error}\nstderr: ${host.stderr()}`);
  host.child.kill();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

report.passed = failures.length === 0;
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
console.log(failures.length ? `\n${failures.length} 项失败` : `\n全部 ${report.checks.length} 项通过`);
process.exit(failures.length ? 1 : 0);
