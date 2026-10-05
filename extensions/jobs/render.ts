// 移植自 DSH packages/jobs/tool-jobs/src/render.ts 与 tool-jobs/src/index.ts 的上限裁剪：
// 消耗式读取按 shell 工具一贯的样子渲染（stdout 在前，stderr 合成一段 [stderr]），状态行，丢失输出提示。
import type { JobChunk, JobSnapshot } from "./types.js";

/** 状态旁的一行限定：运行中是进度行，结算后是终态原因。 */
export function jobDetail(job: Pick<JobSnapshot, "progress" | "detail">): string | undefined {
  return job.progress ?? job.detail;
}

export function statusLine(job: Pick<JobSnapshot, "status" | "progress" | "detail">): string {
  const detail = jobDetail(job);
  return detail !== undefined ? `[status: ${job.status}, ${detail}]` : `[status: ${job.status}]`;
}

/**
 * 一次消耗式读取给模型的样子：stdout 与无标签块按序，stderr 全部放进一段 `[stderr]`；
 * `log` 块只给观察者。游标落后于保留窗口、或可见块带生产方 gap 时，末尾点名 spill 文件。
 */
export function renderModelDelta(chunks: readonly JobChunk[], lossy: boolean, spillPaths: readonly string[]): string {
  const visible = chunks.filter((chunk) => chunk.channel !== "log");
  const out = visible.filter((chunk) => chunk.channel !== "stderr").map((chunk) => chunk.text).join("");
  const err = visible.filter((chunk) => chunk.channel === "stderr").map((chunk) => chunk.text).join("");
  const separator = out.length > 0 && !out.endsWith("\n") ? "\n" : "";
  const body = out + (err.length > 0 ? `${separator}[stderr]\n${err}` : "");
  if (!lossy && !visible.some((chunk) => chunk.gapBefore === true)) return body;
  const notice = `[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(", ") : "(unavailable)"}]`;
  return `${body}${body.length > 0 && !body.endsWith("\n") ? "\n" : ""}${notice}`;
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** 不超过 maxBytes 的 UTF-8 安全尾部。 */
export function retainTail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const raw = Buffer.from(text, "utf8");
  if (raw.length <= maxBytes) return text;
  let start = raw.length - maxBytes;
  while (start < raw.length && ((raw[start] as number) & 0xc0) === 0x80) start += 1;
  return raw.subarray(start).toString("utf8");
}

/** 不超过 maxBytes 的 UTF-8 安全头部。 */
export function retainHead(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const raw = Buffer.from(text, "utf8");
  if (raw.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((raw[end] as number) & 0xc0) === 0x80) end -= 1;
  return raw.subarray(0, end).toString("utf8");
}

/**
 * content + suffix 装进 maxBytes：先给固定的省略标记和 suffix 留位，剩下的保留 content 尾部。
 * 构建日志的结论在末尾，所以裁头不裁尾。
 */
export function fitWithSuffix(content: string, suffix: string, maxBytes: number | undefined, omitted: string): string {
  const complete = `${content}${suffix}`;
  if (maxBytes === undefined || byteLength(complete) <= maxBytes) return complete;
  const fixed = `${content.endsWith(omitted.trimStart()) ? "" : omitted}${suffix}`;
  const fixedBytes = byteLength(fixed);
  if (fixedBytes >= maxBytes) return retainTail(fixed, maxBytes);
  return `${retainTail(content, maxBytes - fixedBytes)}${fixed}`;
}
