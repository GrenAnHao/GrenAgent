import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AgentProcessClient, type AgentProcessExit } from '../../../electron-agent/electron/agentProcess/agentProcessClient.ts';

// 真实 Node/Electron 子进程、stdio 与 IPC；仅同步日志接收方注入截图中的 EPIPE。
const attempts: string[] = [];
const exits: AgentProcessExit[] = [];
const originalLog = console.log;
const originalError = console.error;
const brokenSink = (line: string) => {
  attempts.push(line);
  throw Object.assign(new Error('broken pipe, write'), { code: 'EPIPE' });
};
const client = new AgentProcessClient({
  entry: fileURLToPath(new URL('./smoke-child.cjs', import.meta.url)),
  execPath: process.execPath,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  hostMethods: {}, onEvent: () => {}, onExit: (exit) => exits.push(exit),
  shutdownTimeoutMs: 3000,
});
try {
  console.log = brokenSink;
  console.error = brokenSink;
  assert.equal(await client.request('ping'), 'pong');
  await client.shutdown();
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.code, 0);
  assert.equal(exits[0]?.expected, true);
  assert.equal(exits[0]?.stderrTail, 'err-first\nerr-second\nerr-last');
  assert.deepEqual([...attempts].sort(), [
    '[agent-host] out-first', '[agent-host] out-second', '[agent-host] out-last',
    '[agent-host] err-first', '[agent-host] err-second', '[agent-host] err-last',
  ].sort());
} finally {
  console.log = originalLog;
  console.error = originalError;
  await client.shutdown();
}
console.log(JSON.stringify({ result: 'PASS', runtime: process.versions, logAttempts: attempts.length,
  rpc: 'pong', exit: exits[0], fault: 'synchronous EPIPE injected only at console sink' }, null, 2));
