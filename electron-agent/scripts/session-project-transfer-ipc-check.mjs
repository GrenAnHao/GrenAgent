#!/usr/bin/env node
/**
 * 会话跨项目迁移的生产 IPC 集成探针（move-sessions-between-projects 6.1）。
 *
 * 真实入口：生产 agent-host 子进程（electron/agentProcess/hostEntry.ts，由 tsx 以源码方式加载），
 * 真实 Pi SDK、真实扩展（safety / sandbox / context-rules / multi-agent / usage-ledger /
 * working-directory / session-project-transfer context），真实 WorkspaceService 的列表与项目删除，
 * 真实 loopback SSE 模型服务。探针自有的只有：临时 HOME/agentDir/两个项目、模型服务计数、
 * IPC 传输、主进程侧 host RPC（含一次性 resolveWorkspace 故障）。
 *
 * 不使用真实会话、真实凭据、远程付费模型；全部数据在 tmpdir，结束后删除。
 * 证据写入 .agents/evidence/2026-11-17-session-project-transfer/。
 *
 *   node electron-agent/scripts/session-project-transfer-ipc-check.mjs
 *   SESSION_PROJECT_TRANSFER_HOST_ENTRY=<out-pkg/main/agent-host.js> node ...   # 父代理确认后再跑
 */
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createControlServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const evidence = process.env.SESSION_PROJECT_TRANSFER_EVIDENCE
  ?? join(root, '.agents/evidence/2026-11-17-session-project-transfer');
await mkdir(evidence, { recursive: true });

const temp = await mkdtemp(join(tmpdir(), 'session-project-transfer-ipc-'));
const agentDir = join(temp, 'agent');
const runtimeConfig = join(agentDir, 'runtime-settings.json');
await mkdir(join(agentDir, 'sessions'), { recursive: true });

const { createTransferFixture, readRegistryIds } = await import('./fixtures/session-project-transfer-fixture.mjs');
const fixture = await createTransferFixture(temp, agentDir);

// ---- 本地模型服务：请求计数 + 确定性工具/文本回合；非 loopback 由 child fixture 拒绝 ----
const requests = [];
let holdNext = false;
let releaseHeld;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const index = requests.length;
  // 注入的附加 user 段会排在真实输入后面，历史里也带旧标记：按“本轮最新的那类标记”归类，
  // 而不是只看最后一条 user 或整段历史。工具续轮由最后一条消息角色决定。
  const userTexts = (body.messages ?? []).filter((message) => message.role === 'user')
    .map((message) => JSON.stringify(message.content));
  const lastRole = (body.messages ?? []).at(-1)?.role;
  const marker = userTexts
    .flatMap((text) => [
      { name: 'explicit-child', hit: text.includes('CONTINUE_CHILD_READ_FILE') },
      { name: 'explicit-main', hit: text.includes('EXPLICIT_AFTER_MOVE') },
      { name: 'explicit-busy', hit: text.includes('HOLD_BUSY') },
      { name: 'child-settlement', hit: text.includes('Background subagent') },
    ].filter((entry) => entry.hit))
    .at(-1)?.name;
  const trigger = !(body.messages ?? []).length ? 'unknown'
    : lastRole === 'tool' ? 'tool-continuation'
    : marker ?? 'unclassified';
  requests.push({ index, url: req.url, body, trigger });
  if (holdNext) {
    holdNext = false;
    await new Promise((release) => { releaseHeld = release; });
  }
  const text = JSON.stringify(body.messages ?? []);
  // 一轮里可能有注入的附加 user 段（如 diagram-hint），标记按全部 user 内容找，而不是只看最后一条。
  const prompt = JSON.stringify((body.messages ?? []).filter((message) => message.role === 'user').map((message) => message.content));
  // 只看本轮最后一条是不是工具结果：历史里也有 toolResult，不能当成“工具刚跑完”。
  const hasToolResult = (body.messages ?? []).at(-1)?.role === 'tool';
  const base = { id: `fixture-${index + 1}`, object: 'chat.completion.chunk', created: 1, model: body.model };
  const send = (delta, finish = null, extra = {}) => {
    res.write(`data: ${JSON.stringify({ ...base, ...extra, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  if (!hasToolResult && /EXPLICIT_AFTER_MOVE|CONTINUE_CHILD_READ_FILE/.test(prompt)) {
    // 主会话和冷恢复子级都用同一个只读文件工具读取两项目同名 fixture：
    // toolResult 里的内容只能来自目标项目，才证明真实工具 root 是目标。
    send({ tool_calls: [{ index: 0, id: `call-read-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'rules-probe.txt' }) } }] });
    send({}, 'tool_calls');
  } else if (!hasToolResult && /INJECT_RESOLVE_FAILURE/.test(text)) {
    // 由探针编排：这里只保证不会走到。
    send({ role: 'assistant', content: 'UNEXPECTED' });
    send({}, 'stop');
  } else {
    send({ role: 'assistant', content: hasToolResult ? 'DONE_AFTER_TOOL' : 'FIXTURE_REPLY' });
    send({}, 'stop', { usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } });
  }
  res.end('data: [DONE]\n\n');
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const modelPort = server.address().port;
const baseUrl = `http://127.0.0.1:${modelPort}/v1`;

