/**
 * codegraph 维护宿主的监督者。
 *
 * 现状：CodeGraphHostClient 按"下一条请求"拉起宿主；纯后台自动同步在宿主退出后
 * 不会有请求来唤醒它，维护就静默停摆。监督者在主进程常驻，检测到宿主不在时自行重拉，
 * 不依赖用户恰好开一次面板。
 *
 * 有意保持保守：
 * - 只在"本应运行"时补拉；用户显式关闭后不再反复拉起；
 * - 指数退避并设上限，连续失败就停手并留痕，不形成崩溃循环；
 * - 重拉本身不重建索引、不改数据。
 */
export interface CodeGraphHostSupervisorOptions {
  /** 宿主的存活状态与拉起动作。 */
  isRunning: () => boolean;
  start: () => Promise<void>;
  /** 是否应当保持运行。用户关闭后返回 false。 */
  shouldRun: () => boolean;
  /** 检查间隔。 */
  intervalMs?: number;
  now?: () => number;
  onRecovered?: (info: { attempt: number; downMs: number }) => void;
  onFailed?: (error: unknown, info: { attempt: number }) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_FAILURES = 10;

export class CodeGraphHostSupervisor {
  private timer?: ReturnType<typeof setInterval>;
  private failures = 0;
  private recovering?: Promise<void>;
  private downSince?: number;
  /** 监督未启动时允许直接 check()（测试与按需调用），但周期定时器仍未装上。 */
  private stopped = false;
  private nextAttemptAt = 0;

  constructor(private readonly options: CodeGraphHostSupervisorOptions) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => { void this.check(); }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 供测试与关停路径直接调用一次检查。 */
  async check(): Promise<void> {
    if (this.stopped || this.recovering) return this.recovering;
    if (!this.options.shouldRun()) return;
    if (this.options.isRunning()) {
      this.downSince = undefined;
      this.failures = 0;
      this.nextAttemptAt = 0;
      return;
    }
    const now = this.options.now?.() ?? Date.now();
    if (now < this.nextAttemptAt) return;
    this.downSince ??= now;
    const attempt = this.failures + 1;
    this.recovering = (async () => {
      try {
        await this.options.start();
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.options.onRecovered?.({ attempt, downMs: now - (this.downSince ?? now) });
        this.downSince = undefined;
      } catch (error) {
        this.failures += 1;
        const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.failures - 1));
        const base = this.options.now?.() ?? Date.now();
        this.nextAttemptAt = base + backoff;
        this.options.onFailed?.(error, { attempt: this.failures });
        if (this.failures >= MAX_FAILURES) {
          // 停手：不再拉进程，但仍保留状态供诊断查看。重新 start() 会清零。
          this.stopped = true;
          if (this.timer) clearInterval(this.timer);
          this.timer = undefined;
        }
      } finally {
        this.recovering = undefined;
      }
    })();
    return this.recovering;
  }
}
