import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** 追加一行。当前大小加上这行的字节数超过 5MB 时，把原文件改名为 path.1 再从头写。 */
export function appendCappedLog(path: string, line: string): void {
  let size: number | undefined;
  try {
    size = statSync(path).size;
  } catch {
    size = undefined;
  }
  if (size !== undefined && size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
    const rotated = `${path}.1`;
    rmSync(rotated, { force: true });
    renameSync(path, rotated);
    writeFileSync(path, line);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line);
}
