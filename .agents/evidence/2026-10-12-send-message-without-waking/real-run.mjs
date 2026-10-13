#!/usr/bin/env node
// send_message wake: false 的实跑：真实 agent-host + 真实模型（haiku）。
//   1. 后台派一个可续聊子代理，结算后进驻留池；wake: false 发「记住暗号 BANANA」：回执说没唤醒，
//      等 20 秒没有新的结算通知，子会话 JSONL 里多了一条 agent-message；再默认唤醒问暗号，结算通知带回 BANANA
//   2. 重启 agent-host（子代理已卸载）：wake: false 发「暗号改成 CHERRY」，同样没唤醒、JSONL 多一条；唤醒问暗号 → CHERRY
//   3. worker 后端：子代理结算后 worker 退出（已卸载），wake: false 发「暗号是 DATE」→ JSONL 多一条、没起 worker 跑轮；
//      唤醒问暗号 → 冷恢复回 worker，带回 DATE
//   4. 子代理按新的结尾提示交结果（wake: false）：只记录父会话收到的是什么、为这个子代理跑了几轮，不判定
// 用临时 HOME，只把 ~/.pi/agent 的 models.json / auth.json 拷进去（结束时连同临时目录删除），日志里的密钥值替换成 <redacted>。
//
// 先构建：cd electron-agent && npx electron-vite build --mode localrun --outDir out/send-quiet
// 再跑：  node .agents/evidence/2026-10-12-send-message-without-waking/real-run.mjs [--model provider/id] [--log 路径]
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
const outMain = resolve(appDir, option('out', 'out/send-quiet'), 'main');
const entry = join(outMain, 'agent-host.js');
const workerEntry = join(outMain, 'pi-worker.js');
const [provider, ...modelRest] = option('model', 'custom-muqywnc8/claude-haiku-5-5').split('/');
const modelId = modelRest.join('/');
const logPath = option('log', join(here, 'real-run.txt'));
const electronPath = createRequire(join(appDir, 'package.json'))('electron');
if (!existsSync(entry)) {
  console.error(`找不到 ${entry}，先构建`);
  process.exit(2);
}

const realAgentDir = join(homedir(), '.pi', 'agent');
const home = mkdtempSync(join(tmpdir(), 'send-quiet-real-'));
const agentDir = join(home, '.pi', 'agent');
const workspace = join(home, 'project');
const runtimeConfig = join(home, 'runtime-settings.json');
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
for (const name of ['models.json', 'auth.json']) {
  if (existsSync(join(realAgentDir, name))) copyFileSync(join(realAgentDir, name), join(agentDir, name));
}
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
const settings = (values) => writeFileSync(runtimeConfig, JSON.stringify(values));
settings({});
writeFileSync(join(workspace, 'README.md'), '# send_message wake:false real run\n');
const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
git('init', '-q');
git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'add', '.');
git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-q', '-m', 'init');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AgentData 通道桩：工具授权一律放行（这里只验证投递）。
const dataToken = randomBytes(16).toString('hex');
secrets.add(dataToken);
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

function launchHost() {
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
  const host = { child, stderr: '', diag: [] };
  child.stdout.on('data', (c) => { host.stderr += c; });
  child.stderr.on('data', (c) => { host.stderr += c; });
  let nextId = 1;
  const pending = new Map();
  let readyResolve;
  host.ready = new Promise((r) => { readyResolve = r; });
  host.exited = new Promise((r) => child.on('exit', (code, signal) => {
    for (const w of pending.values()) w.reject(new Error(`agent-host exited (${code}/${signal})`));
    pending.clear();
    r({ code, signal });
  }));
  child.on('message', async (m) => {
    if (m?.t === 'res') {
      const w = pending.get(m.id);
      if (!w) return;
      pending.delete(m.id);
      if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error?.message ?? 'request failed'));
    } else if (m?.t === 'evt') {
      if (m.channel === 'host.ready') readyResolve();
      else if (m.channel === 'host.diag') host.diag.push(m.payload);
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
  host.request = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { resolve: res, reject: rej });
    child.send({ t: 'req', id, method, params }, (e) => { if (e) { pending.delete(id); rej(e); } });
  });
  host.send = (command, args = {}) => host.request('pi.send', { workspace, command, args });
  host.shutdown = async () => {
    const reply = host.request('host.shutdown').catch(() => null);
    await Promise.race([host.exited, sleep(15_000)]);
    await reply;
    if (child.exitCode === null) child.kill();
  };
  return host;
}

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '';
const brief = (m) => ({
  role: m.role,
  ...(m.toolName ? { toolName: m.toolName } : {}),
  ...(m.customType ? { customType: m.customType } : {}),
  ...(m.isError ? { isError: true } : {}),
  text: textOf(m.content).slice(0, 240),
  ...(m.details && m.toolName === 'send_message' ? { details: m.details } : {}),
  ...(m.role === 'assistant' ? { toolCalls: (m.content ?? []).filter((b) => b?.type === 'toolCall').map((b) => ({ name: b.name })) } : {}),
});

