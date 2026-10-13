/**
 * agent-host 子进程入口。主进程用同一份 Electron 可执行文件加 ELECTRON_RUN_AS_NODE=1 拉起，
 * 经 Node IPC（serialization: 'advanced'）和主进程对话。见 docs/decisions/electron-agent/2026-10-09-agent-host-child-process.md。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { installFastRealpath } from '../fastRealpath';
import { restartRuntimeConfig } from '../../../extensions/_shared/runtime-config.js';
import {
  currentChild,
  rejectionWasHandled,
  reportLeakedError,
  trackUnhandledRejection,
} from '../../../extensions/_shared/leak-owner.js';
import { BROADCAST_CHANNEL, DIAG_CHANNEL, type BroadcastPayload } from './contract';
import { hostApiOverRequest } from './hostApi';
import { RpcPeer, toWireError, type WireMessage } from './rpcPeer';
import type { RuntimeGraph } from './runtimeGraph';

const DISCONNECT_SHUTDOWN_MS = 10_000;
const DIAG_INTERVAL_MS = 10_000;

installFastRealpath();
// 本进程已经按 Node 模式起来了。不删的话，bash / MCP 服务器这些孙进程里再启动的 Electron 应用
// （VS Code 等）都会被当成 Node 跑。子代理 worker 在 spawn 时自己显式带上这个变量。
delete process.env.ELECTRON_RUN_AS_NODE;

function send(message: WireMessage): void {
  if (!process.send || !process.connected) throw new Error('AGENT_HOST_DISCONNECTED');
  process.send(message);
}

const peer = new RpcPeer({ send });
process.on('message', (message) => peer.receive(message));

let graph: RuntimeGraph | undefined;
let shuttingDown: Promise<void> | undefined;
function shutdown(): Promise<void> {
  shuttingDown ??= (async () => {
    try {
      await graph?.shutdown();
    } catch (error) {
      console.error('[agent-host] shutdown failed', error);
    }
  })();
  return shuttingDown;
}

// 关停请求在装配完成前就要能处理：主进程可能在子进程还没就绪时退出。
peer.handle('host.shutdown', async () => {
  await shutdown();
  setImmediate(() => process.exit(0));
  return null;
});

// 主进程没了（崩溃、开发时重启）：自己收尾退出，不留孤儿进程。
process.on('disconnect', () => {
  peer.close(new Error('AGENT_HOST_DISCONNECTED'));
  const timer = setTimeout(() => process.exit(0), DISCONNECT_SHUTDOWN_MS);
  void shutdown().finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
});

// 原来跑在 Electron 主进程里时，扩展抛出的未捕获异常不会让进程退出。这里保持一样：记下来，继续服务。
// 出在某个子代理里的（按 AsyncLocalStorage 归属，extensions/_shared/leak-owner.ts）：交给那个子代理，
// 它正在跑就中断这一轮、按 error 结算；已经结算的只记日志。主会话和不在任何子代理里的错误照旧只记日志。
// unhandledRejection 等一会儿再算：期间被接住（rejectionHandled）的不是漏网错误。
function onLeakedError(kind: string, error: unknown, childId: string | undefined): void {
  const owner = reportLeakedError(error, childId);
  const where = owner ? ` (sub-agent ${owner.childId}${owner.handled ? '' : ', already settled'})` : '';
  console.error(`[agent-host] ${kind}${where}`, error);
}
process.on('uncaughtException', (error) => onLeakedError('uncaughtException', error, currentChild()));
process.on('unhandledRejection', (reason, promise) =>
  trackUnhandledRejection(reason, promise, (late, childId) => onLeakedError('unhandledRejection', late, childId)),
);
process.on('rejectionHandled', (promise) => rejectionWasHandled(promise));

async function main(): Promise<void> {
  if (!process.send) throw new Error('agent-host must be spawned with an IPC channel');
  const runtimeConfigPath = process.env.PI_RUNTIME_CONFIG;
  if (!runtimeConfigPath) throw new Error('PI_RUNTIME_CONFIG is not set');
  restartRuntimeConfig();
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  // 运行时图会静态引入 pi SDK 和全部扩展。动态引入：上面的环境处理和 IPC 先就位，加载失败也能报给主进程。
  const { createRuntimeGraph } = await import('./runtimeGraph');
  graph = createRuntimeGraph({
    host: hostApiOverRequest((method, params) => peer.request(method, params)),
    broadcast: (channel, payload) => peer.emit(BROADCAST_CHANNEL, { channel, payload } satisfies BroadcastPayload),
    agentDir,
    runtimeConfigPath,
  });
  peer.handleAll(graph.methods);
  peer.emit('host.ready', { pid: process.pid });
  startDiagSampling();
}

/**
 * 每 10 秒报一次本进程的内存和事件循环延迟，主进程写进 runtime-diag.jsonl（kind: 'agent-host-sample'）。
 * 同时记下这 10 秒末正在跑哪些子代理（进程内 / worker）、驻留池和 worker 进程数：卡顿时能对上是谁在跑
 * （子代理重新设计第 3 节建议 4，验收：8 个进程内子代理并发时 p99 ≤ 200 ms）。
 * 主进程的 app.getAppMetrics() 不含 child_process 子进程，不报就看不到运行时的堆和卡顿。
 */