// ---- 主进程最小扩展端点（AgentData）：工具授权桩；只允许本探针的临时数据 ----
const controlSockets = new Set();
const controlServer = createControlServer((socket) => {
  controlSockets.add(socket);
  socket.on('close', () => controlSockets.delete(socket));
  let input = '';
  socket.setEncoding('utf8');
  socket.on('data', (part) => {
    input += part;
    const newline = input.indexOf('\n');
    if (newline < 0) return;
    try {
      const message = JSON.parse(input.slice(0, newline));
      assert.equal(message.token, 'local-control-token');
      let result;
      if (message.method === 'permission.tool.evaluate') result = { decision: 'allow', auditId: 'fixture-audit' };
      else if (message.method === 'permission.tool.settle') result = true;
      else if (message.method === 'permission.tool.remember') result = true;
      else if (message.method === 'permission.authorize') result = { status: 'allowed', decision: 'allow' };
      else if (message.method === 'codeRetrieval.call') result = { ok: true };
      else throw new Error(`Unsupported fixture control method ${message.method}`);
      socket.end(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
    } catch (error) {
      socket.end(`${JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_FOUND', message: error.message } })}\n`);
    }
  });
});
await new Promise((done) => controlServer.listen(0, '127.0.0.1', done));
const controlEndpoint = JSON.stringify({
  host: '127.0.0.1', port: controlServer.address().port, token: 'local-control-token',
});

// ---- 临时 runtime / settings / models ----
await writeFile(runtimeConfig, JSON.stringify({
  AUTO_TITLE: '0', AUTO_TITLE_ENABLED: '0', SESSION_STATE_ENABLED: '0',
  MEMORY_AUTO_INJECT: '0', MEMORY_AUTO_CAPTURE: '0', MEMORY_EXTRACT: '0', KB_AUTO_INJECT: '0',
  FABLE_BEHAVIOR: '0', AGENT_DATA_ENDPOINT: controlEndpoint,
}));
await writeFile(join(agentDir, 'models.json'), JSON.stringify({
  providers: {
    fixture: {
      api: 'openai-completions', baseUrl, apiKey: 'fixture-only',
      models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
    },
  },
}));
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
  defaultProvider: 'fixture', defaultModel: 'fixture-model', defaultThinkingLevel: 'off',
  cacheWarming: 'off', compaction: { enabled: false },
}));
await writeFile(join(agentDir, 'trust.json'), JSON.stringify({}));

// ---- 真实 WorkspaceService（主进程侧列表 / 项目登记 / 删除） + 迁移恢复闸门 ----
const { WorkspaceService } = await tsImport('../../electron-agent/electron/app/workspaceService.ts', import.meta.url);
const { installSessionProjectTransferMainGate } = await tsImport('../../electron-agent/electron/app/sessionProjectTransferMainGate.ts', import.meta.url);
const { readTransferJournalBlocks, readTransferJournalManifest } = await tsImport('../../electron-agent/electron/app/sessionProjectTransferJournal.ts', import.meta.url);
const workspace = new WorkspaceService(agentDir);

// ---- host RPC 故障注入：一次 resolveWorkspace 失败 → committed-needs-open ----
let failResolveFor;
const invalidated = [];

