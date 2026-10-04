import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL_TEXT_MAX_BYTES = 20480;
const HEAD_BYTES = 8000;
const TAIL_BYTES = 8000;

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export interface McpRawCallToolResult {
  content?: McpContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ShapedMcpResult {
  content: McpContentBlock[];
  isError: boolean;
  structuredContent: {
    content: McpContentBlock[];
    isError: boolean;
    structuredContent?: unknown;
  };
}

function utf8HeadSlice(buf: Buffer, maxBytes: number): { end: number; text: string } {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { end, text: buf.subarray(0, end).toString("utf8") };
}

function utf8TailSlice(buf: Buffer, maxBytes: number): { start: number; text: string } {
  let start = Math.max(0, buf.length - maxBytes);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return { start, text: buf.subarray(start).toString("utf8") };
}

function truncateModelTextUtf8(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= MODEL_TEXT_MAX_BYTES) return text;

  const { end: headEnd, text: head } = utf8HeadSlice(buf, HEAD_BYTES);
  const { start: tailStart, text: tail } = utf8TailSlice(buf, TAIL_BYTES);
  const removed = Math.max(0, tailStart - headEnd);
  const marker = `…截掉 ${removed} 字节…`;
  return head + marker + tail;
}

function writeFullModelText(fullModelText: string): string {
  const path = join(tmpdir(), `mcp-result-${randomBytes(8).toString("hex")}`);
  writeFileSync(path, fullModelText, "utf8");
  return path;
}

export function shapeMcpResult(raw: McpRawCallToolResult): ShapedMcpResult {
  const rawContent = raw.content ?? [];
  const isError = raw.isError === true;
  const structuredContent = {
    content: rawContent,
    isError,
    structuredContent: raw.structuredContent,
  };

  const nonTextBlocks = rawContent.filter((b) => b.type !== "text");
  const textBlocks = rawContent.filter((b): b is { type: "text"; text: string } => b.type === "text");
  const fullModelText = textBlocks.map((b) => b.text).join("\n");

  if (textBlocks.length === 0) {
    return {
      content: [{ type: "text", text: "" }],
      isError,
      structuredContent,
    };
  }

  const savedPath = writeFullModelText(fullModelText);
  const withPath = `${fullModelText}\n全文: ${savedPath}`;
  const displayText = truncateModelTextUtf8(withPath);

  return {
    content: [{ type: "text", text: displayText }, ...nonTextBlocks],
    isError,
    structuredContent,
  };
}
