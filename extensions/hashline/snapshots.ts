// #TAG 计算与 hl_read 渲染。MVP 用「实时磁盘内容」算 tag 做 stale 校验，无需缓存：
//   hl_read 渲染当前内容的 tag；hl_edit 时重新读盘算 tag 与补丁头比对，不一致即拒绝。
import { createHash } from "node:crypto";
import { READ_MAX_BYTES, READ_MAX_LINES, truncateReadLine } from "../_shared/output-retention.js";

// 4-hex 内容快照标签：文件绝对路径 + 内容的 sha1 前 4 位。内容变 → tag 变。
export function computeTag(absPath: string, content: string): string {
  return createHash("sha1").update(absPath).update("\u0000").update(content).digest("hex").slice(0, 4);
}

export interface RenderOptions {
  offset?: number;
  limit?: number;
}

// 渲染 hl_read 输出：[relPath#TAG] 头 + 绝对行号的 `N:TEXT`；窗口外标注省略（不可作锚点）。
// 单行与总字节按 DSH read 上限截断，避免巨型行把上下文打爆。
export function renderRead(
  relPath: string,
  absPath: string,
  content: string,
  opts: RenderOptions = {},
): string {
  const tag = computeTag(absPath, content);
  const lines = content.split("\n");
  const total = lines.length;
  const start = Math.max(1, opts.offset ?? 1);
  const maxLines = opts.limit && opts.limit > 0 ? opts.limit : READ_MAX_LINES;
  const wantEnd = Math.min(total, start + maxLines - 1);
  const rows: string[] = [`[${relPath}#${tag}]`];
  if (start > 1) rows.push(`…(前 ${start - 1} 行省略；需要请用 offset 读取，省略区不可作为编辑锚点)`);
  let end = start - 1;
  let bytes = 0;
  for (let i = start; i <= wantEnd; i++) {
    const row = `${i}:${truncateReadLine(lines[i - 1] ?? "")}`;
    const add = Buffer.byteLength(row, "utf8") + 1;
    if (bytes + add > READ_MAX_BYTES) break;
    bytes += add;
    rows.push(row);
    end = i;
  }
  if (end < total) {
    rows.push(end < start
      ? `…(内容超过 ${READ_MAX_BYTES} 字节上限，请缩小 offset/limit)`
      : `…(后 ${total - end} 行省略)`);
  }
  return rows.join("\n");
}