function launch() {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  if (process.env.SESSION_PROJECT_TRANSFER_EXEC_PATH) env.ELECTRON_RUN_AS_NODE = '1';
  Object.assign(env, {
    HOME: temp, USERPROFILE: temp, APPDATA: temp, LOCALAPPDATA: temp,
    PI_CODING_AGENT_DIR: agentDir, PI_RUNTIME_CONFIG: runtimeConfig, AGENT_DATA_ENDPOINT: controlEndpoint,
  });
  const child = fork(join(root, 'electron-agent/scripts/session-project-transfer-host-fixture.mjs'), [], {
    execPath: process.env.SESSION_PROJECT_TRANSFER_EXEC_PATH ?? process.execPath,
    cwd: root,
    execArgv: [
      '--import', pathToFileURL(join(root, 'electron-agent/node_modules/tsx/dist/loader.mjs')).href,
      '--import', pathToFileURL(join(root, 'electron-agent/scripts/session-workflow-source-register.mjs')).href,
    ],
    env,
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout.on('data', () => {});
  let sequence = 0;
  const pending = new Map();
  const events = [];
  const broadcasts = [];
  let readyResolve;
  let readyReject;
  const ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
  const exit = new Promise((accept) => child.on('exit', accept));

  child.on('message', async (message) => {
    if (message.t === 'res') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      message.ok ? waiter.resolve(message.result) : waiter.reject(Error(message.error?.message ?? 'RPC failed'));
      return;
    }
    if (message.t === 'evt' && message.channel === 'host.ready') { readyResolve(); return; }
    if (message.t === 'evt' && message.channel === 'broadcast') {
      broadcasts.push(message.payload);
      if (message.payload?.channel === 'pi://event') events.push(message.payload.payload);
      return;
    }
    if (message.t !== 'req') return;
    try {
      let result = null;
      const params = message.params ?? {};
      switch (message.method) {
        case 'host.resolveWorkspace': {
          if (failResolveFor && params.path === failResolveFor) {
            failResolveFor = undefined;
            throw new Error('fixture resolveWorkspace failure after commit');
          }
          result = await workspace.ensureWorkspace(params.path);
          break;
        }
        case 'host.allowedPluginIds': result = []; break;
        case 'host.authorize': result = { status: 'allowed', decision: 'allow' }; break;
        case 'host.mcpRuntime': result = []; break;
        case 'host.agentDataEndpoint': result = controlEndpoint; break;
        case 'host.mergeRuntimeSettings': {
          const previous = JSON.parse(await readFile(runtimeConfig, 'utf8'));
          await writeFile(runtimeConfig, JSON.stringify({ ...previous, ...params.patch }));
          break;
        }
        case 'host.invalidateSessionRecords':
          invalidated.push([...params.paths]);
          workspace.invalidateSessionRecords(params.paths);
          break;
        case 'host.thread.createThread':
        case 'host.thread.createTurn':
          result = { ...params, id: params.id };
          break;
        case 'host.thread.updateTurn': result = { id: params.id, ...params.patch }; break;
        case 'host.thread.upsertItem': result = params; break;
        default: throw new Error(`Unexpected host method ${message.method}`);
      }
      child.send({ t: 'res', id: message.id, ok: true, result });
    } catch (error) {
      child.send({ t: 'res', id: message.id, ok: false, error: { message: String(error) } });
    }
  });
  child.on('error', (error) => readyReject(error));
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(Error(`child exited ${code}: ${stderr.slice(-2500)}`));
    readyReject(Error(`child exited ${code}: ${stderr.slice(-2500)}`));
  });

  const rpc = (method, params = {}) => new Promise((accept, reject) => {
    if (!child.connected) { reject(Error(`Child channel closed: ${stderr.slice(-4000)}`)); return; }
    const id = ++sequence;
    pending.set(id, { resolve: accept, reject });
    child.send({ t: 'req', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(Error(`RPC timeout ${method} ${stderr.slice(-1500)}`));
    }, 30000).unref();
  });
  const send = (workspacePath, command, args = {}) => rpc('pi.send', { workspace: workspacePath, command, args });
  const transfer = (workspacePath, request) => rpc('pi.sessionProjectTransfer', { workspace: workspacePath, request });
  return {
    child, rpc, send, transfer, events, broadcasts, ready,
    stderr: () => stderr,
    async close() {
      if (child.exitCode !== null || !child.connected) return;
      await rpc('host.shutdown').catch(() => {});
      await Promise.race([exit, new Promise((done) => setTimeout(done, 5000))]);
    },
  };
}

