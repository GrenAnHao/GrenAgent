#!/usr/bin/env node
// 子代理重新设计第 3 阶段的实跑：真实 agent-host + 真实模型，运行时设置 SUBAGENT_BACKEND=worker。
//   1. 一次性 run 走常驻 worker（pi-worker --mode subagent），子会话是真会话，meta 记 backend: worker
//   2. 后台 spawn 走 worker 可续聊：结算通知回来后 send_message 续聊，worker 已退出则冷恢复回新的 worker
//   3. fork 在 worker 后端也可用
// 后台每 1.5 秒查一次 --mode subagent 进程，记下见过的 pid。
// 用临时 HOME，只把 ~/.pi/agent 的 models.json / auth.json 拷进去（结束时连同临时目录删除），
// 不碰真实 ~/.pi 和应用数据目录。日志里出现的密钥值会被替换成 <redacted>。
//
// 先构建：cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-p3
// 再跑：  node .agents/evidence/2026-10-11-subagent-redesign/real-run-stage3.mjs [--model provider/id] [--log 路径]
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const appDir = join(repo, 'electron-agent');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const outMain = resolve(appDir, option('out', 'out/subagent-p3'), 'main');
const entry = join(outMain, 'agent-host.js');
const workerEntry = join(outMain, 'pi-worker.js');
const [provider, ...modelRest] = option('model', 'custom-muqywnc8/claude-haiku-5-5').split('/');
const modelId = modelRest.join('/');
const logPath = option('log', join(here, 'real-run-stage3.txt'));
const electronPath = createRequire(join(appDir, 'package.json'))('electron');

if (!existsSync(entry) || !existsSync(workerEntry)) {
  console.error(`找不到 ${entry} 或 pi-worker.js，先构建`);
  process.exit(2);
}

const realAgentDir = join(homedir(), '.pi', 'agent');
const home = mkdtempSync(join(tmpdir(), 'subagent-p3-real-'));
const agentDir = join(home, '.pi', 'agent');
const workspace = join(home, 'project');
const runtimeConfig = join(home, 'runtime-settings.json');
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
for (const name of ['models.json', 'auth.json']) {
  if (existsSync(join(realAgentDir, name))) copyFileSync(join(realAgentDir, name), join(agentDir, name));
}
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
writeFileSync(runtimeConfig, JSON.stringify({ SUBAGENT_BACKEND: 'worker' }));
// worker 用例走 executor 档案（worktree），需要有提交的 git 仓库
writeFileSync(join(workspace, 'README.md'), '# subagent phase 1 real run\n');
const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
git('init', '-q');
git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'add', '.');
git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-q', '-m', 'init');

// 收集要从日志里抹掉的密钥值
const secrets = new Set();
const collect = (value, key = '') => {
  if (typeof value === 'string') {
    if (/key|token|secret|authorization|password/i.test(key) && value.length >= 8) secrets.add(value);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collect(v, k);
  }
};
for (const name of ['models.json', 'auth.json']) {
  try { collect(JSON.parse(readFileSync(join(agentDir, name), 'utf8'))); } catch { /* 没有就算了 */ }
}
const redact = (text) => [...secrets].reduce((t, s) => t.split(s).join('<redacted>'), text);

const lines = [];
const log = (...parts) => {
  const line = redact(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
  lines.push(line);
  console.log(line);
};
const failures = [];
const check = (ok, label) => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

// 主进程的 AgentData 通道桩：工具授权（permission.tool.evaluate）一律放行，其余方法照实报不支持。
// 真实应用里这是主进程的 toolPermission / memory 服务；这里只验证子代理后端，不验证授权。
const dataToken = randomBytes(16).toString('hex');
const dataMethods = new Map();
const dataServer = createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      dataMethods.set(req.method, (dataMethods.get(req.method) ?? 0) + 1);
      const reply = (body) => socket.write(JSON.stringify({ id: req.id, ...body }) + '\n');
      if (req.token !== dataToken) reply({ ok: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } });
      else if (req.method === 'permission.tool.evaluate') reply({ ok: true, result: { decision: 'allow', auditId: 'stub' } });
      else if (req.method === 'permission.authorize') reply({ ok: true, result: { status: 'allowed', decision: 'allow' } });
      else if (req.method.startsWith('permission.')) reply({ ok: true, result: {} });
      else reply({ ok: false, error: { code: 'METHOD_NOT_FOUND', message: `stub: ${req.method}` } });
    }
  });
  socket.on('error', () => {});
});
await new Promise((r) => dataServer.listen(0, '127.0.0.1', r));
const dataEndpoint = JSON.stringify({ host: '127.0.0.1', port: dataServer.address().port, token: dataToken });
secrets.add(dataToken);

