// 子代理的释放边界（重新设计第 3 节建议 1，照 DSH）：每一步单独 try/catch，一步失败不挡后面的步骤，
// 名额照样归还、注册表照样记账、结算通知照样发。失败的步骤汇总成一行日志（带子代理 id 和步骤名）；
// 结算结果仍按子代理自己的结果（用户确认：活已经干完，释放失败模型也处理不了）。

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Teardown {
  private readonly failures: string[] = [];

  constructor(private readonly childId: string) {}

  step(name: string, fn: () => unknown): void {
    try {
      fn();
    } catch (error) {
      this.failures.push(`${name}: ${errorText(error)}`);
    }
  }

  async stepAsync(name: string, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.failures.push(`${name}: ${errorText(error)}`);
    }
  }

  get failed(): readonly string[] {
    return this.failures;
  }

  /** 有失败就写一行日志；没有就什么都不写。 */
  report(): void {
    if (this.failures.length === 0) return;
    console.error(`[multi-agent] sub-agent ${this.childId} teardown failed: ${this.failures.join("; ")}`);
  }
}

/** 不等结果的中断：会话已经空闲、已经关掉时 abort 会拒绝，那不是错误。 */
export function abortQuietly(session: { abort: () => unknown }): void {
  try {
    void Promise.resolve(session.abort()).catch(() => {});
  } catch {
    /* 已经关了 */
  }
}
