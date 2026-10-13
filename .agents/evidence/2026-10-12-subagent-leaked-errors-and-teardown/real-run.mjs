#!/usr/bin/env node
// 漏网错误归属的实跑：真实 agent-host + 真实模型（haiku）。脚本扮演主进程。
// 临时 HOME 的 ~/.pi/agent/extensions 里放一个只在本次实跑存在的测试扩展：工具 leak_probe 返回后 50 ms，
// 在不被 await 的定时器里制造一个没人处理的 rejection（就是子代理重新设计第 3 节说的「漏网错误」）。
//   1. 进程内一次性并行 run：一个子代理调 leak_probe，另一个正常回复 → 前者按 error 结束（uncaught error），后者照常完成
//   2. 进程内可续聊（action: spawn）：子代理调 leak_probe → 结算通知 stopReason error，诊断写 uncaught error
//   3. worker 后端（运行时设置 SUBAGENT_BACKEND=worker）的一次性 run：worker 里的漏网错误转给 agent-host，这次 run 按 error 结束
//   4. 迟一点才接住的 rejection（先起会失败的 promise、等 300 ms、再 await 并接住）：子代理照常完成，不算漏网
//   每一项之后 agent-host 都还在（能继续答话），日志里漏网错误标着子代理 id
// 用临时 HOME，只把 ~/.pi/agent 的 models.json / auth.json 拷进去（结束时连同临时目录删除），日志里的密钥值替换成 <redacted>。
//
// 先构建：cd electron-agent && npx electron-vite build --mode localrun --outDir out/run-leak
// 再跑：  node .agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/real-run.mjs [--model provider/id] [--log 路径] [--only 1|2|3|4]
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
const outMain = resolve(appDir, option('out', 'out/run-leak'), 'main');
const entry = join(outMain, 'agent-host.js');
const workerEntry = join(outMain, 'pi-worker.js');
const [provider, ...modelRest] = option('model', 'custom-muqywnc8/claude-haiku-5-5').split('/');
const modelId = modelRest.join('/');
const logPath = option('log', join(here, 'real-run.txt'));
const only = option('only', '');
const runCase = (n) => !only || only === String(n);
const electronPath = createRequire(join(appDir, 'package.json'))('electron');
if (!existsSync(entry)) {
  console.error(`找不到 ${entry}，先构建`);
  process.exit(2);
}

const realAgentDir = join(homedir(), '.pi', 'agent');
const home = mkdtempSync(join(tmpdir(), 'run-leak-real-'));
const agentDir = join(home, '.pi', 'agent');
const workspace = join(home, 'project');
const runtimeConfig = join(home, 'runtime-settings.json');
mkdirSync(join(agentDir, 'extensions'), { recursive: true });
mkdirSync(workspace, { recursive: true });
for (const name of ['models.json', 'auth.json']) {
  if (existsSync(join(realAgentDir, name))) copyFileSync(join(realAgentDir, name), join(agentDir, name));
}
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
writeFileSync(runtimeConfig, JSON.stringify({}));
writeFileSync(join(workspace, 'README.md'), '# leaked error real run\n');
// 测试扩展：只在这次实跑的临时目录里，不进仓库。
writeFileSync(
  join(agentDir, 'extensions', 'leak-probe.ts'),
  [
    'export default function (pi) {',
    '  // 诊断：每轮开始时这个会话里两个测试工具在不在激活清单里（写到 agent-host 的 stderr）。',
    '  pi.on("before_agent_start", () => {',
    '    const active = pi.getActiveTools();',
    '    console.error(`[leak-probe-ext] active: leak_probe=${active.includes("leak_probe")} late_catch_probe=${active.includes("late_catch_probe")} total=${active.length}`);',
    '  });',
    '  pi.registerTool({',
    '    name: "leak_probe",',
    '    label: "Leak probe",',
    '    description: "Test-only tool for an automated test. Returns at once; a moment later a background task fails without anyone handling it.",',
    '    promptSnippet: "Test-only tool used by automated tests.",',
    '    parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },',
    '    async execute(_id, params) {',
    '      setTimeout(() => { Promise.reject(new Error(`LEAK_PROBE ${params.label}`)); }, 50);',
    '      return { content: [{ type: "text", text: "scheduled" }] };',
    '    },',
    '  });',
    '  // 先起一个会失败的 promise，等别的事，再 await 它并接住：Node 会先报 unhandledRejection、再报 rejectionHandled。',
    '  pi.registerTool({',
    '    name: "late_catch_probe",',
    '    label: "Late catch probe",',
    '    description: "Test-only tool for an automated test. Starts some work that fails, waits a little, then handles the failure itself.",',
    '    promptSnippet: "Test-only tool used by automated tests.",',
    '    parameters: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },',
    '    async execute(_id, params) {',
    '      console.error(`[leak-probe-ext] ${params.marker}`);',
    '      const pending = new Promise((_resolve, reject) => setTimeout(() => reject(new Error("CAUGHT_LATER")), 5));',
    '      await new Promise((resolve) => setTimeout(resolve, 300));',
    '      try { await pending; } catch { /* handled on purpose */ }',
    '      return { content: [{ type: "text", text: "handled" }] };',
    '    },',
    '  });',
    '}',
    '',
  ].join('\n'),
);
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

