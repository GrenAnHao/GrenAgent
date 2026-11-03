// Production agent-host + real Pi SDK + local deterministic providers. No real account data is used.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createControlServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const app = join(repo, 'electron-agent');
const electron = createRequire(join(app, 'package.json'))('electron');
const fixtureHome = mkdtempSync(join(tmpdir(), 'gren-ultra-packaged-'));
const agentDir = join(fixtureHome, '.pi', 'agent');
const workspace = join(fixtureHome, 'project');
const runtimePath = join(fixtureHome, 'runtime-settings.json');
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
const requests = [];
let mainCalls = 0;
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const child = request.url.includes('/child/');
    requests.push({ child, body });
    console.log(`TRACE request ${requests.length}: ${child ? 'child' : 'main'} ${body.model}`);
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const base = { id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model };
    const write = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!child) mainCalls++;
    if (!child && mainCalls <= 2) {
      const name = mainCalls === 1 ? 'list_subagent_models' : 'spawn_agent';
      const args = mainCalls === 1 ? {} : { title: 'Ultra smoke worker', agent: 'worker', task: 'Reply CHILD_DONE.', thinking_level: 'high' };
      const declared = body.tools?.map((tool) => tool.function?.name ?? tool.name) ?? [];
      const direct = declared.includes(name);
      const toolName = direct ? name : declared.includes('codemode') ? 'codemode' : name;
      const toolArgs = toolName === 'codemode' ? { code: `text(await tools.${name}(${JSON.stringify(args)}));` } : args;
      console.log(`TRACE declared ${declared.join(',')} -> ${toolName}`);
      write({ tool_calls: [{ index: 0, id: `call-${mainCalls}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArgs) } }] });
      write({}, 'tool_calls');
    } else {
      write({ role: 'assistant', content: child ? 'CHILD_DONE' : mainCalls === 3 ? 'PACKAGED_ULTRA_OK' : 'PACKAGED_ASK_OK' });
      write({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
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
      if (message.method === 'permission.tool.evaluate') {
        const allowed = ['list_subagent_models', 'spawn_agent', 'send_message'].includes(message.params.call.tool);
        result = { decision: allowed ? 'allow' : 'deny', auditId: 'local-fixture-audit' };
      } else if (message.method === 'permission.tool.settle') result = true;
      else if (message.method === 'permission.authorize') result = { status: 'allowed', decision: 'allow' };
      else throw new Error(`Unsupported fixture control method ${message.method}`);
      socket.end(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
    } catch (error) { socket.end(`${JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_FOUND', message: error.message } })}\n`); }
  });
});
await new Promise((done) => controlServer.listen(0, '127.0.0.1', done));
const controlEndpoint = JSON.stringify({ host: '127.0.0.1', port: controlServer.address().port, token: 'local-control-token' });
const provider = (kind, id, reasoning) => ({ api: 'openai-completions', apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${port}/${kind}/v1`, models: [{ id, reasoning, input: ['text'], contextWindow: 64000, maxTokens: 4096, thinkingLevelMap: { high: 'high' }, compat: { supportsReasoningEffort: true } }] });
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'fixture-main': provider('main', 'main', false), 'fixture-child': provider('child', 'worker', true) } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture-main', defaultModel: 'main', defaultThinkingLevel: 'off', transport: 'sse' }));
writeFileSync(runtimePath, JSON.stringify({ AGENT_DATA_ENDPOINT: controlEndpoint, FABLE_BEHAVIOR: '0', AUTO_TITLE: '0', MEMORY_AUTO_INJECT: '0', MEMORY_AUTO_CAPTURE: '0', MEMORY_EXTRACT: '0', KB_AUTO_INJECT: '0', SUBAGENT_MODE: 'disabled', SUBAGENT_MODEL: 'ordinary/not-a-model', ULTRA_SUBAGENT_MODEL_WORKER: 'fixture-child/worker' }));
const child = spawn(electron, [join(app, 'out-pkg/main/agent-host.js')], {
  cwd: app, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: fixtureHome, USERPROFILE: fixtureHome, PI_CODING_AGENT_DIR: agentDir, PI_RUNTIME_CONFIG: runtimePath, AGENT_DATA_ENDPOINT: controlEndpoint },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true,
});
let stderr = '';
let sequence = 0;
const pending = new Map();
const broadcasts = [];
let readyResolve, readyReject;
const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => {
  readyReject(new Error(`agent-host exited before ready: ${code}/${signal}`));
  for (const item of pending.values()) item.reject(new Error(`agent-host exited: ${code}/${signal}`));
  pending.clear(); resolveExit({ code, signal });
}));
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdout.on('data', () => {});
child.on('error', readyReject);
child.on('message', async (message) => {
  if (message?.t === 'res') {
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok) item.resolve(message.result); else item.reject(new Error(message.error?.message ?? 'request failed'));
  } else if (message?.t === 'evt') {
    if (message.channel === 'host.ready') readyResolve();
    else if (message.channel === 'host.fatal') readyReject(new Error(JSON.stringify(message.payload)));
    else if (message.channel === 'broadcast') broadcasts.push(message.payload);
  } else if (message?.t === 'req') {
    try {
      let result = null;
      if (message.method === 'host.resolveWorkspace') result = message.params.path;
      else if (message.method === 'host.allowedPluginIds' || message.method === 'host.mcpRuntime') result = [];
      else if (message.method === 'host.agentDataEndpoint') result = controlEndpoint;
      else if (message.method === 'host.authorize') result = { status: 'allowed', decision: 'allow' };
      else if (message.method === 'host.mergeRuntimeSettings') writeFileSync(runtimePath, JSON.stringify({ ...JSON.parse(readFileSync(runtimePath, 'utf8')), ...message.params.patch }));
      else if (message.method !== 'host.agentDataEndpoint' && !message.method.startsWith('host.thread.')) throw new Error(`Unsupported fixture host method ${message.method}`);
      child.send({ t: 'res', id: message.id, ok: true, result });
    } catch (error) { child.send({ t: 'res', id: message.id, ok: false, error: { message: error.message } }); }
  }
});
const rpc = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error(`Timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
  child.send({ t: 'req', id, method, params });
});
const send = (command, args = {}) => rpc('pi.send', { workspace, command, args });
const until = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((done) => setTimeout(done, 50)); }
  throw new Error('Timed out waiting for packaged Ultra completion');
};
const systemText = (body) => JSON.stringify(body.messages.find((m) => m.role === 'system' || m.role === 'developer')?.content ?? '');
try {
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('host startup timeout')), 20000))]);
  console.log('PASS packaged agent-host started');
  await rpc('pi.openWorkspace', { workspace });
  await send('agent_set_model', { provider: 'fixture-main', modelId: 'main' });
  const initial = await send('agent_get_state');
  assert.equal(initial.model.provider, 'fixture-main');
  assert.equal(typeof initial.sessionFile, 'string');
  const selected = await send('agent_set_mode', { mode: 'ultra', targetSessionPath: initial.sessionFile });
  assert.equal(selected.ok, true);
  assert.equal(selected.mode, 'ultra');
  console.log('PASS Ultra selected through production IPC');
  await send('agent_prompt', { message: 'Run the deterministic Ultra fixture.', streamingBehavior: 'steer' });
  await until(async () => mainCalls >= 3 && !(await send('agent_get_state')).isStreaming);
  assert.equal(requests.filter((r) => r.child).length, 1);
  assert.equal(requests.find((r) => r.child).body.model, 'worker');
  assert.equal(requests.find((r) => r.child).body.reasoning_effort, 'high');
  assert.ok(systemText(requests[0].body).includes('Ultra scheduling'));
  assert.ok(!systemText(requests.find((r) => r.child).body).includes('Ultra scheduling'));
  console.log('PASS production discovery -> spawn -> configured Ultra worker provider and high effort');
  console.log('PASS Fable disabled: Ultra rules present only in main session');
  const asked = await send('agent_set_mode', { mode: 'ask', targetSessionPath: initial.sessionFile });
  assert.equal(asked.ok, true);
  assert.equal(asked.mode, 'ask');
  await send('agent_prompt', { message: 'Reply using the Ask fixture.', streamingBehavior: 'steer' });
  await until(async () => mainCalls >= 4 && !(await send('agent_get_state')).isStreaming);
  assert.ok(!systemText(requests.at(-1).body).includes('Ultra scheduling'));
  assert.equal(requests.filter((r) => r.child).length, 1);
  console.log('PASS switch Ask removes Ultra rules and does not spawn another child');
  assert.ok(!stderr.includes('读取 Ultra 调度规则失败'), stderr);
  const shutdown = rpc('host.shutdown').catch(() => undefined);
  const stopped = await exit;
  await shutdown;
  assert.equal(stopped.code, 0);
  console.log('PASS production host shutdown');
  console.log(JSON.stringify({ passed: 6, requests: requests.map((r) => ({ provider: r.child ? 'fixture-child' : 'fixture-main', model: r.body.model, effort: r.body.reasoning_effort ?? 'off' })) }, null, 2));
} catch (error) {
  console.error(error.stack ?? String(error));
  console.error(JSON.stringify({ mainCalls, requests: requests.map((item) => ({ child: item.child, model: item.body.model })), events: broadcasts.slice(-12).map((item) => { const value = item.payload?.event ?? item.payload?.request ?? item.payload; return { channel: item.channel, type: value?.type, method: value?.method, tool: value?.toolName, isError: value?.isError, result: value?.result?.content?.filter((part) => part.type === 'text').map((part) => part.text.slice(0, 1200)), role: value?.message?.role, content: value?.message?.role === 'toolResult' ? value.message.content?.map((part) => part.text?.slice(0, 1200)) : undefined, error: value?.message?.errorMessage ?? value?.error, stopReason: value?.message?.stopReason }; }) }, null, 2));
  console.error(stderr.slice(-16000));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
  for (const item of pending.values()) clearTimeout(item.timer);
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  for (const socket of controlSockets) socket.destroy();
  await new Promise((done) => controlServer.close(done));
  rmSync(fixtureHome, { recursive: true, force: true });
}
