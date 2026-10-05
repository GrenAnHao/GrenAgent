// search：一次多正则 pattern(OR) + glob 过滤。优先打包 ripgrep（gitignore + 流式匹配），
// 二进制缺失时降级到纯 JS walk。
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { GREP_MAX_MATCHES, previewLine } from "../_shared/output-retention.js";
import { grepWithRg } from "../_shared/ripgrep.js";
import { walkFiles } from "./walk.js";
import { formatSearchGroups, type Hit } from "./format.js";

/** 编译 patterns；literal 转义、ignoreCase 加 i flag；非法正则收入 invalid。 */
export function compilePatterns(
  patterns: string[],
  opts: { literal?: boolean; ignoreCase?: boolean },
): { regexes: RegExp[]; invalid: string[] } {
  const flags = opts.ignoreCase ? "i" : "";
  const regexes: RegExp[] = [];
  const invalid: string[] = [];
  for (const p of patterns) {
    const src = opts.literal ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : p;
    try {
      regexes.push(new RegExp(src, flags));
    } catch {
      invalid.push(p);
    }
  }
  return { regexes, invalid };
}

/** 逐行匹配任一 regex；contextLines>0 时把命中行前后行作为 isMatch=false 的上下文一并返回（按行号排序、去重）。 */
export function searchInText(text: string, regexes: RegExp[], contextLines: number): Hit[] {
  const lines = text.split(/\r?\n/);
  const include = new Map<number, boolean>();
  for (let i = 0; i < lines.length; i++) {
    if (regexes.some((r) => r.test(lines[i]))) {
      include.set(i, true);
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        if (!include.has(j)) include.set(j, false);
      }
    }
  }
  return [...include.keys()]
    .sort((a, b) => a - b)
    .map((i) => ({ line: i + 1, text: lines[i], isMatch: include.get(i) === true }));
}

export const SEARCH_HARD_MAX_RESULTS = GREP_MAX_MATCHES;
const DEFAULT_MAX_RESULTS = GREP_MAX_MATCHES;

/** Clamp caller maxResults: missing/invalid → fallback; never above SEARCH_HARD_MAX_RESULTS. */
export function clampSearchMaxResults(raw: number | undefined, fallback = DEFAULT_MAX_RESULTS): number {
  const n = raw && raw > 0 ? Math.floor(raw) : fallback;
  const base = n >= 1 ? n : fallback;
  return Math.min(SEARCH_HARD_MAX_RESULTS, base);
}

export interface SearchWorkspaceOpts {
  dir: string;
  cwd: string;
  patterns: string[];
  globs?: string[];
  ignoreCase?: boolean;
  literal?: boolean;
  contextLines: number;
  maxResults: number;
  maxFiles: number;
  maxFileBytes: number;
  signal?: AbortSignal;
  engine?: "rg" | "js";
}

function searchViaJs(opts: SearchWorkspaceOpts): {
  groups: { file: string; hits: Hit[] }[];
  matchCount: number;
  capped: boolean;
  invalid: string[];
  error?: string;
} {
  const { regexes, invalid } = compilePatterns(opts.patterns, { literal: opts.literal, ignoreCase: opts.ignoreCase });
  if (!regexes.length) {
    return { groups: [], matchCount: 0, capped: false, invalid, error: `search: no valid patterns.${invalid.length ? ` (invalid: ${invalid.join(", ")})` : ""}` };
  }
  const files = walkFiles(opts.dir, { globs: opts.globs, maxFiles: opts.maxFiles, maxFileBytes: opts.maxFileBytes });
  const groups: { file: string; hits: Hit[] }[] = [];
  let matchCount = 0;
  let capped = false;
  for (const f of files) {
    if (opts.signal?.aborted) break;
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const hits = searchInText(text, regexes, opts.contextLines).map((h) => ({ ...h, text: previewLine(h.text) }));
    const fileMatches = hits.filter((h) => h.isMatch).length;
    if (!fileMatches) continue;
    const rel = relative(opts.cwd, f) || f;
    if (matchCount + fileMatches > opts.maxResults) {
      const remaining = opts.maxResults - matchCount;
      const trimmed: Hit[] = [];
      let used = 0;
      for (const h of hits) {
        if (h.isMatch) {
          if (used >= remaining) break;
          used++;
        }
        trimmed.push(h);
      }
      groups.push({ file: rel, hits: trimmed });
      matchCount += used;
      capped = true;
      break;
    }
    groups.push({ file: rel, hits });
    matchCount += fileMatches;
    if (matchCount >= opts.maxResults) {
      capped = true;
      break;
    }
  }
  return { groups, matchCount, capped, invalid };
}