let host = launchHost();
const messages = async () => (await host.send('agent_get_messages'))?.messages ?? [];
async function waitIdle(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let idleSince = 0;
  while (Date.now() < deadline) {
    const state = await host.send('agent_get_state');
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
const ask = async (label, message) => {
  log(`\n=== ${label} ===`);
  const before = (await messages()).length;
  await host.send('agent_prompt', { message });
  await waitIdle(300_000);
  const fresh = (await messages()).slice(before);
  for (const m of fresh) log('  ', brief(m));
  return { fresh, before };
};
const toolResult = (fresh, name) => fresh.find((m) => m.role === 'toolResult' && m.toolName === name);
const settledFor = (list, childId) => list.filter((m) => m.customType === 'subagent-settled' && m.details?.childId === childId);
/** 子会话 JSONL 里的条目。 */
function childEntries(file) {
  if (typeof file !== 'string' || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const quietEntries = (file) => childEntries(file).filter((e) => e.type === 'custom_message' && e.customType === 'agent-message');
const assistantCount = (file) => childEntries(file).filter((e) => e.type === 'message' && e.message?.role === 'assistant').length;
function listWorkers() {
  return new Promise((done) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -notlike 'powershell*' -and $_.CommandLine -like '*send-quiet*pi-worker.js*--mode subagent*' } | ForEach-Object { $_.ProcessId }"], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (c) => { out += c; });
    ps.on('exit', () => done(out.split(/\s+/).filter(Boolean)));
  });
}

/** 后台派一个可续聊子代理，等它结算。返回 childId 和子会话路径。 */
async function spawnReady(label) {
  const { before } = await ask(
    label,
    `Call the spawn_agent tool exactly once with these arguments: ${JSON.stringify({ action: 'spawn', task: 'Reply with exactly the word READY and nothing else. Do not use any tools.' })}. After it returns, reply with just the word STARTED and do not call any other tool.`,
  );
  const spawned = toolResult((await messages()).slice(before), 'spawn_agent');
  const childId = spawned?.details?.agentId;
  const notice = await waitFor(async () => settledFor((await messages()).slice(before), childId)[0], 180_000, '结算通知');
  await waitIdle(180_000);
  return { childId, file: notice?.details?.sessionPath };
}

/** wake: false 发一条，检查回执、20 秒内不结算、JSONL 多一条。 */
async function quietSend(tag, childId, file, text, extra = async () => {}) {
  const quietBefore = quietEntries(file).length;
  const assistantsBefore = assistantCount(file);
  const { fresh, before } = await ask(
    `${tag}：wake: false`,
    `Call the send_message tool exactly once with ${JSON.stringify({ agent_id: childId, message: text, wake: false })}. Then reply with just the word SENT and do not call any other tool.`,
  );
  const r = toolResult(fresh, 'send_message');
  check(!!r && !r.isError && r.details?.woken === false && r.details?.delivery === 'appended', `${tag}：回执说没唤醒、只追加（${JSON.stringify(r?.details)}）`);
  await extra();
  await sleep(20_000);
  check(settledFor((await messages()).slice(before), childId).length === 0, `${tag}：20 秒内没有新的结算通知（子代理没被唤醒）`);
  const quiet = quietEntries(file);
  check(quiet.length === quietBefore + 1 && quiet.at(-1).content.includes(text), `${tag}：子会话 JSONL 多了一条 agent-message`);
  check(assistantCount(file) === assistantsBefore, `${tag}：子会话没有新的助手回复`);
}

/** 默认唤醒问暗号，等结算通知带回答案。 */
async function wakeAndAsk(tag, childId, expected) {
  const { before } = await ask(
    `${tag}：唤醒问暗号`,
    `Call the send_message tool exactly once with ${JSON.stringify({ agent_id: childId, message: 'What is the current code word? Reply with only the code word. Do not use any tools.' })}. Then reply with just the word SENT.`,
  );
  const notice = await waitFor(async () => settledFor((await messages()).slice(before), childId)[0], 180_000, '唤醒后的结算通知');
  await waitIdle(180_000);
  log('   结算通知：', textOf(notice?.content).slice(0, 200));
  check(new RegExp(expected).test(textOf(notice?.content)), `${tag}：唤醒后带回 ${expected}`);
}

try {
  await host.ready;
  log(`agent-host 就绪；模型 ${provider}/${modelId}`);
  await host.request('pi.openWorkspace', { workspace });
  await host.send('agent_set_model', { provider, modelId });

  // 1. 驻留池里的子代理
  const inproc = await spawnReady('进程内：后台派一个可续聊子代理');
  const mark = host.diag.length;
  await waitFor(async () => host.diag.length > mark, 15_000, '结算后的诊断采样');
  check((host.diag.at(-1)?.subagents?.resident ?? 0) >= 1, '进程内：结算后在驻留池里（诊断采样 resident ≥ 1）');
  await quietSend('驻留', inproc.childId, inproc.file, 'Remember the code word BANANA. Do not reply to this message.');
  await wakeAndAsk('驻留', inproc.childId, 'BANANA');

  // 2. 重启 agent-host：子代理已卸载
  {
    const parentFile = (await host.send('agent_get_state'))?.sessionFile;
    log('\n=== 重启 agent-host ===');
    await host.shutdown();
    host = launchHost();
    await host.ready;
    await host.request('pi.openWorkspace', { workspace });
    await host.send('agent_switch_session', { sessionPath: parentFile });
    await host.send('agent_set_model', { provider, modelId });
    check((await host.send('agent_get_state'))?.sessionFile === parentFile, '重启后切回了原父会话');
  }
  await quietSend('已卸载（进程内）', inproc.childId, inproc.file, 'The code word is now CHERRY. Do not reply to this message.', async () => {
    const diagMark = host.diag.length;
    await waitFor(async () => host.diag.length > diagMark, 15_000, '投递后的诊断采样');
    const s = host.diag.at(-1)?.subagents;
    check((s?.active ?? 0) === 0 && (s?.resident ?? 0) === 0, `已卸载（进程内）：没有加载子会话（诊断采样 active=${s?.active} resident=${s?.resident}）`);
  });
  await wakeAndAsk('已卸载（进程内）', inproc.childId, 'CHERRY');

  // 3. worker 后端：结算后 worker 退出
  settings({ SUBAGENT_BACKEND: 'worker' });
  await sleep(500);
  const worker = await spawnReady('worker：后台派一个可续聊子代理');
  const meta = childEntries(worker.file).filter((e) => e.type === 'custom' && e.customType === 'subagent_meta').at(-1)?.data;
  check(meta?.backend === 'worker', 'worker：子会话 meta 是 backend: worker');
  await waitFor(async () => (await listWorkers()).length === 0, 20_000, 'worker 结算后退出');
  await quietSend('已卸载（worker）', worker.childId, worker.file, 'The code word is DATE. Do not reply to this message.', async () => {
    check((await listWorkers()).length === 0, '已卸载（worker）：投递没有起 worker 进程');
  });
  await wakeAndAsk('已卸载（worker）', worker.childId, 'DATE');
  settings({});
  await sleep(500);

  // 4. 子代理按结尾提示交最终结果（wake: false）：只记录
  {
    const { before } = await ask(
      '子代理交最终结果（只记录）',
      `Call the spawn_agent tool exactly once with these arguments: ${JSON.stringify({ action: 'spawn', task: 'What is 17 + 25? Follow your instructions about returning your result to the parent.' })}. After it returns, reply with just the word STARTED and do not call any other tool.`,
    );
    const spawned = toolResult((await messages()).slice(before), 'spawn_agent');
    const childId = spawned?.details?.agentId;
    await waitFor(async () => settledFor((await messages()).slice(before), childId)[0], 180_000, '结算通知');
    await waitIdle(180_000);
    await sleep(3000);
    const after = (await messages()).slice(before);
    for (const m of after) log('  ', brief(m));
    const quiet = after.filter((m) => m.customType === 'agent-message');
    const settledAt = after.findIndex((m) => m.customType === 'subagent-settled' && m.details?.childId === childId);
    const turnsAfterStart = after.slice(after.findIndex((m) => m.role === 'toolResult' && m.toolName === 'spawn_agent') + 1)
      .filter((m) => m.role === 'assistant').length;
    log(`   记录：父会话收到 ${quiet.length} 条 agent-message（未唤醒），结算通知在第 ${settledAt} 条；spawn 之后父会话的助手回复 ${turnsAfterStart} 条（STARTED + 处理结算 = 2 表示只为结果跑了一轮）`);
  }
} catch (error) {
  failures.push(String(error?.message ?? error));
  log('FAIL ', String(error?.stack ?? error));
} finally {
  await host.shutdown().catch(() => {});
  dataServer.close();
  const tail = host.stderr.split(/\r?\n/).filter((l) => /error|fail/i.test(l) && !/ExperimentalWarning/.test(l)).slice(-30);
  if (tail.length) { log('\nagent-host 输出里与错误相关的行（最多 30 行）：'); for (const l of tail) log('  ', l); }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 上偶尔还被占用 */ }
  log(`\n临时目录已删除：${!existsSync(home)}`);
  log(failures.length ? `${failures.length} 项失败` : '全部通过');
  writeFileSync(logPath, lines.join('\n') + '\n');
}
process.exit(failures.length ? 1 : 0);
