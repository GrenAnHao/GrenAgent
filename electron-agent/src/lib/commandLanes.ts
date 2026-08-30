export interface CommandLanes {
  /** 在 sessionKey 串行 + 全局并发上限约束下执行 fn，返回其结果。 */
  run: <T>(sessionKey: string, fn: () => Promise<T>) => Promise<T>;
}

export function createCommandLanes(opts: { globalConcurrency: number }): CommandLanes {
  const sessionTail = new Map<string, Promise<unknown>>(); // 每会话串行链尾
  let globalActive = 0;
  const globalWaiters: Array<() => void> = [];

  const acquireGlobal = (): Promise<void> => {
    if (globalActive < opts.globalConcurrency) {
      globalActive++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => globalWaiters.push(resolve)).then(() => {
      globalActive++;
    });
  };

  const releaseGlobal = () => {
    globalActive--;
    const next = globalWaiters.shift();
    if (next) next();
  };

  const run = <T>(sessionKey: string, fn: () => Promise<T>): Promise<T> => {
    const prev = sessionTail.get(sessionKey) ?? Promise.resolve();
    const task = prev
      .catch(() => {}) // 前一个失败不阻断后续
      .then(async () => {
        await acquireGlobal();
        try {
          return await fn();
        } finally {
          releaseGlobal();
        }
      });
    // 链尾推进（忽略结果/异常，仅用于串行）
    sessionTail.set(
      sessionKey,
      task.catch(() => {}),
    );
    return task;
  };

  return { run };
}

/** 全局单例：阶段 A 默认全局并发上限（可后续接入 settings）。 */
export const commandLanes = createCommandLanes({ globalConcurrency: 3 });