// AgentData 通道桩：工具授权一律放行。
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

/** 父会话的 spawn_agent / codemode 进度（tool_execution_update）与结束（tool_execution_end）。 */
const toolEvents = [];

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
      else if (m.channel === 'broadcast' && m.payload?.channel === 'pi://event') {
        const ev = m.payload.payload?.event;
        // 只要父会话自己的工具事件（子会话的事件带 subagent 标记，另走）。
        if ((ev?.type === 'tool_execution_update' || ev?.type === 'tool_execution_end') && (ev.toolName === 'spawn_agent' || ev.toolName === 'codemode')
          && m.payload.payload?.source !== 'subagent' && !m.payload.payload?.subagent) {
          toolEvents.push({ at: Date.now(), type: ev.type, toolName: ev.toolName, toolCallId: ev.toolCallId, details: (ev.partialResult ?? ev.result)?.details });
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
  text: textOf(m.content).slice(0, 220),
  ...(m.role === 'assistant' ? { toolCalls: (m.content ?? []).filter((b) => b?.type === 'toolCall').map((b) => ({ name: b.name })) } : {}),
});

const host = launchHost();
const messages = async () => (await host.send('agent_get_messages'))?.messages ?? [];
const streaming = async () => (await host.send('agent_get_state'))?.isStreaming === true;
async function waitIdle(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let idleSince = 0;
  while (Date.now() < deadline) {
    if (!(await streaming())) {
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
    await sleep(250);
  }
  throw new Error(`timeout: ${label}`);
}
const settledFor = (list, childId) => list.find((m) => m.customType === 'subagent-settled' && m.details?.childId === childId);
const toolResultFor = (list, name) => list.filter((m) => m.role === 'toolResult' && m.toolName === name).at(-1);
const leakyTask = (label) =>
  `Call the leak_probe tool exactly once with {"label": "${label}"}. After it returns, write a numbered list of 150 different animal names, ` +
  'one per line, then on a final line write exactly LEAKY_DONE. Do not call any other tool.';
/** agent-host 输出里这个子代理的漏网错误那一行。 */
const leakLine = (pattern) => host.stderr.split(/\r?\n/).find((l) => pattern.test(l));
/** 父会话发一句、等它回到空闲，返回这一句之后的新消息。 */
async function ask(message, timeoutMs = 240_000) {
  const before = (await messages()).length;
  await host.send('agent_prompt', { message });
  await waitFor(async () => (await messages()).length > before && !(await streaming()), timeoutMs, '父会话这一轮结束');
  await waitIdle(timeoutMs);
  return (await messages()).slice(before);
}
async function hostAlive(label) {
  const state = await host.send('agent_get_state').catch(() => undefined);
  check(host.child.exitCode === null && state !== undefined, `${label}：agent-host 还在，照常答话`);
}

try {
  await host.ready;
  log(`agent-host 就绪；模型 ${provider}/${modelId}`);
  await host.request('pi.openWorkspace', { workspace });
  await host.send('agent_set_model', { provider, modelId });

  // 模型偶尔说测试工具「不可用」、不去调（上面的诊断行显示工具都在激活清单里）。没调到的那一次不算，最多试三次，
  // 每次换一个标签，日志里写明第几次、为什么重试。
  const MAX_ATTEMPTS = 3;
  async function untilProbed(name, run) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const outcome = await run(attempt);
      if (outcome.probed) {
        if (attempt > 1) log(`   ${name}：第 ${attempt} 次子代理才调了测试工具`);
        return outcome;
      }
      log(`   ${name}：第 ${attempt} 次子代理没有调测试工具（不算，重试）`);
    }
    check(false, `${name}：试了 ${MAX_ATTEMPTS} 次，子代理都没有调测试工具`);
    return undefined;
  }
  const probeRan = (marker) => host.stderr.includes(marker);

  // 1. 进程内一次性并行 run
  if (runCase(1)) {
    log('\n=== 1. 进程内一次性并行 run：一个漏网出错，一个正常 ===');
    const outcome = await untilProbed('1', async (attempt) => {
      const label = `A${attempt}`;
      const fresh = await ask(
        `This is an automated test. Call the spawn_agent tool exactly once with ${JSON.stringify({
          tasks: [
            { title: 'leaky', task: leakyTask(label) },
            { title: 'fine', task: 'Reply with exactly the word FINE and nothing else. Do not use any tools.' },
          ],
        })}. After it returns, reply with exactly the word DONE and do not call any other tool.`,
      );
      for (const m of fresh) log('  ', brief(m));
      const rows = toolResultFor(fresh, 'spawn_agent')?.details?.results ?? [];
      log('   结果：', rows.map((r) => ({ ok: r.ok, agentId: r.agentId, stopReason: r.stopReason, error: r.error, output: String(r.output ?? '').slice(0, 60) })));
      return { probed: probeRan(`LEAK_PROBE ${label}`), label, rows };
    });
    if (outcome) {
      const { label, rows } = outcome;
      check(rows[0]?.ok === false && rows[0]?.stopReason === 'error' && rows[0]?.error === `uncaught error: LEAK_PROBE ${label}`, `1：调了 leak_probe 的子代理按 error 结束，原因是 uncaught error: LEAK_PROBE ${label}`);
      check(rows[1]?.ok === true && /FINE/.test(rows[1]?.output ?? ''), '1：旁边那个子代理不受影响，照常带回 FINE');
      const line = leakLine(new RegExp(`\\[agent-host\\] unhandledRejection \\(sub-agent ${rows[0]?.agentId}\\)`));
      log('   agent-host 日志：', line ?? '(没有)');
      check(!!line, '1：agent-host 日志里这条漏网错误标着出错子代理的 id');
    }
    await hostAlive('1');
  }

  // 2. 进程内可续聊
  if (runCase(2)) {
    log('\n=== 2. 进程内可续聊（action: spawn）：漏网出错按 error 结算 ===');
    const outcome = await untilProbed('2', async (attempt) => {
      const label = `B${attempt}`;
      const before = (await messages()).length;
      const fresh = await ask(
        `This is an automated test. Call the spawn_agent tool exactly once with ${JSON.stringify({ action: 'spawn', title: 'leaky spawn', task: leakyTask(label) })}. ` +
          'After it returns, reply with exactly the word STARTED and do not call any other tool.',
      );
      for (const m of fresh) log('  ', brief(m));
      const started = toolResultFor(fresh, 'spawn_agent');
      const childId = started?.details?.agentId;
      log('   spawn 回执：', { agentId: childId, mode: started?.details?.mode });
      const notice = await waitFor(async () => settledFor((await messages()).slice(before), childId), 240_000, '结算通知');
      await waitIdle(180_000);
      log('   结算通知：', textOf(notice.content).slice(0, 240));
      return { probed: probeRan(`LEAK_PROBE ${label}`), label, started, childId, notice };
    });
    if (outcome) {
      const { label, started, childId, notice } = outcome;
      check(started?.details?.mode === 'continuable', '2：走的是进程内可续聊');
      check(notice.details?.stopReason === 'error', '2：结算通知 stopReason 是 error');
      check(textOf(notice.content).includes(`Diagnostic: uncaught error: LEAK_PROBE ${label}`), `2：通知里的诊断是 uncaught error: LEAK_PROBE ${label}`);
      const line = leakLine(new RegExp(`\\[agent-host\\] unhandledRejection \\(sub-agent ${childId}\\)`));
      log('   agent-host 日志：', line ?? '(没有)');
      check(!!line, '2：agent-host 日志里标着这个子代理的 id');
    }
    await hostAlive('2');
  }

  // 3. worker 后端
  if (runCase(3)) {
    log('\n=== 3. worker 后端的一次性 run：worker 里的漏网错误转给 agent-host ===');
    writeFileSync(runtimeConfig, JSON.stringify({ SUBAGENT_BACKEND: 'worker' }));
    await sleep(800);
    const outcome = await untilProbed('3', async (attempt) => {
      const label = `C${attempt}`;
      const fresh = await ask(
        `This is an automated test. Call the spawn_agent tool exactly once with ${JSON.stringify({ title: 'leaky worker', task: leakyTask(label) })}. ` +
          'After it returns, reply with exactly the word DONE and do not call any other tool.',
      );
      for (const m of fresh) log('  ', brief(m));
      const result = toolResultFor(fresh, 'spawn_agent');
      log('   结果：', { isError: result?.isError, text: textOf(result?.content).slice(0, 240) });
      // worker 的 stderr 宿主只留尾巴；看宿主转记的那一行。
      return { probed: probeRan(`LEAK_PROBE ${label}`), label, result };
    });
    if (outcome) {
      const { label, result } = outcome;
      check(textOf(result?.content).includes(`uncaught error: LEAK_PROBE ${label}`), `3：这次 run 按 error 结束，原因是 uncaught error: LEAK_PROBE ${label}`);
      const line = leakLine(new RegExp(`\\(worker\\): unhandledRejection: LEAK_PROBE ${label}`));
      log('   agent-host 日志：', line ?? '(没有)');
      check(!!line, '3：错误出在 worker 进程里，经 RPC 交给 agent-host（日志里标着 worker 和子代理 id）');
    }
    await hostAlive('3');
  }

  // 4. 迟一点才接住的 rejection 不算漏网（审查修正：unhandledRejection 等一会儿再算）
  if (runCase(4)) {
    log('\n=== 4. 迟一点才接住的 rejection：子代理照常完成 ===');
    writeFileSync(runtimeConfig, JSON.stringify({}));
    await sleep(800);
    const outcome = await untilProbed('4', async (attempt) => {
      const marker = `late_catch_probe ran ${attempt}`;
      const fresh = await ask(
        `This is an automated test. Call the spawn_agent tool exactly once with ${JSON.stringify({
          title: 'late catch',
          task: `Call the late_catch_probe tool exactly once with {"marker": "${marker}"}. After it returns, reply with exactly the word SURVIVED and nothing else.`,
        })}. After it returns, reply with exactly the word DONE and do not call any other tool.`,
      );
      for (const m of fresh) log('  ', brief(m));
      const result = toolResultFor(fresh, 'spawn_agent');
      log('   结果：', { isError: result?.isError, text: textOf(result?.content).slice(0, 160) });
      return { probed: probeRan(`[leak-probe-ext] ${marker}`), result };
    });
    if (outcome) {
      const { result } = outcome;
      check(!result?.isError && textOf(result?.content).trim() === 'SURVIVED', '4：子代理照常完成（只回了 SURVIVED），没有被当成漏网错误中断');
      check(!leakLine(/CAUGHT_LATER/), '4：agent-host 日志里没有这条（它在等待期内被接住了）');
    }
    await hostAlive('4');
  }
} catch (error) {
  failures.push(String(error?.message ?? error));
  log('FAIL ', String(error?.stack ?? error));
} finally {
  await host.shutdown().catch(() => {});
  dataServer.close();
  const tail = host.stderr.split(/\r?\n/).filter((l) => /error|fail|LEAK_PROBE/i.test(l) && !/ExperimentalWarning/.test(l)).slice(-40);
  if (tail.length) { log('\nagent-host 输出里与错误相关的行（最多 40 行）：'); for (const l of tail) log('  ', l); }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 上偶尔还被占用 */ }
  log(`\n临时目录已删除：${!existsSync(home)}`);
  log(failures.length ? `${failures.length} 项失败` : '全部通过');
  writeFileSync(logPath, lines.join('\n') + '\n');
}
process.exit(failures.length ? 1 : 0);