const hostMethods = {
  'host.resolveWorkspace': ({ path }) => path,
  'host.agentDataEndpoint': () => dataEndpoint,
  'host.mcpRuntime': () => [],
  'host.allowedPluginIds': () => [],
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

const child = spawn(electronPath, [entry], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    USERPROFILE: home,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_RUNTIME_CONFIG: runtimeConfig,
    PI_WORKER_ENTRY: workerEntry,
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  serialization: 'advanced',
  windowsHide: true,
});
// 观察 worker 进程：Windows 上按命令行找 --mode subagent。
const workerPids = new Set();
const pollWorkers = () => {
  if (process.platform !== 'win32') return;
  const ps = spawn('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -notlike 'powershell*' -and $_.CommandLine -like '*pi-worker.js*--mode subagent*' } | ForEach-Object { $_.ProcessId }"], { windowsHide: true });
  let out = '';
  ps.stdout.on('data', (c) => { out += c; });
  ps.on('close', () => { for (const t of out.split(/\s+/)) if (/^\d+$/.test(t)) workerPids.add(Number(t)); });
};
const workerPoll = setInterval(pollWorkers, 1500);
let stderr = '';
child.stdout.on('data', (c) => { stderr += c; });
child.stderr.on('data', (c) => { stderr += c; });
let nextId = 1;
const pending = new Map();
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
let exitResolve;
const exited = new Promise((r) => { exitResolve = r; });
child.on('exit', (code, signal) => {
  for (const w of pending.values()) w.reject(new Error(`agent-host exited (${code}/${signal})`));
  pending.clear();
  exitResolve({ code, signal });
});
child.on('message', async (m) => {
  if (m?.t === 'res') {
    const w = pending.get(m.id);
    if (!w) return;
    pending.delete(m.id);
    if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error?.message ?? 'request failed'));
  } else if (m?.t === 'evt') {
    if (m.channel === 'host.ready') readyResolve();
    else if (m.channel === 'host.fatal') log('host.fatal', m.payload);
  } else if (m?.t === 'req') {
    const handler = hostMethods[m.method];
    try {
      if (!handler) throw new Error(`no host method ${m.method}`);
      child.send({ t: 'res', id: m.id, ok: true, result: await handler(m.params ?? {}) });
    } catch (error) {
      child.send({ t: 'res', id: m.id, ok: false, error: { message: error.message } });
    }
  }
});
const request = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { resolve: res, reject: rej });
  child.send({ t: 'req', id, method, params }, (e) => { if (e) { pending.delete(id); rej(e); } });
});
const send = (command, args = {}) => request('pi.send', { workspace, command, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let idleSince = 0;
  while (Date.now() < deadline) {
    const state = await send('agent_get_state');
    if (!state?.isStreaming) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince > 2000) return;
    } else idleSince = 0;
    await sleep(250);
  }
  throw new Error('timeout: 父会话没回到空闲');
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timeout: ${label}`);
}
const messages = async () => (await send('agent_get_messages'))?.messages ?? [];
const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '';
const brief = (m) => ({
  role: m.role,
  ...(m.toolName ? { toolName: m.toolName } : {}),
  ...(m.customType ? { customType: m.customType } : {}),
  ...(m.isError ? { isError: true } : {}),
  text: textOf(m.content).slice(0, 400),
  ...(m.role === 'assistant' ? { toolCalls: (m.content ?? []).filter((b) => b?.type === 'toolCall').map((b) => ({ name: b.name, arguments: b.arguments })) } : {}),
  ...(m.details && typeof m.details === 'object'
    ? { details: Object.fromEntries(Object.entries(m.details).filter(([k]) => !['transcript', 'transcriptTail', 'diff'].includes(k))) }
    : {}),
});

const TASK = 'Reply with exactly the two letters OK and nothing else. Do not use any tools.';
const promptFor = (args, after) =>
  `This is an automated smoke test. Call the spawn_agent tool exactly once with these arguments: ${JSON.stringify(args)}. ${after}`;

async function runCase(label, args, after) {
  log(`\n=== ${label} ===`);
  const before = (await messages()).length;
  const at = Date.now();
  await send('agent_prompt', { message: promptFor(args, after) });
  await waitIdle(240_000);
  const fresh = (await messages()).slice(before);
  log(`  用时 ${Date.now() - at}ms，新消息 ${fresh.length} 条`);
  for (const m of fresh) log('  ', brief(m));
  const result = fresh.find((m) => m.role === 'toolResult' && m.toolName === 'spawn_agent');
  return { fresh, result };
}

try {
  await ready;
  log(`agent-host 就绪；模型 ${provider}/${modelId}；worker 入口 ${workerEntry}`);
  await request('pi.openWorkspace', { workspace });
  const model = await send('agent_set_model', { provider, modelId });
  log('父会话模型', { provider: model?.provider, id: model?.id });
  try { await send('agent_set_thinking_level', { level: 'off' }); } catch (e) { log('设置思考档失败（忽略）', e.message); }

  const ask = async (label, message) => {
    log(`\n=== ${label} ===`);
    const before = (await messages()).length;
    const at = Date.now();
    await send('agent_prompt', { message });
    await waitIdle(240_000);
    const fresh = (await messages()).slice(before);
    log(`  用时 ${Date.now() - at}ms，新消息 ${fresh.length} 条`);
    for (const m of fresh) log('  ', brief(m));
    return { fresh, before };
  };
  const toolResult = (fresh, name) => fresh.find((m) => m.role === 'toolResult' && m.toolName === name);
  const metaOf = (file) => {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    return [...lines].reverse().find((e) => e.customType === 'subagent_meta')?.data;
  };

  // 1. 一次性 run 走 worker：起了 pi-worker --mode subagent 进程，子会话 meta 记 backend: worker
  {
    const before = new Set(workerPids);
    const { fresh } = await ask(
      'worker 一次性 run',
      `This is an automated smoke test. Call the spawn_agent tool exactly once with these arguments: ${JSON.stringify({ action: 'run', task: TASK })}. After it returns, reply with exactly the sub-agent output and nothing else.`,
    );
    const result = toolResult(fresh, 'spawn_agent');
    check(!!result && !result.isError, 'worker run：工具结果不是错误');
    check(textOf(result?.content).trim() === 'OK', 'worker run：工具结果正文是 OK');
    const childFile = result?.details?.sessionPath;
    check(typeof childFile === 'string' && existsSync(childFile), 'worker run：带子会话 sessionPath（worker 里也是真会话，有 JSONL）');
    check(typeof childFile === 'string' && metaOf(childFile)?.backend === 'worker', 'worker run：子会话 subagent_meta 记 backend: worker');
    check([...workerPids].some((pid) => !before.has(pid)), `worker run：观察到 pi-worker --mode subagent 进程（累计 ${workerPids.size} 个）`);
  }

  // 2. 后台 spawn 走 worker：可续聊；结算通知回来后 send_message 续聊（worker 已退出，冷恢复回 worker）
  {
    const { before } = await ask(
      'worker 后台 spawn',
      `Call the spawn_agent tool exactly once with these arguments: ${JSON.stringify({ action: 'spawn', task: TASK })}. After it returns, reply with just the word STARTED and do not call any other tool.`,
    );
    const all = await messages();
    const spawned = toolResult(all.slice(before), 'spawn_agent');
    const childId = spawned?.details?.agentId;
    check(spawned?.details?.mode === 'continuable', 'worker spawn：走可续聊（Activation 在宿主，会话在 worker）');
    const firstNotice = await waitFor(
      async () => (await messages()).slice(before).find((m) => m.customType === 'subagent-settled' && m.details?.childId === childId),
      180_000,
      '第一条 subagent-settled',
    );
    await waitIdle(180_000);
    check(firstNotice?.details?.stopReason === 'completed' && /Its closing message:\s*\n?OK\b/.test(textOf(firstNotice?.content)), 'worker spawn：第一条结算通知 completed，正文 OK');
    const pidsBeforeFollowUp = new Set(workerPids);
    const follow = await ask(
      'send_message 续聊（冷恢复回 worker）',
      `Call the send_message tool exactly once with ${JSON.stringify({ agent_id: childId, message: 'Now reply with exactly the word AGAIN and nothing else. Do not use any tools.' })}. Then reply with just the word SENT and do not call any other tool.`,
    );
    const sent = toolResult(follow.fresh, 'send_message');
    check(!!sent && !sent.isError, 'send_message：送达（子代理已结算、worker 已退出，按 JSONL 冷恢复）');
    const secondNotice = await waitFor(
      async () => (await messages()).slice(follow.before).find((m) => m.customType === 'subagent-settled' && m.details?.childId === childId),
      180_000,
      '续聊后的 subagent-settled',
    );
    await waitIdle(180_000);
    log('   第二条通知：', brief(secondNotice));
    check(/AGAIN/.test(textOf(secondNotice?.content)), '续聊：第二条结算通知带回 AGAIN');
    check([...workerPids].some((pid) => !pidsBeforeFollowUp.has(pid)), '续聊：冷恢复起了新的 worker 进程');
  }

  // 3. fork 在 worker 后端也可用
  {
    const { fresh } = await ask(
      'worker fork',
      `Call the spawn_agent tool exactly once with these arguments: ${JSON.stringify({ action: 'run', fork: true, task: 'Reply with exactly the word FORKED and nothing else. Do not use any tools.' })}. After it returns, reply with exactly the sub-agent output and nothing else.`,
    );
    const result = toolResult(fresh, 'spawn_agent');
    check(!!result && !result.isError, 'worker fork：工具结果不是错误');
    check(result?.details?.forked === true && Number(result?.details?.inheritedEventCount) > 0, `worker fork：继承了父会话 ${result?.details?.inheritedEventCount} 条已完成事件`);
    const childFile = result?.details?.sessionPath;
    check(typeof childFile === 'string' && metaOf(childFile)?.backend === 'worker', 'worker fork：子会话 meta 记 backend: worker');
    // 继承来的上下文里有父会话「调用 spawn_agent」那条用户消息（DSH / Codex 的 fork 也带着它），子代理开头注入继承说明。
    // 模型是否遵守这段说明因次而异（实跑里见过照做也见过再派一个），所以这里只查机制：说明在子代理任务前面；回复只记录。
    const childLines = typeof childFile === 'string' ? readFileSync(childFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
    const userTexts = childLines.filter((e) => e.type === 'message' && e.message?.role === 'user').map((e) => textOf(e.message.content));
    check(
      userTexts.some((t) => t.startsWith('You are now a newly spawned child agent.') && t.includes('Reply with exactly the word FORKED')),
      'worker fork：子代理任务前面有继承说明（照 Codex）',
    );
    log(`   子代理的回复：${textOf(result?.content).slice(0, 200)}`);
    for (const e of childLines.slice(-5)) log(`   子会话尾部：${JSON.stringify(e).slice(0, 500)}`);
  }
} catch (error) {
  failures.push(String(error?.message ?? error));
  log('FAIL ', String(error?.stack ?? error));
} finally {
  clearInterval(workerPoll);
  log(`\n观察到的 worker 进程 pid：${[...workerPids].join(', ') || '(无)'}`);
  const reply = request('host.shutdown').catch(() => null);
  await Promise.race([exited, sleep(15_000)]);
  await reply;
  if (child.exitCode === null) child.kill();
  dataServer.close();
  log('\nAgentData 桩收到的方法：', Object.fromEntries(dataMethods));
  const tail = stderr.split(/\r?\n/).filter((l) => /error|fail|subagent|worker/i.test(l) && !/ExperimentalWarning/.test(l)).slice(-40);
  if (tail.length) { log('\nagent-host 输出里与错误 / 子代理相关的行（最多 40 行）：'); for (const l of tail) log('  ', l); }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 上偶尔还被占用 */ }
  log(`\n临时目录已删除：${!existsSync(home)}`);
  log(failures.length ? `${failures.length} 项失败` : '全部通过');
  writeFileSync(logPath, lines.join('\n') + '\n');
}
process.exit(failures.length ? 1 : 0);
