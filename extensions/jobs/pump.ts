// 移植自 DSH packages/jobs/jobs-local/src/pump.ts：注册表自有的拉取泵。
// 按固定节奏把 job 的拉取源复制进输出环，生产方结算后再排干一次，环在结算裁剪前拿到每个字节。
// lossy 读取落成 gap 块；源报告的 spill 文件每次读取都转给 sink，因为这个引用比任何块活得久。
import type { JobAppendOptions, JobOutputSource } from "./types.js";

export interface PumpHandle {
  /** 最后一次排干后 resolve。 */
  done: Promise<void>;
}

export interface PumpSink {
  append(text: string, options?: JobAppendOptions): void;
  /** 记录第 index 个源最近一次读取报告的 spill 文件；不报则为 undefined。 */
  spill(index: number, path: string | undefined): void;
}

/**
 * 按数组顺序排干每个源，睡 pollMs 或直到 until 结算，循环，最后再排干一次。
 * 一次 poll 窗口内两个源产出的字节按源顺序落环，不按写入顺序：环是尽力而为的实时视图。
 * 无论 job 跑多久，只订阅一次 until、同时只挂一个定时器。
 */
export function startPump(
  sources: readonly JobOutputSource[],
  sink: PumpSink,
  pollMs: number,
  until: PromiseLike<unknown>,
): PumpHandle {
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`invalid pump pollMs: expected a positive finite number of milliseconds, got ${JSON.stringify(pollMs)}`);
  }
  const states = sources.map((source) => ({ source, cursor: 0 }));
  const drain = (): void => {
    for (const [index, state] of states.entries()) {
      const { source } = state;
      const read = source.read(state.cursor);
      state.cursor = read.nextOffset;
      sink.spill(index, read.spillPath);
      if (read.text.length === 0) continue;
      if (source.channel === undefined && !read.lossy) {
        sink.append(read.text);
      } else {
        sink.append(read.text, {
          ...(source.channel !== undefined ? { channel: source.channel } : {}),
          ...(read.lossy ? { gapBefore: true as const } : {}),
        });
      }
    }
  };
  const done = (async (): Promise<void> => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      wake?.();
    };
    void until.then(finish, finish);
    while (!settled) {
      drain();
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, pollMs);
      });
      wake = undefined;
      timer = undefined;
    }
    drain();
  })();
  return { done };
}
