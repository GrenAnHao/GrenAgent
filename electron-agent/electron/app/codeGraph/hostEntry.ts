/**
 * codegraph-host 子进程入口。主进程用同一份 Electron 可执行文件加 ELECTRON_RUN_AS_NODE=1 拉起，
 * 经 Node IPC（serialization: 'advanced'）对话。CodeGraph SDK 的索引写入（indexAll / sync）与查询都是
 * 同步的 node:sqlite + 引用解析，放在主进程会把窗口卡住几十秒；这里整个 SDK 只在本进程里加载。
 * 见 .agents/notes/implemented/architecture/2026-10-16-codegraph-host-process.md。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { RpcPeer, toWireError, type WireMessage } from '../../agentProcess/rpcPeer';
import { CodeGraphService } from './codeGraphService';
import { CodeGraphThreads, type WorkerHandle } from './codeGraphThreads';
import { CODEGRAPH_DIAG_CHANNEL, CODEGRAPH_PROGRESS_CHANNEL, CODEGRAPH_SYNC_EVENT_CHANNEL, type CodeGraphDiagSample, type CodeGraphProgressEvent, type CodeGraphSyncEvent } from './hostContract';
import { createCodeGraphHostMethods } from './hostMethods';

const DISCONNECT_SHUTDOWN_MS = 10_000;
const DIAG_INTERVAL_MS = 10_000;

// 本进程已经按 Node 模式起来；SDK 只开 worker 线程，不再起子进程，但仍不把这个变量传下去。
delete process.env.ELECTRON_RUN_AS_NODE;

function send(message: WireMessage): void {
  if (!process.send || !process.connected) throw new Error('CODEGRAPH_HOST_DISCONNECTED');
  process.send(message);
}

const peer = new RpcPeer({ send });
process.on('message', (message) => peer.receive(message));

// SDK 只在工作线程里加载：本线程只收发 IPC 和调度，一次长同步不会挡住别的查询、取消和关停。
// 工作线程入口由主进程经环境变量给出（和本入口在同一个 out/main 下）。
// GREN_CODEGRAPH_THREADS=off 退回单线程（SDK 直接在本线程里跑）：工作线程在某个环境里起不来时的退路。
// 退路里没有写调度与自动同步，读写互斥与改动前一样；GREN_CODEGRAPH_AUTO_SYNC=off 只关自动同步。
const workerEntry = process.env.CODEGRAPH_WORKER_ENTRY;
const threaded = process.env.GREN_CODEGRAPH_THREADS !== 'off';
if (threaded && !workerEntry) throw new Error('CODEGRAPH_WORKER_ENTRY is not set');
const service = threaded
  ? new CodeGraphThreads({
    createWorker: (role) => new Worker(workerEntry!, { workerData: { role } }) as unknown as WorkerHandle,
    onSyncEvent: (event) => peer.emit(CODEGRAPH_SYNC_EVENT_CHANNEL, event satisfies CodeGraphSyncEvent),
  })
  : Object.assign(new CodeGraphService({ listWorkspaces: () => [] }), { syncing: 0 });
const tracker = { active: new Set<string>() };
peer.handleAll(createCodeGraphHostMethods(service, (jobId, progress) => {
  peer.emit(CODEGRAPH_PROGRESS_CHANNEL, { jobId, progress } satisfies CodeGraphProgressEvent);
}, tracker));

let shuttingDown: Promise<void> | undefined;
function shutdown(): Promise<void> {
  // close() 先取消在跑的同步、等它真正结束，再让各工作线程关库退出；SDK 的 DB 不能在写一半时被关。
  shuttingDown ??= service.close().catch((error: unknown) => { console.error('[codegraph-host] shutdown failed', error); });
  return shuttingDown;
}

peer.handle('host.shutdown', async () => {
  await shutdown();
  setImmediate(() => process.exit(0));
  return null;
});

// 主进程没了：自己收尾退出，不留孤儿进程，也不把 .codegraph 写到一半就丢下。
process.on('disconnect', () => {
  peer.close(new Error('CODEGRAPH_HOST_DISCONNECTED'));
  const timer = setTimeout(() => process.exit(0), DISCONNECT_SHUTDOWN_MS);
  void shutdown().finally(() => { clearTimeout(timer); process.exit(0); });
});

// SDK 的 worker 线程偶发抛出的未捕获异常不该带走整个进程；记下来继续服务（主进程那边有崩溃预算兜底）。
process.on('uncaughtException', (error) => console.error('[codegraph-host] uncaughtException', error));
process.on('unhandledRejection', (reason) => console.error('[codegraph-host] unhandledRejection', reason));

function startDiagSampling(): void {
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    peer.emit(CODEGRAPH_DIAG_CHANNEL, {
      memory: { rss: mb(memory.rss), heapUsed: mb(memory.heapUsed), heapTotal: mb(memory.heapTotal), heapLimit: mb(getHeapStatistics().heap_size_limit) },
      lag: { maxMs: Math.round(lag.max / 1e6), p99Ms: Math.round(lag.percentile(99) / 1e6), meanMs: Math.round(lag.mean / 1e6) },
      syncing: Math.max(tracker.active.size, service.syncing),
    } satisfies CodeGraphDiagSample);
    lag.reset();
  }, DIAG_INTERVAL_MS);
  timer.unref();
}

try {
  if (!process.send) throw new Error('codegraph-host must be spawned with an IPC channel');
  peer.emit('host.ready', { pid: process.pid });
  startDiagSampling();
} catch (error) {
  const wire = toWireError(error);
  console.error('[codegraph-host] failed to start', wire.stack ?? wire.message);
  process.exit(1);
}
