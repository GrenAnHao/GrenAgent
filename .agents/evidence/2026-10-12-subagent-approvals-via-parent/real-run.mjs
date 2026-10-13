#!/usr/bin/env node
// 子代理审批转给父会话窗口的实跑：真实 agent-host + 真实模型（haiku）。
// 脚本扮演主进程：收 agent-host 推出来的 pi://ui-request 信封（就是渲染层的审批卡），用 pi.respondUi 答复。
// AgentData 通道桩扮演主进程的授权服务：目标文件名带 approval- 的 write 判成 ask，其余放行；判定照
// toolDecisionService：子代理没带 approvalRoute 时固定拒绝（builtin.subagent-ask-pinned）。
//   1. 进程内子代理请求批准：信封落在父会话上，标题写出子代理，带 timeout / subagents；答「允许本次」后文件写出来，
//      审计回填 user_allow，卡片随后收到 dismiss
//   2. 没人答：SUBAGENT_APPROVAL_TIMEOUT_MS（这里调成 8 秒）到点，宿主发 dismiss，审计回填 timeout，子代理收到「视为被拒」
//   3. worker 后端：同一条路经 worker → 宿主的 RPC，答「允许本次」后文件写出来
//   4. 设置为 0：不转发，没有信封，主进程固定拒绝，子代理收到委派范围的拒绝
// 用 write 而不是 bash：临时 HOME 里没有 Windows 沙箱 helper，bash 批准后也起不来；write 在进程内执行、不经 OS 沙箱。
// 用临时 HOME，只把 ~/.pi/agent 的 models.json / auth.json 拷进去（结束时连同临时目录删除），日志里的密钥值替换成 <redacted>。
//
// 先构建：cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-approval
// 再跑：  node .agents/evidence/2026-10-12-subagent-approvals-via-parent/real-run.mjs [--model provider/id] [--log 路径]
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
const outMain = resolve(appDir, option('out', 'out/subagent-approval'), 'main');
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

const TIMEOUT_MS = 8000;
const realAgentDir = join(homedir(), '.pi', 'agent');
const home = mkdtempSync(join(tmpdir(), 'subagent-approval-real-'));
const agentDir = join(home, '.pi', 'agent');
const workspace = join(home, 'project');
const runtimeConfig = join(home, 'runtime-settings.json');
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
for (const name of ['models.json', 'auth.json']) {
  if (existsSync(join(realAgentDir, name))) copyFileSync(join(realAgentDir, name), join(agentDir, name));
}
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
const settings = (extra) => writeFileSync(runtimeConfig, JSON.stringify({ SUBAGENT_APPROVAL_TIMEOUT_MS: String(TIMEOUT_MS), ...extra }));
settings({});
writeFileSync(join(workspace, 'README.md'), '# subagent approval real run\n');
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

// AgentData 通道桩：授权服务。判定照 toolDecisionService 的子代理分支，记下每次判定和回填。
const evaluations = [];
const settlements = [];
let auditSeq = 0;
const targetOf = (call) => String(call.command ?? call.path ?? '');
const decide = (call) => {
  const marked = /approval-/i.test(targetOf(call));
  if (!marked) return { decision: 'allow', auditId: `a${++auditSeq}` };
  if (call.origin === 'subagent' && call.approvalRoute !== true) {
    return { decision: 'deny', auditId: `a${++auditSeq}`, ruleId: 'builtin.subagent-ask-pinned' };
  }
  return { decision: 'ask', auditId: `a${++auditSeq}`, ruleId: 'builtin.dangerous-command' };
};
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
      else if (req.method === 'permission.tool.evaluate') {
        const call = req.params?.call ?? {};
        const verdict = decide(call);
        evaluations.push({ origin: call.origin, tool: call.tool, target: targetOf(call), approvalRoute: call.approvalRoute, ...verdict });
        reply({ ok: true, result: verdict });
      } else if (req.method === 'permission.tool.settle') {
        settlements.push({ auditId: req.params?.auditId, resolution: req.params?.resolution });
        reply({ ok: true, result: { updated: true } });
      } else if (req.method === 'permission.authorize') reply({ ok: true, result: { status: 'allowed', decision: 'allow' } });
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

/** pi://ui-request 信封：渲染层收到的就是这些。onRequest 由各用例设置，决定答不答。 */
const envelopes = [];
let onRequest = () => {};

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
  const host = { child, stderr: '' };
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
      else if (m.channel === 'host.fatal') log('host.fatal', m.payload);
      else if (m.channel === 'broadcast' && m.payload?.channel === 'pi://ui-request') {
        const envelope = { at: Date.now(), ...m.payload.payload };
        const method = envelope.request?.method;
        if (method === 'select' || method === 'dismiss' || method === 'confirm' || method === 'input') {
          envelopes.push(envelope);
          onRequest(envelope);
        }
      }
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
  host.respond = (response) => host.request('pi.respondUi', { workspace, response });
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
  ...(m.isError ? { isError: true } : {}),
  text: textOf(m.content).slice(0, 300),
  ...(m.role === 'assistant' ? { toolCalls: (m.content ?? []).filter((b) => b?.type === 'toolCall').map((b) => ({ name: b.name })) } : {}),
});
const briefEnvelope = (e) => ({
  sessionPath: e.sessionPath ? e.sessionPath.replace(home, '<home>') : undefined,
  method: e.request.method,
  ...(e.request.title ? { title: e.request.title } : {}),
  ...(e.request.options ? { options: e.request.options } : {}),
  ...(e.request.timeout ? { timeout: e.request.timeout } : {}),
  ...(e.request.subagents ? { subagents: e.request.subagents } : {}),
});

