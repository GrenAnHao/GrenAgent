#!/usr/bin/env node
// 子代理重新设计第 2.5 阶段的实跑：真实 agent-host + 真实模型。
//   1. create_worktree 建分支和 checkout，父会话切过去；之后 write 的相对路径落在 worktree
//   2. 子代理继承父会话当前目录；子会话头仍在原工作区
//   3. 新会话按原工作区起；切回旧会话时目录按 working_directory 记录恢复
//   4. working_directory cd 回原工作区，checkout 和分支保留
// 用临时 HOME，只把 ~/.pi/agent 的 models.json / auth.json 拷进去（结束时连同临时目录删除），
// 不碰真实 ~/.pi 和应用数据目录。日志里出现的密钥值会被替换成 <redacted>。
//
// 先构建：cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-p25
// 再跑：  node .agents/evidence/2026-10-11-subagent-redesign/real-run-stage25.mjs [--model provider/id] [--log 路径]
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const outMain = resolve(appDir, option('out', 'out/subagent-p25'), 'main');
const entry = join(outMain, 'agent-host.js');
const workerEntry = join(outMain, 'pi-worker.js');
const [provider, ...modelRest] = option('model', 'custom-muqywnc8/claude-haiku-5-5').split('/');
const modelId = modelRest.join('/');
const logPath = option('log', join(here, 'real-run-stage25.txt'));
const electronPath = createRequire(join(appDir, 'package.json'))('electron');

if (!existsSync(entry) || !existsSync(workerEntry)) {
  console.error(`找不到 ${entry} 或 pi-worker.js，先构建`);
  process.exit(2);
}

const realAgentDir = join(homedir(), '.pi', 'agent');
const home = mkdtempSync(join(tmpdir(), 'subagent-p25-real-'));
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

  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
  const wsReal = realpathSync.native(workspace);
  const wt = join(wsReal, '.agents', 'worktrees', 'p25-feature');
  const ask = async (label, message) => {
    log(`\n=== ${label} ===`);
    const before = (await messages()).length;
    const at = Date.now();
    await send('agent_prompt', { message });
    await waitIdle(240_000);
    const fresh = (await messages()).slice(before);
    log(`  用时 ${Date.now() - at}ms，新消息 ${fresh.length} 条`);
    for (const m of fresh) log('  ', brief(m));
    return fresh;
  };
  const toolResult = (fresh, name) => fresh.find((m) => m.role === 'toolResult' && m.toolName === name);
  const headerCwd = (file) => JSON.parse(readFileSync(file, 'utf8').split(/\r?\n/)[0]).cwd;

  // 1. create_worktree：建分支和 checkout，父会话切过去，之后的写文件落在 worktree 里
  const parentFile = (await send('agent_get_state'))?.sessionFile;
  {
    const fresh = await ask(
      'create_worktree + write',
      'This is an automated smoke test. Step 1: call the create_worktree tool with {"name":"p25-feature"}. ' +
        'Step 2: call the write tool to create the file note.txt (use exactly this relative path) with the content from-worktree. ' +
        'Step 3: reply with the word CREATED. Do not call any other tool.',
    );
    const created = toolResult(fresh, 'create_worktree');
    check(!!created && !created.isError, 'create_worktree：工具结果不是错误');
    check(same(created?.details?.path, wt) && created?.details?.branch === 'p25-feature', 'create_worktree：checkout 在 <工作区>/.agents/worktrees/p25-feature，分支 p25-feature');
    check(existsSync(join(wt, 'note.txt')) && !existsSync(join(wsReal, 'note.txt')), '切换后 write 的相对路径落在 worktree，不在原工作区');
    check(readFileSync(join(wsReal, '.agents', 'worktrees', '.gitignore'), 'utf8') === '*\n', 'worktrees 目录带自忽略的 .gitignore（*）');
    check(execFileSync('git', ['branch', '--list', 'p25-feature'], { cwd: wsReal, encoding: 'utf8' }).includes('p25-feature'), '原仓库里有 p25-feature 分支');
    const entries = readFileSync(parentFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    check(entries.some((e) => e.customType === 'working_directory' && same(e.data?.cwd, wt)), '父会话 JSONL 记下了 working_directory 切换');
    check(same(headerCwd(parentFile), wsReal), '父会话头的 cwd 仍是原工作区');
  }

  // 2. 子代理继承父会话的当前目录；子会话头仍在原工作区
  {
    const fresh = await ask(
      '子代理继承当前目录',
      'Call spawn_agent once with {"action":"run","task":"Use the write tool to create the file child.txt (use exactly this relative path) containing the word child, then reply DONE."}. ' +
        'After it returns, reply with the word SPAWNED.',
    );
    const spawned = toolResult(fresh, 'spawn_agent');
    check(!!spawned && !spawned.isError, 'spawn_agent：工具结果不是错误');
    check(existsSync(join(wt, 'child.txt')) && !existsSync(join(wsReal, 'child.txt')), '子代理的相对路径写在父会话当前的 worktree 里');
    const childFile = spawned?.details?.sessionPath;
    check(typeof childFile === 'string' && same(headerCwd(childFile), wsReal), '子会话头的 cwd 是原工作区（会话归属不跟着 worktree 走）');
    check(typeof childFile === 'string' && same(dirname(childFile), dirname(parentFile)), '子会话文件和父会话在同一个会话目录');
  }

  // 3. 新建会话按原工作区起；切回旧会话时目录按记录恢复
  {
    log('\n=== 新会话与切回 ===');
    await send('agent_new_session');
    const fresh = (await send('agent_get_state'))?.sessionFile;
    check(typeof fresh === 'string' && fresh !== parentFile, '新建了一个会话');
    if (typeof fresh === 'string' && existsSync(fresh)) check(same(headerCwd(fresh), wsReal), '新会话头的 cwd 是原工作区（不是 worktree）');
    else log('  新会话还没落盘，跳过头部检查');
    await send('agent_switch_session', { sessionPath: parentFile });
    check((await send('agent_get_state'))?.sessionFile === parentFile, '切回了原会话');
    const asked = await ask(
      '切回后的目录',
      'Call the working_directory tool with no arguments, then reply with exactly the path it returned and nothing else.',
    );
    const read = toolResult(asked, 'working_directory');
    check(same(textOf(read?.content).trim(), wt), '切回原会话后工作目录按记录恢复为 worktree');
  }

  // 4. 离开 worktree：checkout 和分支都保留
  {
    const fresh = await ask(
      '离开 worktree',
      `Call the working_directory tool with ${JSON.stringify({ cd: wsReal })}. Then reply with the word LEFT and do not call any other tool.`,
    );
    const left = toolResult(fresh, 'working_directory');
    check(!!left && !left.isError && left.details?.changed === true && same(left.details?.cwd, wsReal), 'working_directory cd 回原工作区');
    check(existsSync(join(wt, 'note.txt')), '离开后 worktree checkout 仍在');
    check(execFileSync('git', ['branch', '--list', 'p25-feature'], { cwd: wsReal, encoding: 'utf8' }).includes('p25-feature'), '离开后分支仍在');
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
