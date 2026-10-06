export class ShortCallQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs = 30_000): Promise<T> {
    const run = this.tail.then(() => this.withTimeout(fn, timeoutMs));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 记忆任务对齐上游：L1 / 去重 / L3 180s（l1-extractor.ts:518、l1-dedup.ts:167、persona-generator.ts:207），L2 300s（scene-extractor.ts:118）。 */
export const KIND_TIMEOUT_MS: Record<string, number> = {
  goal_judge: 60_000,
  wiki_page_generate: 60_000,
  memory_extract: 180_000,
  memory_deduplicate: 180_000,
  memory_scene: 300_000,
  memory_persona: 180_000,
};

export function timeoutForKind(kind: string, fallback = 30_000): number {
  return KIND_TIMEOUT_MS[kind] ?? fallback;
}
