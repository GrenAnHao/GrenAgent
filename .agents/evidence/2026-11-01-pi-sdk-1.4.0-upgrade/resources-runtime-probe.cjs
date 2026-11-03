const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { fork, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const repo = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const app = path.join(repo, 'electron-agent');
const out = path.join(app, 'out-pkg/main');
const tempBase = path.join(repo, '.tmp-pi-sdk-1.4/temp-resources');
const sdkRequire = require('node:module').createRequire(fs.realpathSync(path.join(app, 'node_modules/@earendil-works/pi-coding-agent/package.json')));
const wasmPath = sdkRequire.resolve('quickjs-wasi/quickjs.wasm');

if (!process.versions.electron) {
  const electron = require(path.join(app, 'node_modules/electron'));
  const result = spawnSync(electron, [__filename, repo], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true, encoding: 'utf8', timeout: 45000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}

async function codemode() {
  const wasm = await WebAssembly.compile(fs.readFileSync(wasmPath));
  const worker = new Worker(path.join(out, 'chunks/worker.js'), {
    workerData: { code: 'text(6 * 7)', tools: [], globals: [], store: {},
      wasm, interrupt: new SharedArrayBuffer(4), memoryLimitBytes: 64 * 1024 * 1024 },
  });
  let timer;
  try {
    const messages = [];
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('codemode worker timed out')), 15000);
      worker.on('error', reject);
      worker.on('message', (message) => {
        messages.push(message);
        if (message.type === 'done') resolve(message);
        if (message.type === 'crash') reject(new Error(message.message));
      });
    });
    if (result.ok === false || !JSON.stringify(messages).includes('42')) {
      throw new Error('unexpected worker messages: ' + JSON.stringify(messages));
    }
    console.log('PASS production codemode worker .js/.jsc executes QuickJS text(6 * 7) -> 42 with explicit installed wasm');
    console.log(JSON.stringify({ codemodeMessages: messages }));
  } finally { clearTimeout(timer); await worker.terminate(); }
}

async function repoWiki() {
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'production-repowiki-'));
  const child = fork(path.join(out, 'repo-wiki-host.cjs'), [], {
    cwd: root, windowsHide: true,
    env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1',
      HOME: root, USERPROFILE: root, TEMP: tempBase, TMP: tempBase,
      REPOWIKI_DATA_DIR: path.join(root, 'data'), REPOWIKI_ALLOWED_ROOTS: '[]',
      REPOWIKI_PROVIDER_BRIDGE: '1', REPOWIKI_HOST_MODEL_KEY: 'resource-probe-no-model-calls' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '', timer;
  child.stderr.on('data', value => { stderr += value.toString(); });
  const next = () => Promise.race([
    once(child, 'message').then(([value]) => value),
    once(child, 'exit').then(([code]) => { throw new Error(`RepoWiki exited ${code}: ${stderr}`); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RepoWiki timed out')), 15000); }),
  ]).finally(() => clearTimeout(timer));
  try {
    const ready = await next();
    if (ready.type !== 'ready') throw new Error(JSON.stringify(ready));
    const response = next();
    child.send({ v: 1, type: 'request', id: 'resource-stop', action: 'shutdown', input: {} });
    const reply = await response;
    if (reply.ok !== true || reply.result?.stopped !== true) throw new Error(JSON.stringify(reply));
    const exit = await once(child, 'exit');
    if (exit[0] !== 0) throw new Error(JSON.stringify(exit));
    console.log('PASS production repo-wiki-host.cjs Electron Node startup + IPC shutdown, isolated data/HOME, no model calls');
    if (stderr.trim()) console.log('RepoWiki stderr: ' + stderr.trim());
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(tempBase) + path.sep)) throw new Error('unsafe temporary cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

(async () => { await codemode(); await repoWiki(); })().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
