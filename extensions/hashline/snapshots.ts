// #TAG 计算与 hl_read 渲染。MVP 用「实时磁盘内容」算 tag 做 stale 校验，无需缓存：
//   hl_read 渲染当前内容的 tag；hl_edit 时重新读盘算 tag 与补丁头比对，不一致即拒绝。
import { createHash } from "node:crypto";

// 4-hex 内容快照标签：文件绝对路径 + 内容的 sha1 前 4 位。内容变 → tag 变。
export function computeTag(absPath: string, content: string): string {
  return createHash("sha1").update(absPath).update("\u0000").update(content).digest("hex").slice(0, 4);
}

export interface RenderOptions {
  offset?: number;
  limit?: number;
}

// 渲染 hl_read 输出：[relPath#TAG] 头 + 绝对行号的 `N:TEXT`；窗口外标注省略（不可作锚点）。
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
  const end = opts.limit && opts.limit > 0 ? Math.min(total, start + opts.limit - 1) : total;
  const rows: string[] = [`[${relPath}#${tag}]`];
  if (start > 1) rows.push(`…(前 ${start - 1} 行省略；需要请用 offset 读取，省略区不可作为编辑锚点)`);
  for (let i = start; i <= end; i++) rows.push(`${i}:${lines[i - 1]}`);
  if (end < total) rows.push(`…(后 ${total - end} 行省略)`);
  return rows.join("\n");
}