/** Prefer packaged ripgrep (DSH engine). Fall back to JS walk only when the binary is missing. */
export async function searchWorkspace(opts: SearchWorkspaceOpts): Promise<{
  groups: { file: string; hits: Hit[] }[];
  matchCount: number;
  capped: boolean;
  invalid: string[];
  error?: string;
}> {
  const forceJs = opts.engine === "js" || (getConfig("SEARCH_ENGINE") ?? "rg") === "js";
  if (!forceJs && opts.patterns.length) {
    const rg = await grepWithRg({
      patterns: opts.patterns,
      path: opts.dir,
      cwd: opts.cwd,
      globs: opts.globs,
      ignoreCase: opts.ignoreCase,
      literal: opts.literal,
      contextLines: opts.contextLines,
      maxFilesize: opts.maxFileBytes,
      maxMatches: opts.maxResults,
      signal: opts.signal,
    });
    if (rg) {
      if (rg.error) return { groups: [], matchCount: 0, capped: false, invalid: [], error: `search: ${rg.error}` };
      return { groups: rg.groups, matchCount: rg.total, capped: rg.capped, invalid: [] };
    }
  }
  return searchViaJs(opts);
}

function toToolResult(
  groups: { file: string; hits: Hit[] }[],
  matchCount: number,
  capped: boolean,
  maxResults: number,
  invalid: string[],
  error?: string,
) {
  if (error && !groups.length) {
    return {
      content: [{ type: "text" as const, text: error }],
      details: { matches: [], total: 0, files: 0, capped: false, invalidPatterns: invalid },
    };
  }
  return {
    content: [{
      type: "text" as const,
      text: formatSearchGroups(groups, {
        total: matchCount, files: groups.length, capped, limit: maxResults,
        invalidPatterns: invalid.length ? invalid : undefined,
      }),
    }],
    details: {
      matches: groups.flatMap((g) => g.hits.filter((h) => h.isMatch).map((h) => ({ file: g.file, line: h.line, text: h.text }))),
      total: matchCount, files: groups.length, capped,
      invalidPatterns: invalid.length ? invalid : undefined,
    },
  };
}

/** 注册 search 工具。 */
export function registerSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "search",
    label: "Search",
    description:
      "Search the codebase with one or more regex patterns (OR) and optional glob filters, in one call. " +
      "Uses packaged ripgrep (respects .gitignore). Returns matches grouped by file (file:line). " +
      "Use this instead of bash grep, rg, or Windows Select-String.",
    promptSnippet: "Search the codebase with regex and optional globs.",
    promptGuidelines: [
      "To search file contents by keyword or regex, call search instead of bash, including Windows Select-String and Get-Content. search runs ripgrep.",
      "Pass multiple patterns (OR) and multiple globs at once; results come back merged.",
    ],
    parameters: Type.Object({
      patterns: Type.Array(Type.String(), { description: "One or more regex patterns; a line matching ANY is a hit." }),
      globs: Type.Optional(Type.Array(Type.String(), { description: "Limit to files matching these globs, e.g. src/**/*.ts" })),
      path: Type.Optional(Type.String({ description: "Sub-directory to search (default: cwd)." })),
      ignoreCase: Type.Optional(Type.Boolean()),
      literal: Type.Optional(Type.Boolean({ description: "Treat patterns as literal strings, not regex." })),
      contextLines: Type.Optional(Type.Number({ description: "Lines of context around each match (default 0)." })),
      maxResults: Type.Optional(Type.Number({ description: "Max total matches (default 250, hard cap 250)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const dir = params.path
        ? (isAbsolute(params.path) ? params.path : join(ctx.cwd, params.path))
        : ctx.cwd;
      const maxResults = clampSearchMaxResults(
        params.maxResults,
        Number(getConfig("SEARCH_MAX_RESULTS") ?? String(DEFAULT_MAX_RESULTS)) || DEFAULT_MAX_RESULTS,
      );
      const maxFiles = Number(getConfig("SEARCH_MAX_FILES") ?? "5000") || 5000;
      const maxFileBytes = Number(getConfig("SEARCH_MAX_FILE_BYTES") ?? "1048576") || 1048576;
      const ctxLines = params.contextLines && params.contextLines > 0 ? params.contextLines : 0;
      if (!params.patterns?.length) {
        return toToolResult([], 0, false, maxResults, [], "search: no valid patterns.");
      }
      const out = await searchWorkspace({
        dir, cwd: ctx.cwd, patterns: params.patterns, globs: params.globs,
        ignoreCase: params.ignoreCase, literal: params.literal, contextLines: ctxLines,
        maxResults, maxFiles, maxFileBytes, signal,
      });
      return toToolResult(out.groups, out.matchCount, out.capped, maxResults, out.invalid, out.error);
    },
  });
}
