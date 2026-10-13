#!/usr/bin/env node
// 子代理重新设计第 2 阶段的实跑：真实 agent-host + 真实模型。
//   1. 回归：进程内一次性（action:run，前台交付不变）
//   2. 后台 spawn ×2 + wait_agent：wait_agent 只回摘要，结果经 subagent-settled 通知交回，没有 jobs
//   3. 回归：worker（action:run，executor 档案 = worktree）
// 用临时 HOME，只把 ~/.pi/agent 的 models.json / auth.json 拷进去（结束时连同临时目录删除），
// 不碰真实 ~/.pi 和应用数据目录。日志里出现的密钥值会被替换成 <redacted>。
//
// 先构建：cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-p2
// 再跑：  node .agents/evidence/2026-10-11-subagent-redesign/real-run-stage2.mjs [--model provider/id] [--log 路径]
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
const outMain = resolve(appDir, option('out', 'out/subagent-p2'), 'main');
const entry = join(outMain, 'agent-host.js');
const workerEntry = join(outMain, 'pi-worker.js');
const [provider, ...modelRest] = option('model', 'custom-muqywnc8/claude-haiku-5-5').split('/');
const modelId = modelRest.join('/');
const logPath = option('log', join(here, 'real-run-stage2.txt'));
const electronPath = createRequire(join(appDir, 'package.json'))('electron');

if (!existsSync(entry) || !existsSync(workerEntry)) {
  console.error(`找不到 ${entry} 或 pi-worker.js，先构建`);
  process.exit(2);
}

