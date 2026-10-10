#!/usr/bin/env node
// agent-host 子进程冒烟（见 docs/decisions/electron-agent/2026-10-09-agent-host-child-process.md）。
//
// 用真实的 agent-host.js、真实 pi SDK 与扩展，在临时 HOME 里跑一遍：
//   拉起 → 打开工作区 → MCP 连一台 N 个工具的桩服务器 → 关掉 → 再打开 → 读状态 / 命令 → 关停；
//   Windows 上再拉起一次、配上 pi-job-guard.exe，直接杀掉 agent-host，看残留的孙进程会不会被清掉。
// 本脚本扮演 Electron 主进程：全程记录自己的事件循环延迟，并每 50ms ping 一次子进程，
// 量出子进程自己被占住多久。不碰 ~/.pi 和应用数据目录，可以在应用开着的时候跑。
//
// 先构建：npx electron-vite build --mode localrun（或 npm run build），再：
//   node scripts/agent-host-smoke.mjs [--entry out/main/agent-host.js] [--tools 80]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const entry = resolve(appDir, option('entry', 'out/main/agent-host.js'));
const toolCount = Number(option('tools', '80'));
const electronPath = createRequire(join(appDir, 'package.json'))('electron');

if (!existsSync(entry)) {
  console.error(`找不到 ${entry}，先构建：npx electron-vite build --mode localrun`);
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), 'agent-host-smoke-'));
const agentDir = join(home, '.pi', 'agent');
const workspace = join(home, 'project');
const runtimeConfig = join(home, 'runtime-settings.json');
const stubPath = join(home, 'stub-mcp.mjs');
const stubPidFile = join(home, 'stub-mcp.pids');
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(runtimeConfig, '{}');
writeFileSync(stubPath, stubServerSource());

const stub = { name: 'stub', config: { command: process.execPath, args: [stubPath, String(toolCount), stubPidFile] } };
let mcpServers = [stub];

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const started = performance.now();
const ms = (from) => Math.round(performance.now() - from);

const hostMethods = {
  'host.resolveWorkspace': ({ path }) => path,
  'host.agentDataEndpoint': () => null,
  'host.mcpRuntime': () => mcpServers,
  'host.allowedPluginIds': () => ['mcp'],
  'host.authorize': () => ({ status: 'allowed', decision: 'allow' }),
  'host.mergeRuntimeSettings': ({ patch }) => {
    writeFileSync(runtimeConfig, JSON.stringify({ ...JSON.parse(readFileSync(runtimeConfig, 'utf8')), ...patch }));
    return null;
  },
  'host.thread.createThread': () => null,
  'host.thread.createTurn': () => null,
  'host.thread.updateTurn': () => null,
  'host.thread.upsertItem': () => null,
};

/** 拉起一个 agent-host，按主进程的那一侧处理协议。 */
function launchHost() {
  const child = spawn(electronPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      USERPROFILE: home,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_RUNTIME_CONFIG: runtimeConfig,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
  });
  const host = { child, stderr: '', broadcasts: [] };
  child.stdout.on('data', (chunk) => process.stdout.write(`[agent-host] ${chunk}`));
  child.stderr.on('data', (chunk) => { host.stderr += chunk; process.stderr.write(`[agent-host] ${chunk}`); });
  let nextId = 1;
  const pending = new Map();
  let readyResolve;
  host.ready = new Promise((resolveReady) => { readyResolve = resolveReady; });
  let exitResolve;
  host.exited = new Promise((resolveExit) => { exitResolve = resolveExit; });
  child.on('exit', (code, signal) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`agent-host exited (${code}/${signal})`));
    pending.clear();
    exitResolve({ code, signal });
  });
  child.on('message', async (message) => {
    if (message?.t === 'res') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error?.message ?? 'request failed'));
    } else if (message?.t === 'evt') {
      if (message.channel === 'host.ready') readyResolve();
      else if (message.channel === 'host.fatal') console.error('host.fatal', message.payload);
      else if (message.channel === 'broadcast') host.broadcasts.push(message.payload);
    } else if (message?.t === 'req') {
      const handler = hostMethods[message.method];
      try {
        if (!handler) throw new Error(`no host method ${message.method}`);
        child.send({ t: 'res', id: message.id, ok: true, result: await handler(message.params ?? {}) });
      } catch (error) {
        child.send({ t: 'res', id: message.id, ok: false, error: { message: error.message } });
      }
    }
  });
  child.on('error', (error) => console.error('agent-host process error', error.message));
  host.request = (method, params = {}) => new Promise((resolveRequest, reject) => {
    if (!child.connected) {
      reject(new Error('agent-host IPC channel closed'));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve: resolveRequest, reject });
    child.send({ t: 'req', id, method, params }, (error) => {
      if (!error) return;
      pending.delete(id);
      reject(error);
    });
  });
  return host;
}

