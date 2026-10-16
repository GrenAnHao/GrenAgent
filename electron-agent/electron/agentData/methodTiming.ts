/**
 * AgentData 在本进程事件循环上占用的同步时间，按方法累计；runtime-diag 每 10 秒取走一次，写进 sample.agentData。
 *
 * 只记同步段：方法被调用到它返回（或返回 promise）为止，加上应答的序列化与写出。async 方法 await 之后的续体
 * 不在其中；已知会在续体里做重活的地方（Wiki 索引重建、记忆定时器、任务队列结算、CodeGraph 查询）在调用点单独计时。
 * 段可以嵌套（例如 wiki.pageWrite 里的 wiki.rebuildPageIndex）：嵌套段照常进方法行，但不重复计入窗口合计。
 */

const TOP_METHODS = 15;
const SLOW_MS = 50;
const SLOW_CAP = 20;
const MAX_KEYS = 200;
const OVERFLOW_KEY = '(other)';

interface Stat { n: number; syncMs: number; syncMaxMs: number; totalMs: number; totalMaxMs: number; timed: number }

export interface AgentDataTimingRow {
  method: string;
  n: number;
  syncMs: number;
  syncMaxMs: number;
  /** 含 await 的端到端耗时；只有请求类入口才有。 */
  totalMs?: number;
  totalMaxMs?: number;
}

export interface AgentDataSlowSegment { method: string; syncMs: number; at: number; nested?: true }

export interface AgentDataTimingSample {
  /** 顶层同步段的合计（嵌套段不重复计）。 */
  syncMs: number;
  n: number;
  methods: AgentDataTimingRow[];
  /** 单次同步段 ≥ 50ms 的记录，最多 20 条，取最慢的。 */
  slow: AgentDataSlowSegment[];
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

export class AgentDataTiming {
  private stats = new Map<string, Stat>();
  private slow: AgentDataSlowSegment[] = [];
  private topSyncMs = 0;
  private topN = 0;
  private depth = 0;

  constructor(private readonly clock: { now(): number; wall(): number } = { now: () => performance.now(), wall: () => Date.now() }) {}

  /** 开始一段同步执行，返回结束函数（返回本段毫秒数，重复调用只结束一次）。段不能跨 await。 */
  start(): () => number {
    const begun = this.clock.now();
    this.depth += 1;
    let elapsed: number | undefined;
    return () => {
      if (elapsed === undefined) {
        elapsed = this.clock.now() - begun;
        this.depth -= 1;
      }
      return elapsed;
    };
  }

  /** 当前是否处在另一段同步计时里。 */
  get nested(): boolean { return this.depth > 0; }

  record(method: string, syncMs: number, options: { totalMs?: number; nested?: boolean } = {}): void {
    const label = method.length > 80 ? method.slice(0, 80) : method;
    const key = this.stats.has(label) || this.stats.size < MAX_KEYS ? label : OVERFLOW_KEY;
    const stat = this.stats.get(key) ?? { n: 0, syncMs: 0, syncMaxMs: 0, totalMs: 0, totalMaxMs: 0, timed: 0 };
    stat.n += 1;
    stat.syncMs += syncMs;
    stat.syncMaxMs = Math.max(stat.syncMaxMs, syncMs);
    if (options.totalMs !== undefined) {
      stat.timed += 1;
      stat.totalMs += options.totalMs;
      stat.totalMaxMs = Math.max(stat.totalMaxMs, options.totalMs);
    }
    this.stats.set(key, stat);
    if (!options.nested) {
      this.topSyncMs += syncMs;
      this.topN += 1;
    }
    if (syncMs >= SLOW_MS) {
      this.slow.push({ method: key, syncMs: round(syncMs), at: this.clock.wall(), ...(options.nested ? { nested: true as const } : {}) });
      if (this.slow.length > SLOW_CAP) {
        this.slow.sort((a, b) => b.syncMs - a.syncMs);
        this.slow.length = SLOW_CAP;
      }
    }
  }

  /** 取走本窗口的统计并清零；窗口里什么都没发生时返回 undefined。 */
  drain(): AgentDataTimingSample | undefined {
    if (this.stats.size === 0) return undefined;
    const methods = [...this.stats.entries()]
      .map(([method, s]): AgentDataTimingRow => ({
        method, n: s.n, syncMs: round(s.syncMs), syncMaxMs: round(s.syncMaxMs),
        ...(s.timed ? { totalMs: round(s.totalMs), totalMaxMs: round(s.totalMaxMs) } : {}),
      }))
      .sort((a, b) => b.syncMs - a.syncMs)
      .slice(0, TOP_METHODS);
    const sample: AgentDataTimingSample = {
      syncMs: round(this.topSyncMs),
      n: this.topN,
      methods,
      slow: [...this.slow].sort((a, b) => b.syncMs - a.syncMs),
    };
    this.stats = new Map();
    this.slow = [];
    this.topSyncMs = 0;
    this.topN = 0;
    return sample;
  }

  /** 给一段同步调用计时；fn 返回 promise 时只记到它返回为止。异常照常抛出。 */
  timeSync<T>(method: string, fn: () => T): T {
    const stop = this.start();
    try {
      return fn();
    } finally {
      const ms = stop();
      this.record(method, ms, { nested: this.nested });
    }
  }
}

/** 进程内单例：AgentData 在哪个进程里运行，就由那个进程的诊断取走。 */
export const agentDataTiming = new AgentDataTiming();

export function timeSync<T>(method: string, fn: () => T): T {
  return agentDataTiming.timeSync(method, fn);
}
