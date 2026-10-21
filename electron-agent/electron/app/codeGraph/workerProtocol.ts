/**
 * codegraph-host 主线程 ↔ SDK 工作线程的消息。主线程只调度，SDK 只在工作线程里加载。
 * 一个写线程跑 plan / runSync / watch，若干读线程跑 status / call / search；同一工作区的读写由主线程排开。
 */
import type { IndexProgress } from '@colbymchenry/codegraph';
import type { CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { WireError } from '../../agentProcess/rpcPeer';
import type { SyncMode, SyncPlan } from './codeGraphEngine';

export type WorkerRole = 'read' | 'write';

export type WorkerRequest =
  | { id: number; op: 'status'; workspace: string }
  | { id: number; op: 'call'; workspace: string; tool: CodeRetrievalTool; args: Record<string, unknown> }
  | { id: number; op: 'search'; workspace: string; query: string; limit: number }
  | { id: number; op: 'plan'; workspace: string }
  | { id: number; op: 'runSync'; jobId: string; workspace: string; mode?: SyncMode; paths?: string[] }
  | { id: number; op: 'cancelSync'; jobId: string }
  | { id: number; op: 'evict'; workspace: string }
  /** 读线程：之后的读换一条新连接（SDK 的 nodeCache 不会跟着别的连接写入失效），旧连接等手上的读结束再关。 */
  | { id: number; op: 'refresh'; workspace: string }
  /** 写线程：给工作区挂 SDK FileWatcher，只当事件源用，改动经 changed 消息交给主线程的调度器。 */
  | { id: number; op: 'watch'; workspace: string; debounceMs: number }
  | { id: number; op: 'unwatch'; workspace: string }
  | { id: number; op: 'close' };

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: WireError }
  | { type: 'progress'; jobId: string; progress: IndexProgress }
  /** paths 为 null：改动范围说不清（目录删除、忽略规则变了），下一次同步要整棵树对一遍。 */
  | { type: 'changed'; workspace: string; paths: string[] | null }
  | { type: 'watchDegraded'; workspace: string; reason: string };

/** 不带 id 的请求体（调度方补 id）。 */
export type WorkerCall = WorkerRequest extends infer R ? R extends { id: number } ? Omit<R, 'id'> : never : never;

export type { SyncMode, SyncPlan };
