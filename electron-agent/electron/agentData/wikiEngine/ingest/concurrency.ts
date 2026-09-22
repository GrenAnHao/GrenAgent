// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).
/**
 * concurrency.ts — ingest / global LLM concurrency reads
 * (from MemoryKnowledge src/config.ts getIngestConcurrency / getGlobalLlmConcurrency).
 */

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Per-wiki stage-1 extract concurrency.
 * KNOWLEDGE_WIKI_INGEST_CONCURRENCY, default 3, clamp 1–10.
 */
export function getIngestConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.KNOWLEDGE_WIKI_INGEST_CONCURRENCY ?? '', 10);
  return clamp(Number.isNaN(raw) ? 3 : raw, 1, 10);
}

/**
 * Global LLM concurrency (extract + merge across wikis).
 * KNOWLEDGE_LLM_GLOBAL_CONCURRENCY, default 5, clamp 1–20.
 */
export function getGlobalLlmConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.KNOWLEDGE_LLM_GLOBAL_CONCURRENCY ?? '', 10);
  return clamp(Number.isNaN(raw) ? 5 : raw, 1, 20);
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
