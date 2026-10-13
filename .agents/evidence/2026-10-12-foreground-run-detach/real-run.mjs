#!/usr/bin/env node
// 前台 run 转后台的实跑：真实 agent-host + 真实模型（haiku）。脚本扮演主进程，用户发话 = 父会话在跑时发一条 steer。
//   1. 并行 run（一个快、一个慢）：快的结束后用户发话 → spawn_agent 很快返回，快的带回结果，慢的写明转后台；
//      父会话先回复用户；慢的结束时父会话收到它的 subagent-settled 通知
//   2. 单任务 run：子代理起来后用户发话 → 回执 status: running / detached；随后父会话这一轮被打断（agent_abort），
//      子代理不受影响，照样结束并发来 completed 的通知
//   3. 单任务 run：子代理起来后发一条跟进（agent_follow_up，直接进会话的 followUp 队列）→ run 照旧等到结果，不转后台；
//      跟进在这一轮结束后才处理
//   4. 对照：codemode 脚本里的 spawn_agent，用户发话也不转后台，脚本拿到完整结果（模型不按要求写脚本时只记录）
// 用临时 HOME，只把 ~/.pi/agent 的 models.json / auth.json 拷进去（结束时连同临时目录删除），日志里的密钥值替换成 <redacted>。
//
// 先构建：cd electron-agent && npx electron-vite build --mode localrun --outDir out/run-detach
// 再跑：  node .agents/evidence/2026-10-12-foreground-run-detach/real-run.mjs [--model provider/id] [--log 路径]
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
const outMain = resolve(appDir, option('out', 'out/run-detach'), 'main');
const entry = join(outMain, 'agent-host.js');
const workerEntry = join(outMain, 'pi-worker.js');
const [provider, ...modelRest] = option('model', 'custom-muqywnc8/claude-haiku-5-5').split('/');
const modelId = modelRest.join('/');
const logPath = option('log', join(here, 'real-run.txt'));
// --only codemode：只跑第 4 项；--only followup：只跑第 3 项（调试用；证据以完整一遍为准）。
const only = option('only', '');
const electronPath = createRequire(join(appDir, 'package.json'))('electron');
if (!existsSync(entry)) {
  console.error(`找不到 ${entry}，先构建`);
  process.exit(2);
}

const realAgentDir = join(homedir(), '.pi', 'agent');
const home = mkdtempSync(join(tmpdir(), 'run-detach-real-'));
const agentDir = join(home, '.pi', 'agent');
const workspace = join(home, 'project');
const runtimeConfig = join(home, 'runtime-settings.json');
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
for (const name of ['models.json', 'auth.json']) {
  if (existsSync(join(realAgentDir, name))) copyFileSync(join(realAgentDir, name), join(agentDir, name));
}
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
writeFileSync(runtimeConfig, JSON.stringify({}));
writeFileSync(join(workspace, 'README.md'), '# foreground run detach real run\n');
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
const SLOW = 'Write the numbers from 1 to 1000 in English words, one per line, then on a final line write exactly SLOW_DONE. Do not use any tools.';
const MEDIUM = 'Write the numbers from 1 to 200 in English words, one per line, then on a final line write exactly MEDIUM_DONE. Do not use any tools.';
const steer = (text) => host.send('agent_prompt', { message: text, streamingBehavior: 'steer' });
const toolResultFor = (list, name) => list.filter((m) => m.role === 'toolResult' && m.toolName === name).at(-1);

