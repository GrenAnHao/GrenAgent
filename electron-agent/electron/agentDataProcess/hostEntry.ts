/**
 * agentdata-host 子进程入口。主进程用同一份 Electron 可执行文件加 ELECTRON_RUN_AS_NODE=1 拉起，
 * 经 Node IPC（serialization: 'advanced'）对话；扩展经命名管道直连这里的运行时。
 * 本进程是 agent-data.db 的唯一持有者：同步 sqlite、记忆 / Wiki 的后台任务和定时器都在这里跑，不占主进程。
 * 见 .agents/notes/implemented/architecture/2026-10-16-agentdata-host-process.md。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { agentDataTiming } from '../agentData/methodTiming';
import { RpcPeer, toWireError, type WireMessage } from '../agentProcess/rpcPeer';
import { AGENTDATA_DIAG_CHANNEL, type AgentDataHostConfig } from './contract';
import { createCodeGraphClient } from './codeGraphClient';
import { createAgentDataHost } from './host';

const DISCONNECT_SHUTDOWN_MS = 10_000;
const DIAG_INTERVAL_MS = 10_000;

delete process.env.ELECTRON_RUN_AS_NODE;

function send(message: WireMessage): void {
  if (!process.send || !process.connected) throw new Error('AGENTDATA_HOST_DISCONNECTED');
  process.send(message);
}

const peer = new RpcPeer({ send });
process.on('message', (message) => peer.receive(message));
const diag = (record: { kind: string } & Record<string, unknown>) => peer.emit(AGENTDATA_DIAG_CHANNEL, record);

let shuttingDown: Promise<void> | undefined;
let host: ReturnType<typeof createAgentDataHost> | undefined;
function shutdown(): Promise<void> {
  shuttingDown ??= (host?.shutdown() ?? Promise.resolve()).catch((error: unknown) => { console.error('[agentdata-host] shutdown failed', error); });
  return shuttingDown;
}

// 关停在装配完成前也要能处理。
peer.handle('host.shutdown', async () => {
  await shutdown();
  setImmediate(() => process.exit(0));
  return null;
});

process.on('disconnect', () => {
  peer.close(new Error('AGENTDATA_HOST_DISCONNECTED'));
  const timer = setTimeout(() => process.exit(0), DISCONNECT_SHUTDOWN_MS);
  void shutdown().finally(() => { clearTimeout(timer); process.exit(0); });
});

// 与原来在主进程里一样：单个后台任务漏出的异常记下来，继续服务。
process.on('uncaughtException', (error) => console.error('[agentdata-host] uncaughtException', error));
process.on('unhandledRejection', (reason) => console.error('[agentdata-host] unhandledRejection', reason));

function startDiagSampling(): void {
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    const agentData = agentDataTiming.drain();
    diag({
      kind: 'agentdata-host-sample',
      memory: { rss: mb(memory.rss), heapUsed: mb(memory.heapUsed), heapTotal: mb(memory.heapTotal), heapLimit: mb(getHeapStatistics().heap_size_limit) },
      lag: { maxMs: Math.round(lag.max / 1e6), p99Ms: Math.round(lag.percentile(99) / 1e6), meanMs: Math.round(lag.mean / 1e6) },
      ...(agentData ? { agentData } : {}),
    });
    lag.reset();
  }, DIAG_INTERVAL_MS);
  timer.unref();
}

async function main(): Promise<void> {
  if (!process.send) throw new Error('agentdata-host must be spawned with an IPC channel');
  const raw = process.env.AGENTDATA_HOST_CONFIG;
  if (!raw) throw new Error('AGENTDATA_HOST_CONFIG is not set');
  delete process.env.AGENTDATA_HOST_CONFIG;
  const config = JSON.parse(raw) as AgentDataHostConfig;
  host = createAgentDataHost({
    config,
    peer,
    createCodeGraph: (listWorkspaces) => createCodeGraphClient({ ...config.codeGraph, listWorkspaces, diag }),
  });
  const { 'host.shutdown': _ownShutdown, ...methods } = host.methods;
  peer.handleAll(methods);
  await host.start();
  peer.emit('host.ready', { pid: process.pid });
  startDiagSampling();
}

main().catch((error: unknown) => {
  console.error('[agentdata-host] failed to start', error);
  const exit = () => process.exit(1);
  const fallback = setTimeout(exit, 1_000);
  const wire = toWireError(error);
  try {
    if (!process.send || !process.connected) throw new Error('AGENTDATA_HOST_DISCONNECTED');
    process.send({ t: 'evt', channel: 'host.fatal', payload: { message: wire.stack ?? wire.message } }, () => { clearTimeout(fallback); exit(); });
  } catch {
    clearTimeout(fallback);
    exit();
  }
});
