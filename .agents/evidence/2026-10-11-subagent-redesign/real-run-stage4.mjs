#!/usr/bin/env node
// 子代理重新设计第 4 阶段的实跑：真实 agent-host + 真实模型。
//   1. 8 个进程内子代理并发（spawn_agent tasks × 8），agent-host 每 10 秒的诊断采样里事件循环 p99 ≤ 200 ms，
//      采样带上在跑的子代理（runtime-diag.jsonl 的 agent-host-sample 就是这份数据）
//   2. 后台 spawn 一个可续聊子代理；结算后它留在驻留池（诊断采样 resident ≥ 1），send_message 续聊拿到第二条通知
//   3. 重启 agent-host（同一个临时 HOME），切回原会话：list_agents 从父会话的子代理目录列出这些子代理，
//      send_message 冷恢复那个可续聊子代理，拿到结算通知
// 用临时 HOME，只把 ~/.pi/agent 的 models.json / auth.json 拷进去（结束时连同临时目录删除），日志里的密钥值替换成 <redacted>。
//
// 先构建：cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-p4
// 再跑：  node .agents/evidence/2026-10-11-subagent-redesign/real-run-stage4.mjs [--model provider/id] [--log 路径]
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
const outMain = resolve(appDir, option('out', 'out/subagent-p4'), 'main');
const entry = join(outMain, 'agent-host.js');
const workerEntry = join(outMain, 'pi-worker.js');
const [provider, ...modelRest] = option('model', 'custom-muqywnc8/claude-haiku-5-5').split('/');
const modelId = modelRest.join('/');
const logPath = option('log', join(here, 'real-run-stage4.txt'));
const electronPath = createRequire(join(appDir, 'package.json'))('electron');
if (!existsSync(entry)) {
  console.error(`找不到 ${entry}，先构建`);
  process.exit(2);
}

const realAgentDir = join(homedir(), '.pi', 'agent');
const home = mkdtempSync(join(tmpdir(), 'subagent-p4-real-'));
const agentDir = join(home, '.pi', 'agent');
const workspace = join(home, 'project');
const runtimeConfig = join(home, 'runtime-settings.json');
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
for (const name of ['models.json', 'auth.json']) {
  if (existsSync(join(realAgentDir, name))) copyFileSync(join(realAgentDir, name), join(agentDir, name));
}
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
// 8 个并发要越过默认的单会话名额（6），这里放开。
writeFileSync(runtimeConfig, JSON.stringify({ SUBAGENT_MAX_PER_SESSION: '0' }));
writeFileSync(join(workspace, 'README.md'), '# subagent phase 4 real run\n');
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

// AgentData 通道桩：工具授权一律放行（只验证子代理，不验证授权）。
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

/** 起一个 agent-host，扮演主进程那一侧；diag 收 agent-host 每 10 秒的采样。 */
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
      else if (m.channel === 'host.diag') host.diag.push({ at: Date.now(), ...m.payload });
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
  text: textOf(m.content).slice(0, 300),
  ...(m.role === 'assistant' ? { toolCalls: (m.content ?? []).filter((b) => b?.type === 'toolCall').map((b) => ({ name: b.name })) } : {}),
});
// 输出要够长，8 个子代理才会有一段时间同时在跑（诊断采样每 10 秒一次）。
const TASK = 'Write the numbers from 1 to 400 in English words, one per line, then on a final line write exactly OK. Do not use any tools.';

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
  const at = Date.now();
  await host.send('agent_prompt', { message });
  await waitIdle(300_000);
  const fresh = (await messages()).slice(before);
  log(`  用时 ${Date.now() - at}ms，新消息 ${fresh.length} 条`);
  for (const m of fresh) log('  ', brief(m));
  return { fresh, before };
};
const toolResult = (fresh, name) => fresh.find((m) => m.role === 'toolResult' && m.toolName === name);

