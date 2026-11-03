/**
 * 读请求的排队与背压。队满立刻拒绝，不排进去等；同一工作区同时占用的读线程不超过读池的一半（向上取整）。
 * 超时从入队起算，排队中的到点移除；已经开始的由调用方按 lease.deadline 停掉。
 * 见 .agents/notes/implemented/architecture/2026-10-27-codegraph-catchup-and-read-limits.md。
 */

export const READ_BUSY = 'CODEGRAPH_BUSY';
export const READ_TIMEOUT = 'CODEGRAPH_TIMEOUT';

export interface ReadLease {
  /** 入队时刻。运行中的超时用 deadline - now，把排队花掉的时间算进去。 */
  enqueuedAt: number;
  deadline: number;
  release(): void;
}

export interface ReadAdmissionOptions {
  readers: number;
  /** 排队上限。默认 32。已经在跑的不算。 */
  maxQueued?: number;
  /** 从入队到必须结束的时间。默认 30 秒。 */
  timeoutMs?: number;
  /** 队满时写进错误里的重试间隔。 */
  retryAfterMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Pending {
  key: string;
  enqueuedAt: number;
  timer: unknown;
  resolve: (lease: ReadLease) => void;
  reject: (error: Error) => void;
}

export function readBusyError(retryAfterMs: number): Error {
  const error = new Error(`${READ_BUSY}: codegraph read queue is full, retry after ${retryAfterMs}ms`);
  (error as NodeJS.ErrnoException).code = READ_BUSY;
  return error;
}

export function readTimeoutError(): Error {
  const error = new Error(`${READ_TIMEOUT}: codegraph read timed out`);
  (error as NodeJS.ErrnoException).code = READ_TIMEOUT;
  return error;
}

/** 同一工作区、同一调用、同一代索引的并发读共用这一次执行。状态查询不单飞。 */
export function readFlightKey(key: string, call: { op: string; tool?: string; args?: unknown; query?: string; limit?: number }, generation: number): string | undefined {
  if (call.op === 'call') return `call\0${key}\0${call.tool ?? ''}\0${stable(call.args)}\0${generation}`;
  if (call.op === 'search') return `search\0${key}\0${call.query ?? ''}\0${call.limit ?? ''}\0${generation}`;
  return undefined;
}

export class ReadAdmission {
  private readonly running = new Map<string, number>();
  private readonly queue: Pending[] = [];
  private total = 0;
  private closed = false;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ReadAdmissionOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** 正在跑的加上还在排队的。测试用来确认没有超过上限。 */
  get queued(): number { return this.queue.length; }

  acquire(key: string): Promise<ReadLease> {
    if (this.closed) return Promise.reject(new Error('CodeGraph engine is closed'));
    if (this.canStart(key)) return Promise.resolve(this.grant(key, this.now()));
    const maxQueued = this.options.maxQueued ?? 32;
    if (this.queue.length >= maxQueued) return Promise.reject(readBusyError(this.options.retryAfterMs ?? 1_000));
    return new Promise((resolve, reject) => {
      const item: Pending = { key, enqueuedAt: this.now(), timer: undefined, resolve, reject };
      item.timer = this.setTimer(() => this.expire(item), this.timeoutMs());
      this.queue.push(item);
    });
  }

  close(): void {
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      this.clearTimer(item.timer);
      item.reject(new Error('CodeGraph engine is closed'));
    }
  }

  private timeoutMs(): number { return this.options.timeoutMs ?? 30_000; }

  /** 全局不超过读线程数；每个工作区不超过一半（向上取整），避免一个大项目占满读池。 */
  private cap(): number { return Math.max(1, Math.ceil(Math.max(1, this.options.readers) / 2)); }

  private canStart(key: string): boolean {
    return this.total < Math.max(1, this.options.readers) && (this.running.get(key) ?? 0) < this.cap();
  }

  private grant(key: string, enqueuedAt: number): ReadLease {
    this.total += 1;
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    let released = false;
    return {
      enqueuedAt,
      deadline: enqueuedAt + this.timeoutMs(),
      release: () => {
        if (released) return;
        released = true;
        this.total -= 1;
        const left = (this.running.get(key) ?? 1) - 1;
        if (left <= 0) this.running.delete(key);
        else this.running.set(key, left);
        this.pump();
      },
    };
  }

  private expire(item: Pending): void {
    const index = this.queue.indexOf(item);
    if (index < 0) return;
    this.queue.splice(index, 1);
    item.reject(readTimeoutError());
  }

  /** 队首如果被工作区上限挡住，后面别的工作区仍然可以开始。 */
  private pump(): void {
    const kept: Pending[] = [];
    for (const item of this.queue.splice(0)) {
      if (!this.canStart(item.key)) { kept.push(item); continue; }
      this.clearTimer(item.timer);
      item.resolve(this.grant(item.key, item.enqueuedAt));
    }
    this.queue.push(...kept);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
