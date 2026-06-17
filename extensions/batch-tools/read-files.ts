// read_files：一次读多个文件/多行范围，合并一条结果。纯函数(normalizeFiles/
// looksBinary/sliceLines) + 工具壳(registerReadFiles)。
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { formatReadResult, type ReadSegment } from "./format.js";

export interface FileReq {
  path: string;
  offset?: number;
  limit?: number;
}

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".tar", ".gz", ".7z",
  ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".wasm", ".bin", ".dat", ".o", ".a",
  ".lib", ".pyc", ".woff", ".woff2", ".ttf", ".mp4", ".mp3", ".mov", ".avi",
]);

/** 归一化：string -> FileReq，并按 path+offset+limit 去重。 */
export function normalizeFiles(files: Array<string | FileReq>): FileReq[] {
  const seen = new Set<string>();
  const out: FileReq[] = [];
  for (const f of files) {
    const req: FileReq = typeof f === "string" ? { path: f } : f;
    const key = `${req.path}|${req.offset ?? ""}|${req.limit ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(req);
  }
  return out;
}

/** 二进制判定：已知扩展名，或样本含 NUL / 非打印字符比例 > 0.3。 */
export function looksBinary(path: string, sample: Buffer): boolean {
  const dot = path.lastIndexOf(".");
  if (dot >= 0 && BINARY_EXTS.has(path.slice(dot).toLowerCase())) return true;
  if (!sample.length) return false;
  let nonPrintable = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.3;
}

/** 按 offset(1-indexed)/limit 切片，受 maxLines + maxBytes 约束；未到 EOF 即 truncated。 */
export function sliceLines(
  allLines: string[],
  opts: { offset?: number; limit?: number; maxLines: number; maxBytes: number },
): { lines: string[]; startLine: number; endLine: number; truncated: boolean } {
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 1;
  const start = offset - 1;
  const end = opts.limit && opts.limit > 0 ? start + opts.limit : allLines.length;
  let slice = allLines.slice(start, end);
  let truncated = false;
  if (slice.length > opts.maxLines) {
    slice = slice.slice(0, opts.maxLines);
    truncated = true;
  }
  const kept: string[] = [];
  let bytes = 0;
  for (const ln of slice) {
    bytes += Buffer.byteLength(ln, "utf8") + 1;
    if (bytes > opts.maxBytes) {
      truncated = true;
      break;
    }
    kept.push(ln);
  }
  const startLine = offset;
  const endLine = startLine + kept.length - 1;
  if (endLine < allLines.length) truncated = true;
  return { lines: kept, startLine, endLine: Math.max(endLine, startLine), truncated };
}

function splitLines(text: string): string[] {
  if (!text.length) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 注册 read_files 工具。 */
export function registerReadFiles(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_files",
    label: "Read Files",
    description:
      "Read MULTIPLE files (or line ranges) in one call and get a single merged result. " +
      "Prefer this over calling read repeatedly: it collapses N reads into one tool result and keeps the conversation compact.",
    promptGuidelines: [
      "When you need to look at several files or several snippets, call read_files once instead of issuing many separate read calls.",
      "Give each file its own offset/limit to fetch only the lines you need.",
    ],
    parameters: Type.Object({
      files: Type.Array(
        Type.Union([
          Type.String(),
          Type.Object({
            path: Type.String(),
            offset: Type.Optional(Type.Number()),
            limit: Type.Optional(Type.Number()),
          }),
        ]),
        { description: "Files to read in one call; each may set its own 1-indexed offset/limit." },
      ),
      maxLinesPerFile: Type.Optional(Type.Number({ description: "Per-file line cap (default 400)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const reqs = normalizeFiles(params.files as Array<string | FileReq>);
      if (!reqs.length) {
        return { content: [{ type: "text", text: "read_files: no files given." }], details: { files: [] }, isError: true };
      }
      const maxLines = params.maxLinesPerFile && params.maxLinesPerFile > 0
        ? params.maxLinesPerFile
        : Number(getConfig("READ_FILES_MAX_LINES") ?? "400") || 400;
      const maxBytes = Number(getConfig("READ_FILES_MAX_BYTES") ?? "51200") || 51200;
      const segs: ReadSegment[] = reqs.map((req) => {
        const abs = isAbsolute(req.path) ? req.path : join(ctx.cwd, req.path);
        const disp = relative(ctx.cwd, abs) || req.path;
        if (!existsSync(abs)) {
          return { path: disp, startLine: 0, endLine: 0, totalLines: 0, lines: [], truncated: false, error: "not found" };
        }
        let buf: Buffer;
        try {
          buf = readFileSync(abs);
        } catch (e) {
          return { path: disp, startLine: 0, endLine: 0, totalLines: 0, lines: [], truncated: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (looksBinary(abs, buf.subarray(0, 4096))) {
          return { path: disp, startLine: 0, endLine: 0, totalLines: 0, lines: [], truncated: false, binary: true };
        }
        const all = splitLines(buf.toString("utf8"));
        const r = sliceLines(all, { offset: req.offset, limit: req.limit, maxLines, maxBytes });
        return { path: disp, startLine: r.startLine, endLine: r.endLine, totalLines: all.length, lines: r.lines, truncated: r.truncated };
      });
      return {
        content: [{ type: "text", text: formatReadResult(segs) }],
        details: {
          files: segs.map((s) => ({
            path: s.path, startLine: s.startLine, endLine: s.endLine, totalLines: s.totalLines,
            truncated: s.truncated, error: s.error, binary: s.binary,
          })),
        },
      };
    },
  });
}