const realAgentDir = join(homedir(), '.pi', 'agent');
const home = mkdtempSync(join(tmpdir(), 'subagent-p2-real-'));
const agentDir = join(home, '.pi', 'agent');
const workspace = join(home, 'project');
const runtimeConfig = join(home, 'runtime-settings.json');
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
for (const name of ['models.json', 'auth.json']) {
  if (existsSync(join(realAgentDir, name))) copyFileSync(join(realAgentDir, name), join(agentDir, name));
}
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
writeFileSync(runtimeConfig, '{}');
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

  // 1. 进程内一次性
  {
    const { fresh, result } = await runCase(
      '进程内一次性（action:run，default 档案）',
      { action: 'run', task: TASK },
      "After it returns, reply with exactly the sub-agent's output and nothing else.",
    );
    check(!!result && !result.isError, 'in-process run：父会话收到 spawn_agent 工具结果且不是错误');
    check(textOf(result?.content).trim() === 'OK', 'in-process run：工具结果正文是 OK');
    const sp = result?.details?.sessionPath;
    check(typeof sp === 'string' && existsSync(sp), 'in-process run：details 带子会话 sessionPath 且文件存在（进程内后端才有）');
    check(result?.details?.isolated === false, 'in-process run：没有走 worktree');
    check(result?.details?.stopReason === 'completed', 'in-process run：stopReason = completed');
    const last = [...fresh].reverse().find((m) => m.role === 'assistant');
    check(/\bOK\b/.test(textOf(last?.content)), 'in-process run：父会话最后一条回复里有 OK');
  }

  // 2. 第 2 阶段：同一轮后台派两个，再 wait_agent；结果只经 subagent-settled 通知交回
  {
    log('\n=== 后台 spawn ×2 + wait_agent ===');
    const before = (await messages()).length;
    const at = Date.now();
    const args = JSON.stringify({ action: 'spawn', task: TASK });
    await send('agent_prompt', {
      message:
        `This is an automated smoke test. In one response, call the spawn_agent tool twice, each time with these arguments: ${args}. ` +
        'After both return, call the wait_agent tool once with no arguments. ' +
        'After wait_agent returns, reply with just the word WAITED and do not call any other tool.',
    });
    await waitIdle(240_000);
    await waitFor(
      async () => (await messages()).slice(before).filter((m) => m.customType === 'subagent-settled').length >= 2,
      180_000,
      '两条 subagent-settled 通知',
    );
    await waitIdle(180_000);
    const fresh = (await messages()).slice(before);
    log(`  用时 ${Date.now() - at}ms，新消息 ${fresh.length} 条`);
    for (const m of fresh) log('  ', brief(m));

    const spawns = fresh.filter((m) => m.role === 'toolResult' && m.toolName === 'spawn_agent');
    const spawnedIds = spawns.map((m) => m.details?.agentId).filter(Boolean);
    check(spawns.length === 2 && spawns.every((m) => !m.isError), 'spawn ×2：两条 spawn_agent 结果都不是错误');
    check(spawns.every((m) => m.details?.mode === 'continuable' && typeof m.details?.sessionPath === 'string'), 'spawn ×2：都走进程内可续聊、带 sessionPath');
    check(spawns.every((m) => m.details?.jobId === undefined), 'spawn ×2：结果里没有 jobId（不再走 jobs）');
    check(spawns.every((m) => /wait_agent/.test(textOf(m.content)) && !/job_output|action: "wait"/.test(textOf(m.content))), 'spawn ×2：回执提示 wait_agent，不再提 job_output / action "wait"');

    const waitIdx = fresh.findIndex((m) => m.role === 'toolResult' && m.toolName === 'wait_agent');
    const waited = fresh[waitIdx];
    check(waitIdx >= 0 && !waited?.isError, 'wait_agent：父会话调用了 wait_agent 且不是错误');
    check(waited?.details?.outcome === 'settled', `wait_agent：等到了子代理结算（outcome = ${waited?.details?.outcome}）`);
    const waitedIds = (waited?.details?.settled ?? []).map((s) => s.childId);
    check(waitedIds.length >= 1 && waitedIds.every((id) => spawnedIds.includes(id)), 'wait_agent：报告的 childId 都是这次派出的');
    // 标签取任务首行，里面本来就有 OK；只看是否带了子代理的结束语。
    check(!/Its closing message/.test(textOf(waited?.content)), 'wait_agent：只给摘要，不带子代理正文（没有 closing message）');

    const notices = fresh.filter((m) => m.customType === 'subagent-settled');
    check(notices.length === 2 && notices.every((m) => m.details?.stopReason === 'completed'), '通知：两个子代理各一条 subagent-settled，stopReason = completed');
    check(new Set(notices.map((m) => m.details?.childId)).size === 2 && notices.every((m) => spawnedIds.includes(m.details?.childId)), '通知：childId 与两次 spawn 一一对应');
    check(notices.every((m) => /Its closing message:\s*\n?OK\b/.test(textOf(m.content))), '通知：正文里带子代理的 OK');
    const firstWaitedNotice = fresh.findIndex((m) => m.customType === 'subagent-settled' && waitedIds.includes(m.details?.childId));
    check(firstWaitedNotice > waitIdx, 'wait_agent 报告的子代理，其通知排在 wait_agent 结果之后（steer 投递）');
    check(!fresh.some((m) => m.customType === 'job-done'), '没有 job-done 通知（子代理不再走 jobs）');
  }

  // 3. worker
  {
    const { fresh, result } = await runCase(
      'worker（action:run，executor 档案 = worktree）',
      { action: 'run', profile: 'executor', task: TASK },
      "After it returns, reply with exactly the first line of the sub-agent's output and nothing else.",
    );
    check(!!result && !result.isError, 'worker run：父会话收到 spawn_agent 工具结果且不是错误');
    check(/^OK\b/.test(textOf(result?.content).trim()), 'worker run：工具结果正文以 OK 开头（后面是 worktree diff 段）');
    check(result?.details?.isolated === true, 'worker run：在 worktree 里跑（只有 worker 后端支持）');
    check(result?.details?.sessionPath === undefined, 'worker run：没有子会话 sessionPath（worker 是 --no-session 进程）');
    check(result?.details?.stopReason === 'completed', 'worker run：stopReason = completed');
    const last = [...fresh].reverse().find((m) => m.role === 'assistant');
    check(/\bOK\b/.test(textOf(last?.content)), 'worker run：父会话最后一条回复里有 OK');
  }
} catch (error) {
  failures.push(String(error?.message ?? error));
  log('FAIL ', String(error?.stack ?? error));
} finally {
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