function startDiagSampling(): void {
  // 动态取：这时运行时图已经加载过这些模块，不会把 SDK 拉进启动路径。
  let subagentSnapshot: () => SubagentSnapshot | undefined = () => undefined;
  void loadSubagentSnapshot().then((fn) => { subagentSnapshot = fn; }, () => {});
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    const subagents = subagentSnapshot();
    peer.emit(DIAG_CHANNEL, {
      memory: { rss: mb(memory.rss), heapUsed: mb(memory.heapUsed), heapTotal: mb(memory.heapTotal), heapLimit: mb(getHeapStatistics().heap_size_limit) },
      lag: { maxMs: Math.round(lag.max / 1e6), p99Ms: Math.round(lag.percentile(99) / 1e6), meanMs: Math.round(lag.mean / 1e6) },
      ...(subagents ? { subagents } : {}),
    });
    lag.reset();
  }, DIAG_INTERVAL_MS);
  timer.unref();
}

interface SubagentSnapshot {
  active: number;
  inProcess: number;
  worker: number;
  ids: string[];
  resident: number;
  workerProcesses: number;
}

/** 采样那一刻在跑的子代理；名单最多 16 个，避免诊断行过长。 */
async function loadSubagentSnapshot(): Promise<() => SubagentSnapshot> {
  const [{ activeRuns }, { residentChildIds }, { workerSlotsInUse }] = await Promise.all([
    import('../../../extensions/multi-agent/active-runs.js'),
    import('../../../extensions/multi-agent/activation.js'),
    import('../../../extensions/multi-agent/worker-session.js'),
  ]);
  return () => {
    const runs = activeRuns();
    return {
      active: runs.length,
      inProcess: runs.filter((r) => r.backend === 'in-process').length,
      worker: runs.filter((r) => r.backend === 'worker').length,
      ids: runs.slice(0, 16).map((r) => r.childId),
      resident: residentChildIds().length,
      workerProcesses: workerSlotsInUse(),
    };
  };
}

main().catch((error: unknown) => {
  console.error('[agent-host] failed to start', error);
  // 等 host.fatal 真正写出去再退出：Windows 上管道写是异步的，直接 exit 会把这条消息丢掉。
  const exit = () => process.exit(1);
  const fallback = setTimeout(exit, 1_000);
  const wire = toWireError(error);
  try {
    if (!process.send || !process.connected) throw new Error('AGENT_HOST_DISCONNECTED');
    process.send({ t: 'evt', channel: 'host.fatal', payload: { message: wire.stack ?? wire.message } }, () => {
      clearTimeout(fallback);
      exit();
    });
  } catch {
    clearTimeout(fallback);
    exit();
  }
});
