/**
 * 在会话 JSONL 的原始字节里按标记找行，只把命中的行解码、交给调用方解析。
 *
 * 会话文件动辄十几 MB，绝大部分是工具结果。侧栏只要头一行、标题、首条用户消息、子代理和短调用标记，
 * 整份 UTF-8 解码再逐行 JSON.parse 会在主进程里干耗近一秒。标记必须是纯 ASCII：
 * UTF-8 的多字节序列里不会出现 ASCII 字节，所以按字节搜不会落到某个汉字中间。
 * 标记只是必要条件，命中的行仍要由调用方按原规则判定。
 */

const NEWLINE = 10;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** 头一行（不含换行，去掉行尾 \r）。 */
export function firstLineOf(buffer: Buffer): string {
  const end = buffer.indexOf(NEWLINE);
  return trimCarriageReturn(buffer.toString('utf8', 0, end < 0 ? buffer.length : end));
}

/** 按文件顺序访问每一条含 `marker` 的行；`visit` 返回 true 时停止。 */
export function forEachLineContaining(buffer: Buffer, marker: string, visit: (line: string) => boolean | void): void {
  if (!PRINTABLE_ASCII.test(marker)) throw new Error('marker must be printable ASCII');
  const needle = Buffer.from(marker, 'latin1');
  if (buffer.length === 0) return;
  let from = 0;
  while (from < buffer.length) {
    const hit = buffer.indexOf(needle, from);
    if (hit < 0) return;
    const start = hit === 0 ? 0 : buffer.lastIndexOf(NEWLINE, hit - 1) + 1;
    const newline = buffer.indexOf(NEWLINE, hit + needle.length);
    const end = newline < 0 ? buffer.length : newline;
    if (visit(trimCarriageReturn(buffer.toString('utf8', start, end))) === true) return;
    if (newline < 0) return;
    from = newline + 1;
  }
}

/** 所有含 `marker` 的行，按文件顺序。 */
export function linesContaining(buffer: Buffer, marker: string): string[] {
  const lines: string[] = [];
  forEachLineContaining(buffer, marker, (line) => {
    lines.push(line);
  });
  return lines;
}

function trimCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
