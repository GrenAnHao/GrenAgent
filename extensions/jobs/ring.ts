// 移植自 DSH packages/jobs/jobs-local/src/ring.ts：一个 job 的有界输出环。
// 块按绝对字节偏移存放，头部淘汰从不移动已分配的偏移，可从任意偏移非消耗读取。
import type { JobAppendOptions, JobChannel, JobOutputRead } from "./types.js";

interface RingChunk {
  at: number;
  text: string;
  bytes: number;
  channel?: JobChannel;
  gapBefore?: true;
}

/** text 不超过 maxBytes 的 UTF-8 安全尾部：切点跳过续字节，不会从码点中间开始。 */
export function utf8Tail(text: string, maxBytes: number): { text: string; bytes: number } {
  const raw = Buffer.from(text, "utf8");
  let start = Math.max(0, raw.length - maxBytes);
  while (start < raw.length && ((raw[start] as number) & 0xc0) === 0x80) start += 1;
  const tail = raw.subarray(start);
  return { text: tail.toString("utf8"), bytes: tail.length };
}

export class OutputRing {
  private readonly chunks: RingChunk[] = [];
  /** 保留块的字节和。 */
  retainedBytes = 0;
  /** 累计追加的 UTF-8 字节，即下一块的起始偏移。 */
  total = 0;
  /** 最早保留字节的偏移（什么都没保留时等于 total）。 */
  earliest = 0;

  /** 追加一块并把头部裁到 cap；空块不改变任何东西，返回 false。 */
  append(text: string, options: JobAppendOptions | undefined, cap: number): boolean {
    if (text.length === 0) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    this.chunks.push({
      at: this.total,
      text,
      bytes,
      ...(options?.channel !== undefined ? { channel: options.channel } : {}),
      ...(options?.gapBefore !== undefined ? { gapBefore: options.gapBefore } : {}),
    });
    this.total += bytes;
    this.retainedBytes += bytes;
    this.trim(cap);
    return true;
  }

  /** 丢弃头部整块直到装进 cap；单个超限块只留 UTF-8 安全尾部并标 gapBefore。 */
  trim(cap: number): void {
    while (this.retainedBytes > cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped === undefined) break;
      this.retainedBytes -= dropped.bytes;
    }
    const single = this.chunks.length === 1 ? this.chunks[0] : undefined;
    if (single !== undefined && single.bytes > cap) {
      const tail = utf8Tail(single.text, cap);
      single.at += single.bytes - tail.bytes;
      single.text = tail.text;
      single.bytes = tail.bytes;
      single.gapBefore = true;
      this.retainedBytes = tail.bytes;
    }
    this.earliest = this.chunks[0]?.at ?? this.total;
  }

  /** 与 [from, total) 重叠的保留块（新对象）。 */
  readFrom(from: number): JobOutputRead {
    const chunks = [];
    for (const chunk of this.chunks) {
      if (chunk.at + chunk.bytes <= from) continue;
      chunks.push({
        at: chunk.at,
        text: chunk.text,
        ...(chunk.channel !== undefined ? { channel: chunk.channel } : {}),
        ...(chunk.gapBefore !== undefined ? { gapBefore: chunk.gapBefore } : {}),
      });
    }
    return { chunks, next: this.total, lossy: from < this.earliest };
  }
}