const host = launchHost();
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
const ask = async (label, message) => {
  log(`\n=== ${label} ===`);
  const before = (await messages()).length;
  const at = Date.now();
  await host.send('agent_prompt', { message });
  await waitIdle(300_000);
  const fresh = (await messages()).slice(before);
  log(`  用时 ${Date.now() - at}ms，新消息 ${fresh.length} 条`);
  for (const m of fresh) log('  ', brief(m));
  return fresh;
};
const toolResult = (fresh, name) => fresh.find((m) => m.role === 'toolResult' && m.toolName === name);
/** 子会话 JSONL 里 write 的工具结果（子代理拿到的是什么）。 */
function childWriteResults(file) {
  if (typeof file !== 'string' || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'message' && e.message?.role === 'toolResult' && e.message.toolName === 'write')
    .map((e) => ({ text: textOf(e.message.content), isError: e.message.isError === true }));
}
function childMeta(file) {
  if (typeof file !== 'string' || !existsSync(file)) return undefined;
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'custom' && e.customType === 'subagent_meta').at(-1)?.data;
}
const fileOf = (n) => `approval-${n}.txt`;
const written = (n) => existsSync(join(workspace, fileOf(n))) && readFileSync(join(workspace, fileOf(n)), 'utf8').includes(`APPROVAL-${n.toUpperCase()}`);
const runChild = (n) =>
  `This is an automated test. Call the spawn_agent tool exactly once with ${JSON.stringify({
    action: 'run',
    task: `Use the write tool exactly once to create the file ${fileOf(n)} containing exactly APPROVAL-${n.toUpperCase()}. Then reply with only the word WRITTEN, or with the word BLOCKED if the write was not allowed. Do not retry.`,
  })}. After it returns, reply with just the word DONE.`;

