// 探针：实测 pi sidecar RPC 是否发出 thinking（thinking_delta / content thinking 块）
// 用法: node scripts/probe-thinking.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';

const appRoot = resolve(import.meta.dirname, '..');
const piExe = join(appRoot, 'src-tauri', 'binaries', 'pi-x86_64-pc-windows-msvc.exe');
const packageDir = join(appRoot, 'src-tauri', 'binaries');

const child = spawn(piExe, ['--mode', 'rpc'], {
  cwd: appRoot,
  env: { ...process.env, PI_PACKAGE_DIR: packageDir },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let done = false;

const eventTypeCounts = new Map();
const ameTypeCounts = new Map();
let thinkingDeltaChars = 0;
let sawThinkingBlockInPartial = false;
let sawThinkingBlockInEnd = false;
const samples = [];

function send(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'response' && msg.id) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }

  bump(eventTypeCounts, msg.type);

  if (msg.type === 'message_update') {
    const ame = msg.assistantMessageEvent;
    if (ame?.type) bump(ameTypeCounts, ame.type);
    if (ame?.type === 'thinking_delta') {
      thinkingDeltaChars += (ame.delta ?? '').length;
      if (samples.length < 3) samples.push(line.slice(0, 400));
    }
    const content = msg.message?.content;
    if (Array.isArray(content) && content.some((b) => b?.type === 'thinking')) {
      sawThinkingBlockInPartial = true;
    }
  }
  if (msg.type === 'message_end') {
    const content = msg.message?.content;
    if (Array.isArray(content) && content.some((b) => b?.type === 'thinking')) {
      sawThinkingBlockInEnd = true;
    }
    samples.push(`message_end content types: ${JSON.stringify((content ?? []).map((b) => b?.type))}`);
  }
  if (msg.type === 'agent_end') done = true;
});

child.stderr.on('data', (d) => process.stderr.write(d));

function rpc(type, extra = {}) {
  const id = `probe-${type}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolveP, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${type}`)), 60_000);
    pending.set(id, (res) => {
      clearTimeout(timer);
      if (res.success) resolveP(res.data);
      else reject(new Error(res.error ?? `${type} failed`));
    });
    send({ type, id, ...extra });
  });
}

try {
  const state = await rpc('get_state');
  console.log('model:', JSON.stringify(state?.model?.id ?? state?.model));
  console.log('thinkingLevel:', JSON.stringify(state?.thinkingLevel));

  send({
    type: 'prompt',
    id: 'probe-prompt',
    message: '不要使用任何工具。直接回答：47*83 等于多少？只输出数字。',
  });

  const deadline = Date.now() + 90_000;
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
  }

  const report = {
    eventTypeCounts: Object.fromEntries(eventTypeCounts),
    assistantMessageEventCounts: Object.fromEntries(ameTypeCounts),
    thinkingDeltaChars,
    sawThinkingBlockInPartial,
    sawThinkingBlockInEnd,
    samples,
  };
  console.log('REPORT', JSON.stringify(report, null, 2));
  writeFileSync(join(appRoot, 'output', 'probe-thinking-report.json'), JSON.stringify(report, null, 2));
} catch (err) {
  console.error('FAIL:', err);
  process.exitCode = 1;
} finally {
  child.kill();
  process.exit(process.exitCode ?? 0);
}
