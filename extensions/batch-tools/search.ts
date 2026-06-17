// search：一次多正则 pattern(OR) + glob 过滤的纯 JS 检索，分组合并一条结果。
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
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

/** 注册 search 工具。 */
export function registerSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "search",
    label: "Search",
    description:
      "Search the codebase with one or more regex patterns (OR) and optional glob filters, in one call. " +
      "Returns matches grouped by file (file:line). Use this instead of running grep/rg/find/ls via bash.",
    promptGuidelines: [
      "To search code by keyword/regex or find files by glob, call search instead of running grep/rg/find/ls in bash.",
      "Pass multiple patterns (OR) and multiple globs at once; results come back merged.",
    ],
    parameters: Type.Object({
      patterns: Type.Array(Type.String(), { description: "One or more regex patterns; a line matching ANY is a hit." }),
      globs: Type.Optional(Type.Array(Type.String(), { description: "Limit to files matching these globs, e.g. src/**/*.ts" })),
      path: Type.Optional(Type.String({ description: "Sub-directory to search (default: cwd)." })),
      ignoreCase: Type.Optional(Type.Boolean()),
      literal: Type.Optional(Type.Boolean({ description: "Treat patterns as literal strings, not regex." })),
      contextLines: Type.Optional(Type.Number({ description: "Lines of context around each match (default 0)." })),
      maxResults: Type.Optional(Type.Number({ description: "Max total matches (default 100)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const dir = params.path
        ? (isAbsolute(params.path) ? params.path : join(ctx.cwd, params.path))
        : ctx.cwd;
      const maxResults = params.maxResults && params.maxResults > 0
        ? params.maxResults
        : Number(getConfig("SEARCH_MAX_RESULTS") ?? "100") || 100;
      const maxFiles = Number(getConfig("SEARCH_MAX_FILES") ?? "5000") || 5000;
      const maxFileBytes = Number(getConfig("SEARCH_MAX_FILE_BYTES") ?? "1048576") || 1048576;
      const ctxLines = params.contextLines && params.contextLines > 0 ? params.contextLines : 0;
      const { regexes, invalid } = compilePatterns(params.patterns, { literal: params.literal, ignoreCase: params.ignoreCase });
      if (!regexes.length) {
        return {
          content: [{ type: "text", text: `search: no valid patterns.${invalid.length ? ` (invalid: ${invalid.join(", ")})` : ""}` }],
          details: { matches: [], total: 0, files: 0, capped: false, invalidPatterns: invalid },
        };
      }
      const files = walkFiles(dir, { globs: params.globs, maxFiles, maxFileBytes });
      const groups: { file: string; hits: Hit[] }[] = [];
      let matchCount = 0;
      let capped = false;
      for (const f of files) {
        if (signal?.aborted) break;
        let text: string;
        try {
          text = readFileSync(f, "utf8");
        } catch {
          continue;
        }
        const hits = searchInText(text, regexes, ctxLines);
        const fileMatches = hits.filter((h) => h.isMatch).length;
        if (!fileMatches) continue;
        const rel = relative(ctx.cwd, f) || f;
        if (matchCount + fileMatches > maxResults) {
          const remaining = maxResults - matchCount;
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
        if (matchCount >= maxResults) {
          capped = true;
          break;
        }
      }
      return {
        content: [{
          type: "text",
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
    },
  });
}