try {
  await host.ready;
  log(`agent-host 就绪；模型 ${provider}/${modelId}`);
  await host.request('pi.openWorkspace', { workspace });
  await host.send('agent_set_model', { provider, modelId });

  // 1. 并行：快的结束后用户发话
  if (!only) {
    log('\n=== 并行 run：快的结束后用户发话 ===');
    const before = (await messages()).length;
    const mark = toolEvents.length;
    await host.send('agent_prompt', {
      message:
        `This is an automated test. Call the spawn_agent tool exactly once with ${JSON.stringify({
          tasks: [
            { title: 'fast', task: 'Reply with exactly the word FAST and nothing else. Do not use any tools.' },
            { title: 'slow', task: SLOW },
          ],
        })}. After it returns, do what the user asks next.`,
    });
    // 快的已经结束、慢的还在跑的那一刻再发话（同一条进度事件里看两项的状态）。
    await waitFor(async () => toolEvents.slice(mark).some((e) => e.type === 'tool_execution_update'
      && Array.isArray(e.details?.results) && e.details.results[0]?.status === 'done' && e.details.results[1]?.status === 'running'), 120_000, '快的结束、慢的还在跑');
    const steerAt = Date.now();
    await steer('Quick check-in: reply with exactly the word HERE and nothing else, and do not call any tools.');
    const end = await waitFor(async () => toolEvents.slice(mark).find((e) => e.type === 'tool_execution_end' && e.toolName === 'spawn_agent'), 60_000, 'spawn_agent 返回');
    const latency = end.at - steerAt;
    log(`   用户发话到 spawn_agent 返回：${latency} ms`);
    await waitIdle(120_000);
    const fresh = (await messages()).slice(before);
    for (const m of fresh) log('  ', brief(m));
    const result = toolResultFor(fresh, 'spawn_agent');
    const rows = result?.details?.results ?? [];
    check(result?.details?.detached === true, '并行：spawn_agent 的结果标明转到后台');
    check(latency < 3000, `并行：用户发话后很快返回（${latency} ms）`);
    check(rows[0]?.ok === true && /FAST/.test(rows[0]?.output ?? ''), '并行：已结束的快任务带回了 FAST');
    check(rows[1]?.status === 'running' && rows[1]?.detached === true && typeof rows[1]?.agentId === 'string', '并行：慢任务写明转到后台，带 agentId');
    const afterTool = fresh.slice(fresh.indexOf(result) + 1);
    const reply = afterTool.find((m) => m.role === 'assistant' && /HERE/.test(textOf(m.content)));
    const noticeIndex = afterTool.findIndex((m) => m.customType === 'subagent-settled');
    check(!!reply && (noticeIndex === -1 || afterTool.indexOf(reply) < noticeIndex), '并行：父会话先回复了用户（HERE），没有等慢任务');
    const slowId = rows[1]?.agentId;
    const notice = await waitFor(async () => settledFor((await messages()).slice(before), slowId), 240_000, '慢任务的结算通知');
    await waitIdle(120_000);
    log('   结算通知：', textOf(notice.content).slice(0, 160));
    check(/SLOW_DONE/.test(textOf(notice.content)), '并行：慢任务结束时父会话收到它的结算通知（带回 SLOW_DONE）');
  }

  // 2. 单任务：转后台后父会话这一轮被打断，子代理照样跑完
  if (!only) {
    log('\n=== 单任务 run：转后台后打断父会话这一轮 ===');
    const before = (await messages()).length;
    const mark = toolEvents.length;
    await host.send('agent_prompt', {
      message: `This is an automated test. Call the spawn_agent tool exactly once with ${JSON.stringify({ title: 'slow single', task: SLOW })}. After it returns, do what the user asks next.`,
    });
    await waitFor(async () => toolEvents.slice(mark).some((e) => e.type === 'tool_execution_update' && e.details?.sessionPath), 120_000, '子代理起来');
    await steer('Stop waiting for it. Reply with exactly the word NOTED and nothing else.');
    const end = await waitFor(async () => toolEvents.slice(mark).find((e) => e.type === 'tool_execution_end' && e.toolName === 'spawn_agent'), 60_000, 'spawn_agent 返回');
    check(end.details?.detached === true && end.details?.status === 'running', '单任务：回执是 status: running / detached');
    const childId = end.details?.agentId;
    await host.send('agent_abort');
    log('   已打断父会话这一轮（agent_abort）');
    await waitIdle(60_000);
    const notice = await waitFor(async () => settledFor((await messages()).slice(before), childId), 240_000, '单任务的结算通知');
    await waitIdle(120_000);
    log('   结算通知：', textOf(notice.content).slice(0, 160));
    check(notice.details?.stopReason === 'completed' && /SLOW_DONE/.test(textOf(notice.content)), '单任务：打断父会话没有取消它，照样跑完并发来 completed 的通知');
  }

  // 3. 跟进（followUp）是「做完再说」：不转后台
  if (!only || only === 'followup') {
    log('\n=== 单任务 run：等待时来了一条跟进（followUp） ===');
    const before = (await messages()).length;
    const mark = toolEvents.length;
    await host.send('agent_prompt', {
      message: `This is an automated test. Call the spawn_agent tool exactly once with ${JSON.stringify({ title: 'medium single', task: MEDIUM })}. After it returns, reply with exactly the word GOT and nothing else.`,
    });
    await waitFor(async () => toolEvents.slice(mark).some((e) => e.type === 'tool_execution_update' && e.details?.sessionPath), 120_000, '子代理起来');
    const followAt = Date.now();
    await host.send('agent_follow_up', { message: 'After you are done, reply with exactly the word LATER and nothing else.' });
    const end = await waitFor(async () => toolEvents.slice(mark).find((e) => e.type === 'tool_execution_end' && e.toolName === 'spawn_agent'), 240_000, 'spawn_agent 返回');
    const waited = end.at - followAt;
    log(`   跟进发出后 run 又等了 ${waited} ms`);
    await waitIdle(120_000);
    const fresh = (await messages()).slice(before);
    for (const m of fresh) log('  ', brief(m));
    const result = toolResultFor(fresh, 'spawn_agent');
    check(waited > 1000, `跟进：发出后 run 又等了 ${waited} ms（超过 1 s，足够看出没有转后台；转后台在 200 ms 内）`);
    check(end.details?.detached !== true && /MEDIUM_DONE/.test(textOf(result?.content)), '跟进：run 没有转后台，等到了完整结果（MEDIUM_DONE）');
    check(!fresh.some((m) => m.customType === 'subagent-settled'), '跟进：没有转后台的结算通知');
    const later = fresh.find((m) => m.role === 'assistant' && /LATER/.test(textOf(m.content)));
    check(!!later && fresh.indexOf(later) > fresh.indexOf(result), '跟进：在这一轮结束后才处理（LATER 在工具结果之后）');
  }

  // 4. 对照：codemode 脚本里的 spawn_agent 不转后台
  if (!only || only === 'codemode') {
    log('\n=== codemode 脚本里的 spawn_agent（对照） ===');
    const before = (await messages()).length;
    const mark = toolEvents.length;
    await host.send('agent_prompt', {
      message:
        'This is an automated test. Use the codemode tool exactly once. In the script, call spawn_agent with ' +
        `${JSON.stringify({ task: SLOW })}, await it, and return its text. Do not call spawn_agent outside the script. After it returns, do what the user asks next.`,
    });
    // 刚发出去时这一轮可能还没开始（isStreaming 还是 false）：要等到 codemode 动起来，或者这一轮确实已经结束。
    const started = await waitFor(
      async () => toolEvents.slice(mark).some((e) => e.toolName === 'codemode')
        || ((await messages()).slice(before).some((m) => m.role === 'assistant') && !(await streaming())),
      180_000,
      'codemode 开始',
    );
    if (!toolEvents.slice(mark).some((e) => e.toolName === 'codemode')) {
      log('   模型没有调 codemode，这一项只记录、不判定');
      for (const m of (await messages()).slice(before)) log('  ', brief(m));
    } else {
      await sleep(8000);
      await steer('Quick check-in: reply with exactly the word HERE and nothing else.');
      await waitIdle(300_000);
      const fresh = (await messages()).slice(before);
      for (const m of fresh) log('  ', brief(m));
      const cm = toolResultFor(fresh, 'codemode');
      log('   codemode 结果里有没有 SLOW_DONE：', /SLOW_DONE/.test(textOf(cm?.content)));
      check(!!cm && /SLOW_DONE/.test(textOf(cm.content)), 'codemode：用户发话后脚本仍拿到了完整结果（没有转后台）');
      check(!fresh.some((m) => m.customType === 'subagent-settled'), 'codemode：没有转后台的结算通知');
    }
    void started;
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
