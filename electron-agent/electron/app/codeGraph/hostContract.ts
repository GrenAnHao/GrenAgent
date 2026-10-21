/**
 * 主进程 ↔ codegraph-host 子进程的方法与事件名。两边只从这里取名字，增删必须同改。
 * 见 .agents/notes/implemented/architecture/2026-10-16-codegraph-host-process.md。
 */
import type { IndexProgress } from '@colbymchenry/codegraph';
import type { SyncEvent } from './syncScheduler';

export const CODEGRAPH_HOST_METHODS = [
  'codegraph.status',
  'codegraph.call',
  'codegraph.search',
  'codegraph.runSync',
  'codegraph.cancelSync',
] as const;
export type CodeGraphHostMethod = (typeof CODEGRAPH_HOST_METHODS)[number];

/** 子进程 → 主进程：某个同步任务的进度。 */
export const CODEGRAPH_PROGRESS_CHANNEL = 'codegraph.progress';
export interface CodeGraphProgressEvent { jobId: string; progress: IndexProgress }

/** 子进程 → 主进程：每 10 秒一次的内存与事件循环延迟，主进程写进 runtime-diag.jsonl（kind: 'codegraph-host-sample'）。 */
export const CODEGRAPH_DIAG_CHANNEL = 'codegraph.diag';
export interface CodeGraphDiagSample {
  memory: { rss: number; heapUsed: number; heapTotal: number; heapLimit: number };
  lag: { maxMs: number; p99Ms: number; meanMs: number };
  /** 这 10 秒末仍在跑的同步任务数。 */
  syncing: number;
}

/**
 * 子进程 → 主进程：同步失败（failed）、连续失败熔断（breaker）、被别的进程占锁超过 5 分钟（locked）。
 * 自动同步成功不建 job 也不发事件；失败必须留痕，主进程写进 runtime-diag.jsonl（kind: 'codegraph-sync-event'）。
 */
export const CODEGRAPH_SYNC_EVENT_CHANNEL = 'codegraph.syncEvent';
export type CodeGraphSyncEvent = SyncEvent;
