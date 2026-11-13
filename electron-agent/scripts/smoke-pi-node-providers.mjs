import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after npm run build. Only isolated homes, synthetic credentials and denied network I/O.
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const main = join(app, 'out-pkg/main');
const electron = join(app, 'node_modules/electron/dist/electron.exe');
const temporary = mkdtempSync(join(tmpdir(), 'pi-lazy-production-'));
const wrapper = join(temporary, 'probe.cjs');
writeFileSync(wrapper, String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const mode = process.argv[3];
process.argv = [process.execPath, path.join(root, mode + '.js'), ...(mode === 'pi-worker' ? ['--mode', 'subagent'] : [])];
const denyNetwork = () => { throw new Error('Unexpected network I/O in production smoke'); };
globalThis.fetch = denyNetwork;
for (const module of ['node:http', 'node:https']) {
  require(module).request = denyNetwork;
  require(module).get = denyNetwork;
}
require('node:http2').connect = denyNetwork;
const send = process.send.bind(process);
let probing = false;
process.send = (message, ...args) => {
  const result = send(message, ...args);
  if (!probing && message.t === 'evt' && ['host.ready', 'ready'].includes(message.channel)) {
    probing = true;
    void probe().catch(error => send({ smoke: 'error', message: error.stack }));
  }
  return result;
};
async function probe() {
  const chunks = path.join(root, 'chunks');
  const chunk = name => {
    const pattern = new RegExp('^' + name + '-[A-Za-z0-9_-]{8}\\.jsc$');
    const files = fs.readdirSync(chunks).filter(file => pattern.test(file));
    assert.equal(files.length, 1, 'one ' + name + ' bytecode chunk');
    return path.join(chunks, files[0]);
  };
  const flowNames = ['anthropic', 'openai-codex', 'openai-chatgpt', 'github-copilot', 'openrouter', 'kimi-coding', 'meta', 'xai', 'radius'];
  assert.ok(Object.keys(require.cache).some(file => file.includes('pi-node-providers-')), 'entry initialized provider loaders');
  for (const name of [...flowNames, 'bedrock-converse-stream']) {
    assert.ok(!require.cache[chunk(name)], name + ' must stay lazy before first use');
  }
  const loaders = Object.values(require.cache).map(module => module.exports).find(exports =>
    typeof exports?.loadMetaOAuth === 'function' && typeof exports?.bedrockConverseStreamApi === 'function');
  assert.ok(loaders, 'entry initialized the SDK loader registry');
  const ModelRuntime = Object.values(require.cache).flatMap(module => Object.values(module.exports ?? {}))
    .find(value => typeof value === 'function' && value.name === 'ModelRuntime');
  assert.ok(ModelRuntime, 'entry initialized the real SDK ModelRuntime');
  const credential = { access: 'fixture', refresh: '', type: 'oauth', expires: Number.MAX_SAFE_INTEGER };
  const runtime = await ModelRuntime.create({
    modelsPath: null, refreshOnCreate: false,
    credentials: {
      read: async provider => provider === 'meta' ? credential : undefined,
      list: async () => [],
      modify: async () => { throw new Error('unexpected credential write'); },
      delete: async () => { throw new Error('unexpected credential deletion'); },
    },
  });
  assert.equal((await runtime.getAuth('meta')).auth.apiKey, 'fixture');
  for (const name of ['Anthropic', 'OpenAICodex', 'OpenAIChatGPT', 'GitHubCopilot', 'OpenRouter', 'KimiCoding', 'Meta', 'Xai', 'Radius']) {
    const flow = await loaders['load' + name + 'OAuth']({ gateway: 'https://radius.invalid', name: 'Fixture' });
    assert.equal(typeof flow.login, 'function');
    assert.equal(typeof flow.toAuth, 'function');
  }
  assert.deepEqual(await (await loaders.loadMetaOAuth()).toAuth({ access: 'fixture', refresh: '', type: 'oauth', expires: Number.MAX_SAFE_INTEGER }), { apiKey: 'fixture' });
  const context = { get messages() { throw new Error('Bedrock implementation reached'); } };
  const result = await loaders.bedrockConverseStreamApi().stream({ id: 'fixture', api: 'bedrock-converse-stream', provider: 'amazon-bedrock' }, context).result();
  assert.equal(result.errorMessage, 'Bedrock implementation reached');
  for (const name of [...flowNames, 'bedrock-converse-stream']) assert.ok(require.cache[chunk(name)], name + ' loaded');
  // Let upstream Node-only variable imports settle before the parent requests shutdown.
  await new Promise(resolve => setTimeout(resolve, 50));
  send({ smoke: 'pass', entry: mode, oauthFlows: flowNames.length, bedrock: true });
}
require(path.join(root, mode + '.js'));
`);

async function check(entry) {
  const home = join(temporary, entry);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(home);
  const runtimeConfig = join(home, 'runtime.json');
  writeFileSync(runtimeConfig, '{}');
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP'].flatMap(key =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ));
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: home, PI_RUNTIME_CONFIG: runtimeConfig,
    PI_OFFLINE: '1', HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
  });
  await new Promise((accept, reject) => {
    const child = fork(wrapper, [main, entry], { execPath: electron, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    let passed = false;
    let problem;
    const timer = setTimeout(() => { problem = 'timeout'; child.kill(); }, 15_000);
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('message', message => {
      if (message.channel === 'host.fatal' || message.channel === 'leaked' || message.smoke === 'error') {
        problem = JSON.stringify(message);
        child.kill();
      }
      if (message.smoke === 'pass') {
        passed = true;
        console.log(JSON.stringify(message));
        child.send({ t: 'req', id: 1, method: entry === 'agent-host' ? 'host.shutdown' : 'dispose', params: {} });
      }
    });
    child.on('exit', code => {
      clearTimeout(timer);
      try {
        assert.equal(problem, undefined, problem);
        assert.equal(code, 0, stderr.replace(/[\u200b\u200c\u200d\ufeff]/g, '').slice(-3000));
        assert.ok(passed, `${entry} exited without exercising lazy providers`);
        assert.doesNotMatch(stderr, /ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING|unhandledRejection|uncaughtException/);
        accept();
      } catch (error) { reject(error); }
    });
  });
}

try {
  await check('agent-host');
  await check('pi-worker');
} finally {
  assert.equal(dirname(temporary), tmpdir());
  rmSync(temporary, { recursive: true, force: true });
}