try {
  await host.ready;
  log(`agent-host 就绪；模型 ${provider}/${modelId}；SUBAGENT_APPROVAL_TIMEOUT_MS=${TIMEOUT_MS}`);
  await host.request('pi.openWorkspace', { workspace });
  await host.send('agent_set_model', { provider, modelId });
  const parentFile = (await host.send('agent_get_state'))?.sessionFile;

  // 1. 进程内：答「允许本次」
  {
    const mark = envelopes.length;
    onRequest = (e) => {
      if (e.request.method === 'select' && e.request.subagents) {
        void host.respond({ id: e.request.id, value: '允许本次' }).catch(() => {});
      }
    };
    const fresh = await ask('进程内子代理请求批准，答「允许本次」', runChild('one'));
    const r = toolResult(fresh, 'spawn_agent');
    const seen = envelopes.slice(mark);
    for (const e of seen) log('   信封：', briefEnvelope(e));
    const card = seen.find((e) => e.request.method === 'select');
    const childId = card?.request.subagents?.at(-1)?.agentId;
    check(!!card, '进程内：父会话收到一张审批卡');
    check(card?.sessionPath === parentFile, '进程内：卡片落在父会话上（信封 sessionPath 是父会话）');
    check(typeof childId === 'string' && childId.startsWith('sa-') && card.request.title.includes(`（${childId}）`), `进程内：标题写出是哪个子代理（${childId}）`);
    check((card?.request.title ?? '').includes('approval-one.txt'), '进程内：标题带上要写的文件');
    check(card?.request.timeout === TIMEOUT_MS, `进程内：信封带 timeout=${TIMEOUT_MS}，渲染层据此倒计时`);
    check(JSON.stringify(card?.request.options) === JSON.stringify(['允许本次', '总是允许', '拒绝']), '进程内：选项和主会话一样');
    check(seen.some((e) => e.request.method === 'dismiss' && e.request.id === card?.request.id), '进程内：答复后宿主发 dismiss 收回这张卡');
    const evaluated = evaluations.find((v) => v.target.includes('approval-one'));
    check(evaluated?.origin === 'subagent' && evaluated?.approvalRoute === true && evaluated?.decision === 'ask', '进程内：授权判定收到 origin=subagent、approvalRoute=true，判成 ask');
    check(settlements.some((s) => s.auditId === evaluated?.auditId && s.resolution === 'user_allow'), '进程内：审计回填 user_allow');
    const childFile = r?.details?.sessionPath;
    log('   子代理的 write 结果：', childWriteResults(childFile));
    check(written('one'), '进程内：批准后文件真的写出来了');
    check(/WRITTEN/.test(textOf(r?.content)), '进程内：子代理的回复交回父会话');
  }

  // 2. 进程内：没人答，到点视为被拒
  {
    const mark = envelopes.length;
    onRequest = () => {};
    const fresh = await ask('进程内子代理请求批准，没人答', runChild('two'));
    const r = toolResult(fresh, 'spawn_agent');
    const seen = envelopes.slice(mark);
    for (const e of seen) log('   信封：', briefEnvelope(e));
    const card = seen.find((e) => e.request.method === 'select');
    const dismiss = seen.find((e) => e.request.method === 'dismiss' && e.request.id === card?.request.id);
    check(!!card, '超时：父会话收到审批卡');
    const waited = dismiss && card ? dismiss.at - card.at : NaN;
    check(waited >= TIMEOUT_MS - 500 && waited <= TIMEOUT_MS + 3000, `超时：约 ${TIMEOUT_MS} ms 后宿主发 dismiss 收回卡片（实际 ${waited} ms）`);
    const evaluated = evaluations.find((v) => v.target.includes('approval-two'));
    check(settlements.some((s) => s.auditId === evaluated?.auditId && s.resolution === 'timeout'), '超时：审计回填 timeout');
    const writes = childWriteResults(r?.details?.sessionPath);
    log('   子代理的 write 结果：', writes);
    check(writes.some((b) => b.text.includes(`${TIMEOUT_MS / 1000} 秒内没有人批准 write，视为被拒`)), '超时：子代理收到「8 秒内没有人批准 write，视为被拒」');
    check(!written('two'), '超时：文件没有写出来');
  }

  // 3. worker 后端：经 worker → 宿主的 RPC
  {
    settings({ SUBAGENT_BACKEND: 'worker' });
    await sleep(500);
    const mark = envelopes.length;
    onRequest = (e) => {
      if (e.request.method === 'select' && e.request.subagents) {
        void host.respond({ id: e.request.id, value: '允许本次' }).catch(() => {});
      }
    };
    const fresh = await ask('worker 子代理请求批准，答「允许本次」', runChild('three'));
    const r = toolResult(fresh, 'spawn_agent');
    const seen = envelopes.slice(mark);
    for (const e of seen) log('   信封：', briefEnvelope(e));
    const card = seen.find((e) => e.request.method === 'select');
    const childFile = r?.details?.sessionPath;
    check(childMeta(childFile)?.backend === 'worker', 'worker：子会话 meta 是 backend: worker');
    check(card?.sessionPath === parentFile && !!card?.request.subagents?.length, 'worker：审批卡同样落在父会话上，带子代理身份');
    const evaluated = evaluations.find((v) => v.target.includes('approval-three'));
    check(evaluated?.approvalRoute === true, 'worker：worker 里的 safety 也知道能问人（approvalRoute=true）');
    check(settlements.some((s) => s.auditId === evaluated?.auditId && s.resolution === 'user_allow'), 'worker：审计回填 user_allow');
    log('   子代理的 write 结果：', childWriteResults(childFile));
    check(written('three'), 'worker：批准后文件真的写出来了');
  }

  // 4. 设置为 0：不转发，照旧固定拒绝
  {
    settings({ SUBAGENT_APPROVAL_TIMEOUT_MS: '0' });
    await sleep(500);
    const mark = envelopes.length;
    onRequest = () => {};
    const fresh = await ask('SUBAGENT_APPROVAL_TIMEOUT_MS=0', runChild('four'));
    const r = toolResult(fresh, 'spawn_agent');
    const seen = envelopes.slice(mark);
    for (const e of seen) log('   信封：', briefEnvelope(e));
    check(!seen.some((e) => e.request.method === 'select'), '关闭：父会话没有收到审批卡');
    const evaluated = evaluations.find((v) => v.target.includes('approval-four'));
    check(evaluated && evaluated.approvalRoute === undefined && evaluated.decision === 'deny', '关闭：授权判定没有 approvalRoute，固定拒绝');
    const writes = childWriteResults(r?.details?.sessionPath);
    log('   子代理的 write 结果：', writes);
    check(writes.some((b) => b.text.includes('已被自动拒绝')), '关闭：子代理收到委派范围的拒绝');
    check(!written('four'), '关闭：文件没有写出来');
  }
} catch (error) {
  failures.push(String(error?.message ?? error));
  log('FAIL ', String(error?.stack ?? error));
} finally {
  await host.shutdown().catch(() => {});
  dataServer.close();
  log('\n授权判定（只列带 approval- 的）：');
  for (const v of evaluations.filter((x) => /approval-/i.test(x.target))) log('  ', v);
  log('审计回填：', settlements);
  const tail = host.stderr.split(/\r?\n/).filter((l) => /error|fail/i.test(l) && !/ExperimentalWarning/.test(l)).slice(-30);
  if (tail.length) { log('\nagent-host 输出里与错误相关的行（最多 30 行）：'); for (const l of tail) log('  ', l); }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 上偶尔还被占用 */ }
  log(`\n临时目录已删除：${!existsSync(home)}`);
  log(failures.length ? `${failures.length} 项失败` : '全部通过');
  writeFileSync(logPath, lines.join('\n') + '\n');
}
process.exit(failures.length ? 1 : 0);