const main = launchHost();
const { child, request, ready, exited } = main;

// 子进程卡住多久：每 50ms 发一条最便宜的请求，记往返时间。
let pingMax = 0;
let pingBusy = false;
let pingSentAt = 0;
const verbose = argv.includes('--verbose');
const pinger = setInterval(() => {
  if (pingBusy) return;
  pingBusy = true;
  const at = performance.now();
  pingSentAt = at;
  request('pi.listRunningTurns').then(() => {
    pingMax = Math.max(pingMax, performance.now() - at);
  }, () => {}).finally(() => { pingBusy = false; });
}, 50);
const reporter = verbose ? setInterval(() => {
  const waiting = pingBusy ? Math.round(performance.now() - pingSentAt) : 0;
  console.log(`      … ping 在途 ${waiting}ms，阶段内最长 ${Math.round(pingMax)}ms`);
}, 2000) : undefined;
const resetPhase = () => { pingMax = 0; lag.reset(); };
const phase = (label, at) => {
  console.log(`      ${label}: ${ms(at)}ms，主进程事件循环最长 ${Math.round(lag.max / 1e6)}ms，子进程最长 ${Math.round(pingMax)}ms 没响应`);
  return { parentMax: lag.max / 1e6, childMax: pingMax };
};

const toolsCacheEntry = () => {
  try {
    return JSON.parse(readFileSync(join(home, '.pi', 'mcp-tools-cache.json'), 'utf8'))?.stub;
  } catch {
    return undefined;
  }
};
const stubPids = () => (existsSync(stubPidFile) ? readFileSync(stubPidFile, 'utf8').trim().split(/\s+/).map(Number).filter(Boolean) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timeout: ${label}`);
}
const SLOW_PING_MS = 100;
/** MCP 连上后子进程还要注册工具；连续 1 秒没有哪条 ping 超过 100ms 没回才算忙完。 */
async function waitChildIdle(timeoutMs) {
  let quietSince = performance.now();
  let lastMax = pingMax;
  await waitFor(() => {
    const now = performance.now();
    const stalled = pingBusy && now - pingSentAt > SLOW_PING_MS;
    if (stalled || (pingMax !== lastMax && pingMax > SLOW_PING_MS)) quietSince = now;
    lastMax = pingMax;
    return now - quietSince > 1000;
  }, timeoutMs, 'agent-host idle');
}

try {
  resetPhase();
  let at = performance.now();
  await ready;
  phase('拉起到就绪', at);

  resetPhase();
  at = performance.now();
  const opened = await request('pi.openWorkspace', { workspace });
  await waitFor(() => toolsCacheEntry()?.ok === true, 60_000, 'stub MCP connected');
  await waitChildIdle(120_000);
  const open = phase(`打开工作区 + MCP 连上 ${toolCount} 个工具`, at);
  check(typeof opened?.sessionFile === 'string' || opened?.sessionFile === null, 'open_workspace 返回 sessionFile 字段');
  check(toolsCacheEntry()?.toolNames?.length === toolCount, `工具缓存记下 ${toolCount} 个工具`);
  check(open.parentMax < 200, '打开工作区、加载 MCP 期间主进程事件循环最长不到 200ms');
  const firstPids = stubPids();
  check(firstPids.length === 1 && alive(firstPids[0]), 'MCP 桩服务器在跑');

  resetPhase();
  at = performance.now();
  mcpServers = [];
  await request('mcp.hotReload', { workspace, runtime: '[]' });
  await waitFor(() => !alive(firstPids[0]), 15_000, 'stub MCP stopped');
  await waitChildIdle(60_000);
  const off = phase('关掉 MCP', at);
  check(off.parentMax < 200, '关 MCP 期间主进程事件循环最长不到 200ms');

  resetPhase();
  at = performance.now();
  mcpServers = [stub];
  await request('mcp.hotReload', { workspace, runtime: JSON.stringify([stub]) });
  await waitFor(() => stubPids().some((pid) => pid !== firstPids[0] && alive(pid)), 30_000, 'stub MCP restarted');
  await waitChildIdle(120_000);
  const on = phase('重新打开 MCP', at);
  check(on.parentMax < 200, '开 MCP 期间主进程事件循环最长不到 200ms');

  const state = await request('pi.send', { workspace, command: 'agent_get_state', args: {} });
  check(typeof state?.sessionId === 'string' && state.isStreaming === false, 'agent_get_state 跨进程返回会话状态');
  const commands = await request('pi.send', { workspace, command: 'agent_get_commands', args: {} });
  check(Array.isArray(commands?.commands) && commands.commands.length > 0, 'agent_get_commands 跨进程返回命令表');
  await request('pi.send', { workspace, command: 'agent_set_approval', args: { level: 'ask' } });
  const written = JSON.parse(readFileSync(runtimeConfig, 'utf8'));
  check(Object.values(written).includes('ask'), '审批档经主进程合并写进 runtime-settings.json');
  const catalog = await request('extensions.catalog');
  check(Array.isArray(catalog) && catalog.some((item) => item.name === 'mcp'), 'extensions.catalog 返回内置扩展清单');
  await request('pi.send', { workspace, command: 'agent_nope', args: {} }).then(
    () => check(false, '不支持的命令带着原错误信息失败'),
    (error) => check(/Unsupported Pi command/.test(error.message), '不支持的命令带着原错误信息失败'),
  );

  clearInterval(pinger);
  if (reporter) clearInterval(reporter);
  at = performance.now();
  const reply = request('host.shutdown').catch(() => null);
  const exit = await Promise.race([exited, new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 15_000))]);
  await reply;
  console.log(`      关停: ${ms(at)}ms`);
  check(exit !== null && exit.code === 0, '关停后子进程以 0 退出');
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  check(stubPids().every((pid) => !alive(pid)), '关停后 MCP 桩服务器也退出');

  if (process.platform === 'win32') await crashPhase();
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.error('FAIL ', error);
  if (main.stderr) console.error(main.stderr.slice(-4000));
} finally {
  clearInterval(pinger);
  if (reporter) clearInterval(reporter);
  if (child.exitCode === null) child.kill();
  for (const pid of stubPids()) if (alive(pid)) { try { process.kill(pid); } catch { /* 已退出 */ } }
  lag.disable();
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 上偶尔还被占用 */ }
}

console.log(`\n总耗时 ${ms(started)}ms，${failures.length ? `${failures.length} 项失败` : '全部通过'}`);
process.exit(failures.length ? 1 : 0);

/**
 * 崩溃清理（Windows）：桩服务器经 cmd /c 拉起，node 是 agent-host 的孙进程（和 cmd /c npx 一样）。
 * 只杀 agent-host 本身，libuv 会收掉直接子进程 cmd，孙进程 node 成了孤儿；守卫要把它清掉。
 */
async function crashPhase() {
  const guardExe = [join(dirname(entry), 'pi-job-guard.exe'), join(appDir, 'native', 'bin', 'pi-job-guard.exe')].find(existsSync);
  if (!guardExe) {
    check(false, '找不到 pi-job-guard.exe');
    return;
  }
  // 不理会 stdin EOF 的服务器：读到 EOF 就退出的服务器本来就不会残留
  const wrapped = { name: 'stub', config: { command: 'cmd.exe', args: ['/c', process.execPath, stubPath, String(toolCount), stubPidFile, 'stay'] } };
  mcpServers = [wrapped];
  const before = new Set(stubPids());
  const host = launchHost();
  const guard = spawn(guardExe, ['--pid', String(host.child.pid), '--wait-ms', '5000'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true, windowsHide: true });
  let guardOut = '';
  guard.stdout.on('data', (chunk) => { guardOut += chunk; });
  const guardExit = new Promise((resolveExit) => guard.on('exit', resolveExit));
  try {
    await waitFor(() => guardOut.includes('ready'), 5_000, 'job guard ready');
    await host.ready;
    await host.request('pi.openWorkspace', { workspace });
    const grandchild = await waitFor(() => stubPids().find((pid) => !before.has(pid) && alive(pid)), 60_000, 'wrapped stub MCP started');
    process.kill(host.child.pid);
    await host.exited;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    check(alive(grandchild), '崩溃后（清理前）cmd 包着的 MCP 服务器成了孤儿——要清理的就是它');
    guard.stdin.end();
    await Promise.race([guardExit, new Promise((resolveWait) => setTimeout(resolveWait, 15_000))]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    console.log(`      守卫：${guardOut.trim().split(/\r?\n/).pop()}`);
    check(!alive(grandchild), '守卫清掉了崩溃后残留的 MCP 服务器');
  } finally {
    if (host.child.exitCode === null) host.child.kill();
    if (guard.exitCode === null) guard.kill();
  }
}

function stubServerSource() {
  return `import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const count = Number(process.argv[2] ?? 80);
appendFileSync(process.argv[3], process.pid + '\\n');
const tools = Array.from({ length: count }, (_, i) => ({
  name: 'tool_' + i,
  description: 'Stub tool ' + i + ' used by the agent-host smoke test. It accepts a query and options.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look up' },
      limit: { type: 'number', description: 'Max results' },
      options: { type: 'object', properties: { deep: { type: 'boolean' }, mode: { type: 'string', enum: ['a', 'b', 'c'] } } },
    },
    required: ['query'],
  },
}));
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  } else if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
// 第 4 个参数 stay：stdin 关了也不退出，模拟不理会 EOF 的服务器（崩溃后会残留的那种）
if (process.argv[4] === 'stay') setInterval(() => {}, 1e9);
else process.stdin.on('end', () => process.exit(0));
`;
}
