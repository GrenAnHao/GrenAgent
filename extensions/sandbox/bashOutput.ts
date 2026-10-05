// 一条 bash 命令的输出累积器。
// 前台显示部分照抄 pi 1.0.2 的 dist/core/tools/output-accumulator.js：滚动尾部、行数统计、
// 超过 2000 行或 50KB 就把原始字节写进临时文件、readFullOutput 给 codemode 结构化结果。截断算法直接用 pi 导出的 truncateTail。
// 另加一个按绝对字节偏移的保留窗口（readFrom），作为 jobs 注册表的拉取源：
// 同一份输出既喂前台卡片的流式更新，也喂后台 job 的输出环。
// 升级 pi 时对照 output-accumulator.js 的 diff 决定是否跟进。
import { randomBytes } from "node:crypto";
import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail, type TruncationResult } from "@earendil-works/pi-coding-agent";
import type { JobSourceRead } from "../jobs/types.js";

/** 给 jobs 拉取源保留的窗口。注册表自己的环另有上限，这里只要盖住一个泵周期的突发。 */
const DEFAULT_WINDOW_BYTES = 1024 * 1024;

export interface BashOutputOptions {
  maxLines?: number;
  maxBytes?: number;
  windowBytes?: number;
  tempFilePrefix?: string;
  tempDir?: string;
  /** 一开始就建临时文件（后台命令要在开始结果里给出日志路径）。 */
  eagerFile?: boolean;
}

export interface BashTruncation extends TruncationResult {
  truncated: boolean;
}

export interface BashSnapshot {
  content: string;
  truncation: BashTruncation;
  fullOutputPath: string | undefined;
}

interface WindowChunk {
  at: number;
  text: string;
  bytes: number;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

export class BashOutput {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly windowBytes: number;
  private readonly tempFilePrefix: string;
  private readonly tempDir: string;
  private readonly decoder = new TextDecoder();
  private finished = false;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private hasOpenLine = false;
  private totalLines = 0;
  private currentLineBytes = 0;
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private rawChunks: Buffer[] = [];
  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;
  private tempFileFailed = false;
  private readonly window: WindowChunk[] = [];
  private windowRetained = 0;
  private windowEarliest = 0;

  constructor(options: BashOutputOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
    this.tempFilePrefix = options.tempFilePrefix ?? "pi-bash";
    this.tempDir = options.tempDir ?? tmpdir();
    if (options.eagerFile) this.ensureTempFile();
  }

  /** 完整输出文件；只在截断后（或 eagerFile）才有。 */
  get fullOutputPath(): string | undefined {
    return this.tempFilePath;
  }

  /** 已解码字节总数，也是下一次 readFrom 的续读偏移。 */
  get total(): number {
    return this.totalDecodedBytes;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** 结束后到达的字节丢弃：被取消的进程树在 taskkill 生效前还可能写几行。 */
  append(data: Buffer): void {
    if (this.finished) return;
    this.totalRawBytes += data.length;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));
    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldUseTempFile()) this.ensureTempFile();
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): BashSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), { maxLines: this.maxLines, maxBytes: this.maxBytes });
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncatedBy = truncated
      ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
      : null;
    const truncation: BashTruncation = {
      ...tailTruncation,
      truncated,
      truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    if (options.persistIfTruncated && truncation.truncated) this.ensureTempFile();
    return { content: truncation.content, truncation, fullOutputPath: this.tempFilePath };
  }

  /** 非消耗的偏移读取（jobs 拉取源）。偏移按已解码 UTF-8 字节计。 */
  readFrom(fromByte: number): JobSourceRead {
    const lossy = fromByte < this.windowEarliest;
    const from = Math.max(fromByte, this.windowEarliest);
    let text = "";
    for (const chunk of this.window) {
      if (chunk.at + chunk.bytes <= from) continue;
      text += chunk.at >= from ? chunk.text : Buffer.from(chunk.text, "utf-8").subarray(from - chunk.at).toString("utf-8");
    }
    return {
      text,
      nextOffset: this.totalDecodedBytes,
      lossy,
      ...(this.tempFilePath && !this.tempFileFailed ? { spillPath: this.tempFilePath } : {}),
    };
  }

  async closeTempFile(): Promise<void> {
    const stream = this.tempFileStream;
    if (!stream) return;
    this.tempFileStream = undefined;
    await new Promise<void>((resolve) => {
      stream.once("error", () => resolve());
      stream.end(() => resolve());
    });
  }

  /**
   * 完整输出，给 codemode 结构化结果。先 finish() 再 closeTempFile()。
   * 超过 maxBytes 原始字节时保留首尾各一半，中间放省略标记。
   */
  async readFullOutput(maxBytes: number): Promise<{ content: string; truncated: boolean }> {
    if (!this.tempFilePath || this.tempFileFailed) {
      return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
    }
    const file = await open(this.tempFilePath, "r");
    try {
      const size = (await file.stat()).size;
      if (size <= maxBytes) return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
      const headBytes = Math.floor(maxBytes / 2);
      const tailBytes = maxBytes - headBytes;
      const head = Buffer.alloc(headBytes);
      const tail = Buffer.alloc(tailBytes);
      await file.read(head, 0, headBytes, 0);
      await file.read(tail, 0, tailBytes, size - tailBytes);
      const headText = new TextDecoder().decode(head, { stream: true });
      let tailStart = 0;
      while (tailStart < tail.length && ((tail[tailStart] as number) & 0xc0) === 0x80) tailStart++;
      const tailText = new TextDecoder().decode(tail.subarray(tailStart));
      const omitted = size - headBytes - tailBytes;
      return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
    } finally {
      await file.close();
    }
  }

  getLastLineBytes(): number {
    return this.currentLineBytes;
  }

  private appendDecodedText(text: string): void {
    if (text.length === 0) return;
    const bytes = byteLength(text);
    this.window.push({ at: this.totalDecodedBytes, text, bytes });
    this.windowRetained += bytes;
    while (this.windowRetained > this.windowBytes && this.window.length > 1) {
      const dropped = this.window.shift()!;
      this.windowRetained -= dropped.bytes;
    }
    this.totalDecodedBytes += bytes;
    this.windowEarliest = this.window[0]?.at ?? this.totalDecodedBytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();
    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }
    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && ((buffer[start] as number) & 0xc0) === 0x80) start++;
    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  private shouldUseTempFile(): boolean {
    return this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines;
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;
    this.tempFilePath = join(this.tempDir, `${this.tempFilePrefix}-${randomBytes(8).toString("hex")}.log`);
    try {
      // 同步建文件：路径一报给模型 / 用户就能打开，createWriteStream 自己是异步打开的。
      writeFileSync(this.tempFilePath, "");
      this.tempFileStream = createWriteStream(this.tempFilePath, { flags: "a" });
      this.tempFileStream.on("error", () => {
        this.tempFileFailed = true;
      });
      for (const chunk of this.rawChunks) this.tempFileStream.write(chunk);
      this.rawChunks = [];
    } catch {
      this.tempFileFailed = true;
    }
  }
}
