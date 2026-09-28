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

/** 每次取用时重读并发；数值变了就换一个新的限流器，进行中的调用仍用旧限流器。 */
export function createRefreshingLimit(read: () => number): () => LimitFunction {
  let concurrency = read();
  let limit = createLimit(concurrency);
  return () => {
    const next = read();
    if (next !== concurrency) {
      concurrency = next;
      limit = createLimit(next);
    }
    return limit;
  };
}

/** Minimal p-limit compatible limiter (no extra dependency). */
export type LimitFunction = <T>(fn: () => Promise<T> | T) => Promise<T>;

export function createLimit(concurrency: number): LimitFunction {
  const max = Math.max(1, concurrency);
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= max) return;
    const job = queue.shift();
    if (!job) return;
    active += 1;
    job();
  };

  return function limit<T>(fn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}
