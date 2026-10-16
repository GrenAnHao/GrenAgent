/**
 * codegraph-host 的 SDK 工作线程。workerData.role 决定它是写线程还是读线程；
 * 两种都是同一个 CodeGraphService，读写互斥、取消、空闲回收、错误文案都在它里面。
 * 写线程只收 runSync / cancelSync，读线程只收 status / call / search / evict，由主线程保证。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { toWireError } from '../../agentProcess/rpcPeer';
import { CodeGraphService } from './codeGraphService';
import type { WorkerMessage, WorkerRequest, WorkerRole } from './workerProtocol';

if (!parentPort) throw new Error('codegraph worker must run in a worker thread');
const port = parentPort;
const role = (workerData as { role?: WorkerRole } | undefined)?.role ?? 'read';
const service = new CodeGraphService({ listWorkspaces: () => [] });
const post = (message: WorkerMessage) => port.postMessage(message);

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.op) {
    case 'status': return service.status(request.workspace);
    case 'call': return service.call(request.workspace, request.tool, request.args);
    case 'search': return service.search(request.workspace, request.query, request.limit);
    case 'runSync':
      if (role !== 'write') throw new Error('codegraph worker: runSync on a read worker');
      await service.runSync(request.jobId, request.workspace, (progress) => post({ type: 'progress', jobId: request.jobId, progress }));
      return null;
    case 'cancelSync': await service.cancelSync(request.jobId); return null;
    case 'evict': await service.evict(request.workspace); return null;
    case 'close':
      await service.close();
      // 关完库再让线程自然退出：不在 SDK 还在跑时被 terminate（Windows 上可能带走整个进程）。
      setImmediate(() => port.close());
      return null;
  }
}

port.on('message', (request: WorkerRequest) => {
  void handle(request).then(
    (value) => post({ type: 'result', id: request.id, ok: true, value }),
    (error: unknown) => post({ type: 'result', id: request.id, ok: false, error: toWireError(error) }),
  );
});

post({ type: 'ready' });
