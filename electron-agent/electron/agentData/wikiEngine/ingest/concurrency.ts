// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).
/**
 * concurrency.ts — ingest / global LLM concurrency reads
 * (from MemoryKnowledge src/config.ts getIngestConcurrency / getGlobalLlmConcurrency).
 * 默认读运行时设置（覆盖同名环境变量）；传入自定义 env 时只读该对象，供测试隔离。
 */

import { getConfig, refreshConfig } from '../../../../../extensions/_shared/runtime-config.js';

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

function configured(key: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env !== process.env) return env[key];
  refreshConfig();
  return getConfig(key);
}

/**
 * Per-wiki stage-1 extract concurrency.
 * KNOWLEDGE_WIKI_INGEST_CONCURRENCY, default 3, clamp 1–10.
 */
export function getIngestConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(configured('KNOWLEDGE_WIKI_INGEST_CONCURRENCY', env) ?? '', 10);
  return clamp(Number.isNaN(raw) ? 3 : raw, 1, 10);
}

/**
 * Global LLM concurrency (extract + merge across wikis).
 * KNOWLEDGE_LLM_GLOBAL_CONCURRENCY, default 5, clamp 1–20.
 */
export function getGlobalLlmConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(configured('KNOWLEDGE_LLM_GLOBAL_CONCURRENCY', env) ?? '', 10);
  return clamp(Number.isNaN(raw) ? 5 : raw, 1, 20);
}

/** Wiki 抽取模式。留空或无法识别时为 two-stage。 */
export function getWikiIngestMode(env: NodeJS.ProcessEnv = process.env): 'two-stage' | 'single-stage' {
  return configured('KNOWLEDGE_WIKI_INGEST_MODE', env)?.trim() === 'single-stage' ? 'single-stage' : 'two-stage';
}

/** Refresh one scheduler's budget, retaining active and queued work across changes. */
export function createRefreshingLimit(read: () => number): () => LimitFunction {
  const scheduler = createScheduler(read());
  return () => {
    scheduler.refresh(read());
    return scheduler.limit;
  };
}

/** Minimal p-limit compatible limiter (no extra dependency). */
export type LimitFunction = <T>(fn: () => Promise<T> | T, options?: { signal?: AbortSignal }) => Promise<T>;

export function createLimit(concurrency: number): LimitFunction {
  return createScheduler(concurrency).limit;
}

function createScheduler(concurrency: number): { limit: LimitFunction; refresh(value: number): void } {
  let max = Math.max(1, concurrency);
  let active = 0;
  const queue: Array<{ start(): void; cancel(): void }> = [];

  const drain = () => {
    while (active < max && queue.length > 0) {
      const job = queue.shift()!;
      active += 1;
      job.start();
    }
  };

  const limit: LimitFunction = function<T>(fn: () => Promise<T> | T, options?: { signal?: AbortSignal }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signal = options?.signal;
      const abortError = () => signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (signal?.aborted) { reject(abortError()); return; }
      const job = {
        start: () => {
          signal?.removeEventListener('abort', job.cancel);
          // Keep the slot until fn actually settles, even when its caller aborts.
          Promise.resolve().then(() => {
            if (signal?.aborted) throw abortError();
            return fn();
          }).then(resolve, reject).finally(() => { active -= 1; drain(); });
        },
        cancel: () => {
          const index = queue.indexOf(job);
          if (index < 0) return;
          queue.splice(index, 1);
          signal?.removeEventListener('abort', job.cancel);
          reject(abortError());
        },
      };
      queue.push(job);
      signal?.addEventListener('abort', job.cancel, { once: true });
      drain();
    });
  };
  return { limit, refresh(value) { max = Math.max(1, value); drain(); } };
}