// ---- 断言与等待 ----
const facts = [];
const check = (name, condition, detail) => {
  if (!condition) throw Error(`CHECK FAILED: ${name}${detail ? ` (${detail})` : ''}`);
  facts.push(name);
  console.log('PASS', name);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function rows(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitPersistedAssistant(host, file, responsePrefix, beforeIds, cursor) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const entries = await rows(file);
    const done = entries.find((entry) => entry.type === 'message' && entry.message?.role === 'assistant'
      && String(entry.message.responseId ?? '').startsWith(responsePrefix) && !beforeIds.has(entry.id)
      && ['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(entry.message.stopReason));
    const settled = host.events.slice(cursor).some((envelope) => envelope.sessionId === entries[0].id && envelope.event?.type === 'agent_settled');
    if (done && settled) return done;
    await sleep(20);
  }
  throw Error(`No persisted terminal assistant + agent_settled for ${responsePrefix}`);
}

function entryIds(raw) {
  return new Set(raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((entry) => entry.id));
}

/**
 * 子代理解算后会主动唤醒父会话（subagent-settled -> followUp）。等这条通知真的落进主会话日志、
 * 并且主会话再次空闲、请求计数稳定一段时间后，才算显式阶段结束；否则后面“零请求”会把这条
 * 合法结算回合误算成迁移调用。
 */
async function waitMainIdleAfter(file, cursor) {
  const deadline = Date.now() + 30000;
  let stableSince;
  let stableCount = -1;
  while (Date.now() < deadline) {
    const entries = await rows(file);
    const sessionId = entries[0]?.id;
    const settlementPersisted = entries.some((entry) => entry.customType === 'subagent-settled')
      || host.events.slice(cursor).some((envelope) => envelope.sessionId === sessionId && envelope.event?.type === 'agent_settled');
    const state = await host.send(fixture.target, 'agent_get_state').catch(() => undefined);
    const idle = state?.sessionFile === file && state?.isStreaming === false;
    if (settlementPersisted && idle) return;
    if (requests.length !== stableCount) { stableCount = requests.length; stableSince = Date.now(); }
    // 没有 settlement 但整体已安静：可能是 followUp 被合并进上一轮，此时也可结束。
    if (!settlementPersisted && idle && Date.now() - stableSince > 1200) return;
    await sleep(25);
  }
  throw Error('main session did not settle after the explicit phase');
}

async function waitChildSettled(workspacePath, parentSessionPath, childId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const rows = await host.rpc('subagent.list', { workspace: workspacePath, sessionPath: parentSessionPath }).catch(() => []);
    const row = rows.find((item) => item.id === childId);
    if (row && row.status !== 'running') return;
    await sleep(25);
  }
  throw Error(`child ${childId} did not settle before the next move`);
}

function systemText(body) {
  return (body.messages ?? []).filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
}

let host;
try {
  host = launch();
  await host.ready;
  installSessionProjectTransferMainGate({
    agentDir,
    workspace,
    recover: () => host.rpc('pi.recoverSessionTransfers'),
  });

  await host.rpc('pi.openWorkspace', { workspace: fixture.source });
  await host.send(fixture.source, 'agent_switch_session', { sessionPath: fixture.main.path });
  const initialState = await host.send(fixture.source, 'agent_get_state');
  check('production host opens the fixture main session with stable identity',
    initialState.sessionFile === fixture.main.path, JSON.stringify(initialState).slice(0, 300));
  check('source listing includes the fixture main session',
    (await workspace.listSessions(fixture.source)).some((session) => session.path === fixture.main.path));

  // ---- 预览：no-op / 无效目标 / 正常 ----
  const noop = await host.transfer(fixture.source, {
    action: 'preview', sourceWorkspace: fixture.source, sessionPath: fixture.main.path, targetWorkspace: fixture.source,
  });
  check('preview of the same real path is a no-op without a journal or write',
    noop.status === 'no-op' && noop.reason === 'same-workspace' && !existsSync(join(agentDir, 'session-transfers')));

  await assert.rejects(
    host.transfer(fixture.source, {
      action: 'preview', sourceWorkspace: fixture.source, sessionPath: fixture.main.path, targetWorkspace: join(temp, 'missing-target'),
    }),
    /TARGET|目标|ENOENT/i,
  );

  const before = await readFile(fixture.main.path, 'utf8');
  const preview = await host.transfer(fixture.source, {
    action: 'preview', sourceWorkspace: fixture.source, sessionPath: fixture.main.path, targetWorkspace: fixture.target,
  });
  check('preview binds identity, confirmed leaf, revision, family and target policy',
    preview.status === 'preview' && preview.sessionId === fixture.main.id && preview.leafId === fixture.main.leafId
    && typeof preview.revision === 'string' && preview.family?.sessionCount === 3 && preview.family?.childSessionCount === 2
    && preview.policy?.modelRequests === 0 && preview.policy?.fileTransfer === 'none'
    && preview.targetWorkspace === fixture.target,
    JSON.stringify(preview).slice(0, 400));
  check('preview writes no session bytes and makes zero model requests',
    (await readFile(fixture.main.path, 'utf8')) === before && requests.length === 0);

  // ---- busy：真实在途回合 ----
  const busyBefore = entryIds(await readFile(fixture.main.path, 'utf8'));
  const busyCursor = host.events.length;
  holdNext = true;
  const busyHold = host.send(fixture.source, 'agent_prompt', { message: 'HOLD_BUSY explicit turn' });
  while (!releaseHeld) await sleep(10);
  const busy = await host.transfer(fixture.source, {
    action: 'preview', sourceWorkspace: fixture.source, sessionPath: fixture.main.path, targetWorkspace: fixture.target,
  });
  check('an active production turn blocks the transfer without cancelling it',
    busy.status === 'busy' && typeof busy.busyReason === 'string', JSON.stringify(busy));
  releaseHeld(); releaseHeld = undefined;
  await busyHold;
  await waitPersistedAssistant(host, fixture.main.path, 'fixture-', busyBefore, busyCursor);

  // ---- commit：一次 resolveWorkspace 故障 → committed-needs-open ----
  const previewForCommit = await host.transfer(fixture.source, {
    action: 'preview', sourceWorkspace: fixture.source, sessionPath: fixture.main.path, targetWorkspace: fixture.target,
  });
  const requestCountBeforeCommit = requests.length;
  failResolveFor = fixture.target;
  const committed = await host.transfer(fixture.source, {
    action: 'commit', sourceWorkspace: fixture.source, sessionPath: fixture.main.path,
    operationId: previewForCommit.operationId, ticket: previewForCommit.ticket,
    expectedSessionId: previewForCommit.sessionId, expectedLeafId: previewForCommit.leafId,
    expectedRevision: previewForCommit.revision,
  });
  check('post-commit open failure reports committed-needs-open with the durable operation id',
    committed.status === 'committed-needs-open' && committed.operationId === previewForCommit.operationId
    && committed.targetWorkspace === fixture.target && committed.retryable === true,
    JSON.stringify(committed).slice(0, 400));
  check('moving itself makes zero model requests', requests.length === requestCountBeforeCommit);

  const movedRowsText = await readFile(fixture.main.path, 'utf8');
  const movedRows = movedRowsText.trim().split('\n').map((line) => JSON.parse(line));
  const movedIds = new Set(movedRows.map((entry) => entry.id));
  check('canonical path, session id and every original entry survive the move',
    existsSync(fixture.main.path) && movedRows[0].id === fixture.main.id && movedRows[0].cwd === fixture.target
    && [...entryIds(fixture.main.text)].every((id) => movedIds.has(id))
    && movedRowsText.includes('SIDE_BRANCH_ONLY') && movedRowsText.includes('fixture-signature')
    && movedRowsText.includes('historical tool body from source project'),
    `entries ${movedRows.length}`);
  const transferMarkers = movedRows.filter((entry) => entry.type === 'custom' && entry.customType === 'session_project_transfer');
  check('one versioned transfer marker plus target working directory are appended',
    transferMarkers.length === 1 && transferMarkers[0].data.version === 1
    && transferMarkers[0].data.fromWorkspace === fixture.source && transferMarkers[0].data.toWorkspace === fixture.target
    && movedRows.some((entry) => entry.type === 'custom' && entry.customType === 'working_directory' && entry.data.cwd === fixture.target));
  check('children moved with the family and keep their identities',
    existsSync(fixture.continuable.path) && existsSync(fixture.oneShot.path)
    && (await readFile(fixture.continuable.path, 'utf8')).includes(fixture.continuable.id)
    && (await readFile(fixture.oneShot.path, 'utf8')).includes(fixture.oneShot.id));
  const sourceRegistryAfter = await readRegistryIds(fixture.source);
  const targetRegistryAfter = await readRegistryIds(fixture.target);
  check('registry rows move record-by-record; unrelated source rows stay in the source project',
    targetRegistryAfter.some((row) => row.id === fixture.continuable.id)
    && targetRegistryAfter.some((row) => row.id === fixture.oneShot.id)
    && !sourceRegistryAfter.some((row) => row.id === fixture.continuable.id || row.id === fixture.oneShot.id)
    && sourceRegistryAfter.some((row) => row.id === 'sa-unrelated'),
    JSON.stringify({ sourceRegistryAfter, targetRegistryAfter }));

  // committed 但未打开：主进程列表不得把它半迁移地列到任一侧。
  const sourceListDuring = await workspace.listSessions(fixture.source);
  const targetListDuring = await workspace.listSessions(fixture.target);
  check('committed-needs-open family is hidden from both project lists instead of half-migrated',
    !sourceListDuring.some((session) => session.path === fixture.main.path)
    && !targetListDuring.some((session) => session.path === fixture.main.path));

  // 计费分组跟随持久目标（registerProject 先写定位再 resolveWorkspace）。
  const usageAfterCommit = await host.rpc('usage.report');
  check('durable commit already moves usage grouping to the target project',
    usageAfterCommit.byProject.some((project) => project.cwd === fixture.target && project.tokens > 0),
    JSON.stringify(usageAfterCommit.byProject));

  // ---- 重复回执 / 状态 / retry-open 幂等 ----
  const statusCommitted = await host.transfer(fixture.source, {
    action: 'status', sourceWorkspace: fixture.source, sessionPath: fixture.main.path, operationId: previewForCommit.operationId,
  });
  check('status reports the same unfinished durable fact without re-running the move',
    statusCommitted.status === 'committed-needs-open' && statusCommitted.operationId === previewForCommit.operationId);
  const repeatCommit = await host.transfer(fixture.source, {
    action: 'commit', sourceWorkspace: fixture.source, sessionPath: fixture.main.path,
    operationId: previewForCommit.operationId, ticket: previewForCommit.ticket,
    expectedSessionId: previewForCommit.sessionId, expectedLeafId: previewForCommit.leafId,
    expectedRevision: previewForCommit.revision,
  });
  const repeatRows = (await readFile(fixture.main.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  check('a repeated commit receipt returns the same operation fact without a second marker or rewritten history',
    repeatCommit.operationId === previewForCommit.operationId
    && ['committed-needs-open', 'opened'].includes(repeatCommit.status)
    && repeatRows.filter((entry) => entry.type === 'custom' && entry.customType === 'session_project_transfer').length === 1
    && [...entryIds(fixture.main.text)].every((id) => repeatRows.some((entry) => entry.id === id)),
    JSON.stringify(repeatCommit).slice(0, 300));

  const retried = await host.transfer(fixture.source, {
    action: 'retry-open', sourceWorkspace: fixture.source, sessionPath: fixture.main.path, operationId: previewForCommit.operationId,
  });
  check('retry-open completes the committed transaction and opens the same canonical session',
    retried.status === 'opened' && retried.targetWorkspace === fixture.target
    && retried.leafId === previewForCommit.leafId && retried.sessionPath === fixture.main.path,
    JSON.stringify(retried));
  check('retry-open invalidates the exact family paths on the main side',
    invalidated.some((paths) => paths.includes(fixture.main.path) && paths.includes(fixture.continuable.path) && paths.includes(fixture.oneShot.path)),
    JSON.stringify(invalidated));
  const retryAgain = await host.transfer(fixture.source, {
    action: 'retry-open', sourceWorkspace: fixture.source, sessionPath: fixture.main.path, operationId: previewForCommit.operationId,
  });
  check('a second retry-open is idempotent and keeps the single logical identity',
    retryAgain.status === 'opened'
    && (await readFile(fixture.main.path, 'utf8')).split('"customType":"session_project_transfer"').length === 2);

  const sourceListAfter = await workspace.listSessions(fixture.source);
  const targetListAfter = await workspace.listSessions(fixture.target);
  check('after open the family is listed only in the target project', 
    !sourceListAfter.some((session) => session.path === fixture.main.path)
    && targetListAfter.some((session) => session.path === fixture.main.path));

  const targetState = await host.send(fixture.target, 'agent_get_state');
  check('target runtime owns the moved canonical path and narrowed permissions',
    targetState.sessionFile === fixture.main.path && targetState.sessionId === fixture.main.id
    && targetState.preferences?.mode === 'ask' && targetState.preferences?.approval === 'readonly'
    && targetState.preferences?.model?.id === 'fixture-model',
    JSON.stringify(targetState.preferences));

  await assert.rejects(
    host.send(fixture.source, 'agent_switch_session', { sessionPath: fixture.main.path }),
    /SESSION_WORKSPACE_MISMATCH/,
  );
  check('old source workspace refuses to reopen the moved session', true);
  check('commit, repeated commit, status and both retry-opens made no model request',
    requests.length === requestCountBeforeCommit,
    JSON.stringify({ requestCountBeforeCommit, actual: requests.length }));

  // ---- 下一次显式请求：持久终态 + settled + 目标 cwd / 规则 ----
  const targetBefore = entryIds(await readFile(fixture.main.path, 'utf8'));
  const targetCursor = host.events.length;
  const promptCount = requests.length;
  await host.send(fixture.target, 'agent_prompt', { message: 'EXPLICIT_AFTER_MOVE continue here' });
  await waitPersistedAssistant(host, fixture.main.path, `fixture-${promptCount + 1}`, targetBefore, targetCursor);
  check('explicit post-move request persists a terminal entry and settles before reporting done', true);
  const turnRequests = requests.slice(promptCount);
  await writeFile(join(evidence, 'main-post-move-requests.json'), JSON.stringify(turnRequests.map((request) => ({ index: request.index, toolNames: (request.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name), roles: (request.body.messages ?? []).map((message) => message.role), tail: JSON.stringify((request.body.messages ?? []).slice(-4)).slice(0, 2000) })), null, 2));
  const readResult = await (async () => {
    const entries = await rows(fixture.main.path);
    const result = entries.filter((entry) => !targetBefore.has(entry.id) && entry.type === 'message' && entry.message?.role === 'toolResult').at(-1);
    return JSON.stringify(result?.message?.content ?? '');
  })();
  check('a real tool in the moved main session reads the target project file, not the source one',
    readResult.includes('TARGET_FILE_CONTENT') && !readResult.includes('SOURCE_FILE_CONTENT'),
    readResult.slice(0, 500));
  const postMoveSystem = systemText(turnRequests[0].body);
  check('the next model context carries target project instructions and rules, not the source ones',
    postMoveSystem.includes('TARGET_AGENTS_ONLY') && postMoveSystem.includes('TARGET_RULE_BODY')
    && !postMoveSystem.includes('SOURCE_AGENTS_ONLY') && !postMoveSystem.includes('SOURCE_RULE_BODY'));
  check('the next model context states the migration fact without a fake user turn',
    postMoveSystem.includes('This conversation has moved to another local project')
    || JSON.stringify(turnRequests[0].body).includes(fixture.target.replace(/\\/g, '/')));

  // ---- 子级：显式冷恢复 vs 一次性拒绝 ----
  const childBefore = entryIds(await readFile(fixture.continuable.path, 'utf8'));
  const childRequestCount = requests.length;
  await host.rpc('subagent.promptChild', {
    workspace: fixture.target, parentSessionPath: fixture.main.path, sessionPath: fixture.continuable.path,
    message: 'CONTINUE_CHILD_READ_FILE after move', delivery: 'followUp',
  });
  await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const entries = await rows(fixture.continuable.path);
      if (entries.some((entry) => entry.type === 'message' && entry.message?.role === 'assistant'
        && !childBefore.has(entry.id) && entry.message.stopReason === 'stop')) return;
      await sleep(20);
    }
    throw Error('child cold resume produced no terminal entry');
  })();
  const childRequests = requests.slice(childRequestCount);
  await writeFile(join(evidence, 'child-resume-requests.json'), JSON.stringify(childRequests.map((request) => ({ index: request.index, roles: (request.body.messages ?? []).map((message) => message.role), tail: JSON.stringify((request.body.messages ?? []).slice(-2)).slice(0, 1200), systemHead: systemText(request.body) })), null, 2));
  const childResume = childRequests.find((request) => JSON.stringify(request.body.messages ?? []).includes('CONTINUE_CHILD_READ_FILE after move')) ?? childRequests[0];
  const childRead = await (async () => {
    const entries = await rows(fixture.continuable.path);
    const result = entries.filter((entry) => !childBefore.has(entry.id) && entry.type === 'message' && entry.message?.role === 'toolResult').at(-1);
    return JSON.stringify(result?.message?.content ?? '');
  })();
  const childRows = (await readFile(fixture.continuable.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  check('a continuable child cold-resumes in the target: real tool read hits target file, not source',
    Boolean(childResume) && systemText(childResume.body).includes('TARGET_AGENTS_ONLY')
    && !systemText(childResume.body).includes('SOURCE_AGENTS_ONLY')
    && childRead.includes('TARGET_FILE_CONTENT') && !childRead.includes('SOURCE_FILE_CONTENT')
    && childRows[0].cwd.toLowerCase() === fixture.target.toLowerCase(),
    JSON.stringify({ read: childRead.slice(0, 400), headerCwd: childRows[0].cwd }));
  await assert.rejects(
    host.rpc('subagent.promptChild', {
      workspace: fixture.target, parentSessionPath: fixture.main.path, sessionPath: fixture.oneShot.path,
      message: 'MUST_NOT_RESUME', delivery: 'followUp',
    }),
    /one-shot|只读/,
  );
  check('a one-shot child stays read-only after the move', true);
  await waitChildSettled(fixture.target, fixture.main.path, fixture.continuable.id);
  // 子代理结算会主动唤醒父会话一轮；它不是迁移调用，但必须在“后续移动零请求”快照之前完成。
  await waitMainIdleAfter(fixture.main.path, host.events.length);
  const postExplicitRequestCount = requests.length;

  // ---- null-root ----
  const nullPreview = await host.transfer(fixture.source, {
    action: 'preview', sourceWorkspace: fixture.source, sessionPath: fixture.nullRoot.path, targetWorkspace: fixture.fourth,
  });
  check('null-root preview exposes the confirmed empty root instead of the physical leaf',
    nullPreview.status === 'preview' && nullPreview.leafId === null, JSON.stringify(nullPreview).slice(0, 300));
  const nullCommit = await host.transfer(fixture.source, {
    action: 'commit', sourceWorkspace: fixture.source, sessionPath: fixture.nullRoot.path,
    operationId: nullPreview.operationId, ticket: nullPreview.ticket, expectedSessionId: nullPreview.sessionId,
    expectedLeafId: nullPreview.leafId, expectedRevision: nullPreview.revision,
  });
  check('null-root commit opens in the target', nullCommit.status === 'opened' && nullCommit.leafId === null);
  const nullState = await host.send(fixture.fourth, 'agent_switch_session', { sessionPath: fixture.nullRoot.path });
  void nullState;
  const nullTree = await host.send(fixture.fourth, 'agent_session_workflow', {
    action: 'tree', targetSessionPath: fixture.nullRoot.path,
  });
  check('reopened null-root session still has an empty confirmed leaf', nullTree?.tree?.expectedLeafId === null,
    JSON.stringify(nullTree?.tree?.expectedLeafId));
  check('null-root file retains its original messages and gains only the migration metadata',
    (await readFile(fixture.nullRoot.path, 'utf8')).includes('NULL_ROOT_ANSWER'));

  // ---- 删源项目：已移动族仍在 ----
  await workspace.removeProject(fixture.source);
  check('deleting the source project keeps the moved main, children and null-root history readable',
    existsSync(fixture.main.path) && existsSync(fixture.continuable.path) && existsSync(fixture.oneShot.path)
    && existsSync(fixture.nullRoot.path)
    && (await readFile(fixture.main.path, 'utf8')).includes('A answer')
    && (await readFile(fixture.nullRoot.path, 'utf8')).includes('NULL_ROOT_ANSWER'));

  // ---- 反复移动 + 补录：新调用确实计入，历史不重计 ----
  const totalsBefore = (await host.rpc('usage.report')).totals;
  const explicitRequestCount = requests.length;
  check('the explicit post-move main and child calls were each recorded once, so the later equality is meaningful',
    totalsBefore.totalTokens > usageAfterCommit.totals.totalTokens
    && totalsBefore.messages > usageAfterCommit.totals.messages,
    JSON.stringify({ atCommit: usageAfterCommit.totals, beforeMoves: totalsBefore }));
  const second = await host.transfer(fixture.target, {
    action: 'preview', sourceWorkspace: fixture.target, sessionPath: fixture.main.path, targetWorkspace: fixture.other,
  });
  check('second move preview uses the durable target as source', second.status === 'preview' && second.sessionId === fixture.main.id);
  const secondCommit = await host.transfer(fixture.target, {
    action: 'commit', sourceWorkspace: fixture.target, sessionPath: fixture.main.path,
    operationId: second.operationId, ticket: second.ticket, expectedSessionId: second.sessionId,
    expectedLeafId: second.leafId, expectedRevision: second.revision,
  });
  check('second move opens the same identity in the third project with a new directory segment',
    secondCommit.status === 'opened' && secondCommit.targetWorkspace === fixture.other
    && (await readFile(fixture.main.path, 'utf8')).split('"customType":"session_project_transfer"').length === 3,
    JSON.stringify(secondCommit).slice(0, 300));
  const third = await host.transfer(fixture.other, {
    action: 'preview', sourceWorkspace: fixture.other, sessionPath: fixture.main.path, targetWorkspace: fixture.target,
  });
  const thirdCommit = await host.transfer(fixture.other, {
    action: 'commit', sourceWorkspace: fixture.other, sessionPath: fixture.main.path,
    operationId: third.operationId, ticket: third.ticket, expectedSessionId: third.sessionId,
    expectedLeafId: third.leafId, expectedRevision: third.revision,
  });
  check('third move back to the target keeps a single identity and history', thirdCommit.status === 'opened');
  check('no later move, retry-open, null-root or repeated receipt made another model request',
    requests.length === explicitRequestCount, JSON.stringify({ explicitRequestCount, actual: requests.length }));
  await host.rpc('usage.reconcile');
  await host.rpc('usage.reconcile');
  const totalsAfter = (await host.rpc('usage.report')).totals;
  check('repeated moves and reconciliation never re-count historical tokens or cost',
    totalsAfter.totalTokens === totalsBefore.totalTokens && totalsAfter.cost === totalsBefore.cost
    && totalsAfter.messages === totalsBefore.messages,
    JSON.stringify({ totalsBefore, totalsAfter }));

  // ---- journal 终态：不能留 prepared / applying / committed / recovery-required ----
  const remaining = await readTransferJournalBlocks(agentDir);
  const journalDir = join(agentDir, 'session-transfers');
  const operationIds = existsSync(journalDir) ? (await import('node:fs/promises')).readdir(journalDir) : [];
  const manifests = [];
  for (const operationId of await operationIds) {
    if (!/^[0-9a-f-]{36}$/i.test(operationId)) continue;
    const manifest = await readTransferJournalManifest(agentDir, operationId);
    manifests.push({ operationId, ...(manifest ? { state: manifest.state, opened: manifest.opened, targetWorkspace: manifest.targetWorkspace } : {}) });
  }
  check('every transfer journal finished at a terminal state (opened), with no leftovers blocking later commands',
    remaining.length === 0 && manifests.length >= 4 && manifests.every((manifest) => manifest.state === 'opened' && manifest.opened === true),
    JSON.stringify({ remaining, manifests }));

  // ---- 旧 root / 事件 / 零远程 ----
  check('every model request in this probe went to the local loopback server', requests.every((request) => request.url.startsWith('/v1')));
  const triggers = requests.map((request) => request.trigger);
  check('every model request is attributable to an explicit user action, its tool continuation or that child settlement',
    triggers.every((trigger) => ['explicit-main', 'explicit-child', 'explicit-busy', 'tool-continuation', 'child-settlement'].includes(trigger)),
    JSON.stringify(requests.map((request) => ({ index: request.index, trigger: request.trigger }))));
  check('after the explicit phase no migration, retry, reconcile or null-root step requested the model',
    requests.length === postExplicitRequestCount,
    JSON.stringify({ postExplicitRequestCount, actual: requests.length, triggers }));
  check('no remote provider request was attempted', !existsSync(join(agentDir, 'remote-attempts.log')));
  check('migration never used the real user agent directory or credentials',
    agentDir.toLowerCase().startsWith(temp.toLowerCase()));

  await writeFile(join(evidence, 'production-ipc-results.json'), JSON.stringify({
    hostEntry: process.env.SESSION_PROJECT_TRANSFER_HOST_ENTRY ?? 'source',
    facts, requestCount: requests.length,
    requestTriggers: requests.map((request) => ({ index: request.index, trigger: request.trigger })),
    postExplicitRequestCount, invalidated,
    journals: { remainingBlocks: remaining, manifests },
    totalsBefore, totalsAfter,
    stderr: host.stderr(),
  }, null, 2));
  console.log(process.env.SESSION_PROJECT_TRANSFER_HOST_ENTRY ? 'PASS production packaged IPC' : 'PASS production source IPC', facts.length);
} catch (error) {
  await writeFile(join(evidence, 'production-ipc-failure.historical.json'), JSON.stringify({
    note: 'HISTORICAL failure from an earlier probe revision; see production-ipc-results.json for the current accepted run.',
    hostEntry: process.env.SESSION_PROJECT_TRANSFER_HOST_ENTRY ?? 'source',
    passed: facts, requestCount: requests.length, invalidated,
    error: String(error?.stack ?? error), stderr: host?.stderr?.() ?? '',
  }, null, 2));
  throw error;
} finally {
  if (host) await host.close().catch(() => host?.child?.kill());
  await new Promise((done) => server.close(done));
  await new Promise((done) => controlServer.close(done));
  if (process.env.SESSION_PROJECT_TRANSFER_KEEP) console.log('kept temp dir', temp);
  else await rm(temp, { recursive: true, force: true });
}
