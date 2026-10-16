/**
 * codegraph-host 主线程 ↔ SDK 工作线程的消息。主线程只调度，SDK 只在工作线程里加载。
 * 一个写线程跑 runSync，若干读线程跑 status / call / search；同一工作区的读写由主线程排开。
 */
import type { IndexProgress } from '@colbymchenry/codegraph';
import type { CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { WireError } from '../../agentProcess/rpcPeer';

export type WorkerRole = 'read' | 'write';

export type WorkerRequest =
  | { id: number; op: 'status'; workspace: string }
  | { id: number; op: 'call'; workspace: string; tool: CodeRetrievalTool; args: Record<string, unknown> }
  | { id: number; op: 'search'; workspace: string; query: string; limit: number }
  | { id: number; op: 'runSync'; jobId: string; workspace: string }
  | { id: number; op: 'cancelSync'; jobId: string }
  | { id: number; op: 'evict'; workspace: string }
  | { id: number; op: 'close' };

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: WireError }
  | { type: 'progress'; jobId: string; progress: IndexProgress };

/** 不带 id 的请求体（调度方补 id）。 */
export type WorkerCall = WorkerRequest extends infer R ? R extends { id: number } ? Omit<R, 'id'> : never : never;