try {
  await host.ready;
  log(`agent-host 就绪；模型 ${provider}/${modelId}`);
  await host.request('pi.openWorkspace', { workspace });
  await host.send('agent_set_model', { provider, modelId });

  // 1. 8 个进程内子代理并发，看诊断采样
  let spawnedIds = [];
  {
    const diagBefore = host.diag.length;
    const { fresh } = await ask(
      '8 个进程内子代理并发',
      `This is an automated smoke test. Call the spawn_agent tool exactly once with these arguments: ${JSON.stringify({ action: 'run', tasks: Array.from({ length: 8 }, () => TASK) })}. After it returns, reply with just the word DONE.`,
    );
    // 等最后一个 10 秒窗口的采样落下
    await sleep(11_000);
    const r = toolResult(fresh, 'spawn_agent');
    const results = r?.details?.results ?? [];
    spawnedIds = results.map((x) => x.agentId).filter(Boolean);
    check(!!r && !r.isError && results.length === 8, `并发：spawn_agent tasks × 8 返回 8 个结果（${results.length}）`);
    check(results.every((x) => x.ok), '并发：8 个子代理都完成');
    const samples = host.diag.slice(diagBefore);
    for (const s of samples) log('   诊断采样：', { lag: s.lag, subagents: s.subagents });
    const busy = samples.filter((s) => (s.subagents?.inProcess ?? 0) >= 8);
    check(busy.length >= 1, `诊断采样里有 8 个进程内子代理同时在跑的窗口（${busy.length} 个）`);
    check(busy.every((s) => Array.isArray(s.subagents?.ids) && s.subagents.ids.length >= 8), '诊断采样记下了在跑的子代理 id');
    const worst = Math.max(0, ...busy.map((s) => s.lag?.p99Ms ?? Infinity));
    check(busy.length >= 1 && worst <= 200, `8 个并发时 agent-host 事件循环 p99 ≤ 200 ms（最坏 ${worst} ms）`);
  }

  // 2. 后台可续聊子代理：结算后驻留，send_message 续聊
  let childId;
  {
    const { before } = await ask(
      '后台 spawn（可续聊）',
      `Call the spawn_agent tool exactly once with these arguments: ${JSON.stringify({ action: 'spawn', task: 'Reply with exactly the word OK and nothing else. Do not use any tools.' })}. After it returns, reply with just the word STARTED and do not call any other tool.`,
    );
    const spawned = toolResult((await messages()).slice(before), 'spawn_agent');
    childId = spawned?.details?.agentId;
    await waitFor(async () => (await messages()).slice(before).find((m) => m.customType === 'subagent-settled' && m.details?.childId === childId), 180_000, '结算通知');
    await waitIdle(180_000);
    const diagMark = host.diag.length;
    await waitFor(async () => host.diag.length > diagMark, 15_000, '结算后的诊断采样');
    const sample = host.diag.at(-1);
    log('   结算后的诊断采样：', { subagents: sample?.subagents });
    check((sample?.subagents?.resident ?? 0) >= 1, '结算后子会话留在驻留池（采样 resident ≥ 1）');
    const follow = await ask(
      'send_message 续聊（驻留会话）',
      `Call the send_message tool exactly once with ${JSON.stringify({ agent_id: childId, message: 'Now reply with exactly the word AGAIN and nothing else. Do not use any tools.' })}. Then reply with just the word SENT.`,
    );
    const second = await waitFor(
      async () => (await messages()).slice(follow.before).find((m) => m.customType === 'subagent-settled' && m.details?.childId === childId),
      180_000,
      '续聊结算通知',
    );
    await waitIdle(180_000);
    check(/AGAIN/.test(textOf(second?.content)), '续聊：第二条结算通知带回 AGAIN');
  }

  // 3. 重启 agent-host：list_agents 从目录列出，send_message 冷恢复
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
    const listed = await ask('重启后 list_agents', 'Call the list_agents tool exactly once with no arguments. Then reply with just the word LISTED.');
    const r = toolResult(listed.fresh, 'list_agents');
    const agents = r?.details?.agents ?? [];
    log('   list_agents：', agents.map((a) => `${a.childId}:${a.status}:${a.mode}`));
    check(!!r && !r.isError, 'list_agents：工具结果不是错误');
    check(agents.some((a) => a.childId === childId && a.mode === 'continuable' && a.status === 'inactive'), 'list_agents：重启后从目录列出那个可续聊子代理（inactive）');
    check(spawnedIds.length === 8 && spawnedIds.every((id) => agents.some((a) => a.childId === id && a.mode === 'one-shot')), 'list_agents：8 个一次性子代理也在目录里');
    const resumed = await ask(
      '重启后 send_message 冷恢复',
      `Call the send_message tool exactly once with ${JSON.stringify({ agent_id: childId, message: 'Reply with exactly the word RESUMED and nothing else. Do not use any tools.' })}. Then reply with just the word SENT.`,
    );
    const sent = toolResult(resumed.fresh, 'send_message');
    check(!!sent && !sent.isError, 'send_message：重启后送达（按 JSONL 冷恢复）');
    const notice = await waitFor(
      async () => (await messages()).slice(resumed.before).find((m) => m.customType === 'subagent-settled' && m.details?.childId === childId),
      180_000,
      '冷恢复后的结算通知',
    );
    await waitIdle(180_000);
    check(/RESUMED/.test(textOf(notice?.content)), '冷恢复：结算通知带回 RESUMED');
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
