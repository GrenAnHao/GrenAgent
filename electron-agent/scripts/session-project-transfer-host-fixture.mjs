/**
 * 真实生产 agent-host 入口 + 真实 Pi SDK；探针自有的只有传输边界。
 *
 * - 只允许 loopback fetch；其他 host 一律记录到 agentDir/remote-attempts.log 并抛错。
 * - HOME / USERPROFILE / APPDATA / PI_CODING_AGENT_DIR 全部指向临时目录，SDK 只会在其中读 models.json；
 *   真实用户凭据不在临时 agentDir 内，不会被读取。
 * - 不设 PI_SYSTEM_WORKER / PI_DISABLE_PROJECT_CONTEXT，因此真实扩展（safety/context-rules/sandbox/
 *   multi-agent/usage-ledger/working-directory…）与项目 AGENTS.md／规则都会加载。
 * - 故障注入（resolveWorkspace / 迁移 open 失败）由探针在主进程这一侧的 host RPC 响应里做，
 *   不放这里，保证子进程入口与生产完全一致。
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.env.PI_CODING_AGENT_DIR;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    appendFileSync(join(dir, 'remote-attempts.log'), `${url.origin}${url.pathname}\n`);
    throw Error('Remote requests forbidden in fixture');
  }
  return nativeFetch(input, options);
};

await import(process.env.SESSION_PROJECT_TRANSFER_HOST_ENTRY
  ? pathToFileURL(process.env.SESSION_PROJECT_TRANSFER_HOST_ENTRY).href
  : new URL('../electron/agentProcess/hostEntry.ts', import.meta.url).href);
