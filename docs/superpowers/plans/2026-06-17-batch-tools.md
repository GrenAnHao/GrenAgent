# batch-tools（批量读取 + 结构化检索）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 新建纯扩展 `extensions/batch-tools/`，给主 agent 两个默认开启的工具 `read_files`（一次读多文件/多行范围，合并一条结果）与 `search`（一次多正则 pattern + glob 过滤的纯 JS 检索，分组合并一条结果），把「read/bash 调用堆积」压扁。

**架构：** I/O 壳薄、纯函数厚。`walk.ts`（枚举 + glob→regex，纯）与 `format.ts`（输出格式化，纯）承载可测逻辑；`read-files.ts` / `search.ts` 是工具壳（读文件/遍历 I/O + 组合纯函数 + `registerTool`）；`index.ts` 入口做开关、子代理守卫与注册。零核心改动，复用 `_shared/runtime-config` 的 `getConfig`。

**技术栈：** TypeScript（ESM `.js` 导入）、typebox（参数 schema）、`@earendil-works/pi-coding-agent`（ExtensionAPI）、Vitest、node:fs/path。

**对应规格：** `docs/superpowers/specs/2026-06-17-batch-tools-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `extensions/batch-tools/walk.ts` | `globToRegExp` / `matchesAnyGlob` / `walkFiles`（纯 + 枚举 I/O） |
| `extensions/batch-tools/format.ts` | `ReadSegment` / `formatReadResult`、`Hit` / `formatSearchGroups`（纯） |
| `extensions/batch-tools/read-files.ts` | `normalizeFiles` / `looksBinary` / `sliceLines`（纯）+ `registerReadFiles`（工具壳） |
| `extensions/batch-tools/search.ts` | `compilePatterns` / `searchInText`（纯）+ `registerSearch`（工具壳） |
| `extensions/batch-tools/index.ts` | 扩展入口：开关 + 子代理守卫 + 注册两个工具 |
| `extensions/batch-tools/package.json` | pi-extension 清单 |
| `extensions/batch-tools/{walk,format,read-files,search,index}.test.ts` | 单测 |
| `extensions/index.ts`（修改） | import 并把 `batchTools` 加入 `allExtensions` |

类型契约（贯穿各任务，命名固定）：

- `walk.ts`：`globToRegExp(glob: string): RegExp`；`matchesAnyGlob(relPath: string, globs: RegExp[]): boolean`；`walkFiles(root, { globs?, maxFiles?, maxFileBytes? }): string[]`
- `format.ts`：`interface ReadSegment { path; startLine; endLine; totalLines; lines: string[]; truncated; error?; binary? }`；`formatReadResult(segs: ReadSegment[]): string`；`interface Hit { line: number; text: string; isMatch: boolean }`；`formatSearchGroups(groups: { file: string; hits: Hit[] }[], opts): string`
- `read-files.ts`：`interface FileReq { path: string; offset?: number; limit?: number }`；`normalizeFiles(files): FileReq[]`；`looksBinary(path, sample: Buffer): boolean`；`sliceLines(allLines, { offset?, limit?, maxLines, maxBytes }): { lines; startLine; endLine; truncated }`
- `search.ts`：`compilePatterns(patterns, { literal?, ignoreCase? }): { regexes: RegExp[]; invalid: string[] }`；`searchInText(text, regexes, contextLines): Hit[]`

---

## 任务 1：walk.ts（文件枚举 + 轻量 glob）

**文件：**
- 创建：`extensions/batch-tools/walk.ts`
- 测试：`extensions/batch-tools/walk.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/batch-tools/walk.test.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { globToRegExp, matchesAnyGlob, walkFiles } from "./walk.js";

describe("globToRegExp", () => {
  it("maps * to a single path segment", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
  });
  it("maps ** to any depth, optionally zero", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/a/b.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(false);
  });
  it("maps ? to one non-slash char and escapes regex meta", () => {
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("matchesAnyGlob", () => {
  it("returns true when no globs given", () => {
    expect(matchesAnyGlob("any/path.ts", [])).toBe(true);
  });
  it("normalizes backslashes and matches any glob", () => {
    const globs = [globToRegExp("src/**/*.ts")];
    expect(matchesAnyGlob("src\\a\\b.ts", globs)).toBe(true);
  });
});

describe("walkFiles", () => {
  it("lists files, applies globs, skips SKIP_DIRS and hidden dirs, honors maxFiles", () => {
    const root = join(tmpdir(), `bt-walk-${Date.now()}`);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, ".hidden"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(root, "src", "b.js"), "x");
    writeFileSync(join(root, "node_modules", "c.ts"), "x");
    writeFileSync(join(root, ".hidden", "d.ts"), "x");
    const ts = walkFiles(root, { globs: ["**/*.ts"] }).map((p) => p.replace(root, "").replace(/\\/g, "/"));
    expect(ts).toContain("/src/a.ts");
    expect(ts).not.toContain("/src/b.js");
    expect(ts.some((p) => p.includes("node_modules"))).toBe(false);
    expect(ts.some((p) => p.includes(".hidden"))).toBe(false);
  });
  it("skips files larger than maxFileBytes", () => {
    const root = join(tmpdir(), `bt-walk2-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "big.ts"), "x".repeat(2000));
    writeFileSync(join(root, "small.ts"), "x");
    const out = walkFiles(root, { maxFileBytes: 100 }).map((p) => p.replace(root, "").replace(/\\/g, "/"));
    expect(out).toContain("/small.ts");
    expect(out).not.toContain("/big.ts");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run batch-tools/walk.test.ts`
预期：FAIL，`Cannot find module './walk.js'`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// extensions/batch-tools/walk.ts
// 文件枚举 + 轻量 glob->regex。复用 code-search/files.ts 的目录跳过策略，
// 额外支持 glob 过滤、单文件字节上限与枚举上限。无外部依赖、跨平台。
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".pi", "dist", "build", "out", ".next", "coverage", "target", "vendor",
]);

/** glob -> RegExp：`*`=单段、`**`=任意层(可零，吃掉随后的 /)、`?`=单个非斜杠字符；其余正则元字符转义。匹配相对 POSIX 路径。 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** 任一 glob 命中即真；无 glob 视为全通过。先把分隔符归一化为 /。 */
export function matchesAnyGlob(relPath: string, globs: RegExp[]): boolean {
  if (!globs.length) return true;
  const p = relPath.split(sep).join("/").split("\\").join("/");
  return globs.some((g) => g.test(p));
}

/** 递归枚举 root 下文件（glob 过滤、跳过 SKIP_DIRS/隐藏目录、文件数与单文件字节上限）。 */
export function walkFiles(
  root: string,
  opts: { globs?: string[]; maxFiles?: number; maxFileBytes?: number } = {},
): string[] {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxFileBytes = opts.maxFileBytes ?? 1048576;
  const globs = (opts.globs ?? []).map(globToRegExp);
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full);
      } else if (e.isFile()) {
        if (!matchesAnyGlob(relative(root, full), globs)) continue;
        try {
          if (statSync(full).size > maxFileBytes) continue;
        } catch {
          continue;
        }
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run batch-tools/walk.test.ts`
预期：PASS（globToRegExp 3 + matchesAnyGlob 2 + walkFiles 2 = 7 passed）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/batch-tools/walk.ts extensions/batch-tools/walk.test.ts
git commit -m "feat(batch-tools): file walk + lightweight glob matcher"
```

---

## 任务 2：format.ts（输出格式化纯函数）

**文件：**
- 创建：`extensions/batch-tools/format.ts`
- 测试：`extensions/batch-tools/format.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/batch-tools/format.test.ts
import { describe, expect, it } from "vitest";
import { formatReadResult, formatSearchGroups, type Hit, type ReadSegment } from "./format.js";

describe("formatReadResult", () => {
  it("renders a header with span/total, numbered lines, and a truncation note", () => {
    const segs: ReadSegment[] = [
      { path: "a.ts", startLine: 1, endLine: 2, totalLines: 5, lines: ["x", "y"], truncated: true },
    ];
    const out = formatReadResult(segs);
    expect(out).toContain("===== a.ts (lines 1-2 of 5) =====");
    expect(out).toContain("1: x");
    expect(out).toContain("2: y");
    expect(out).toContain("offset=3");
  });
  it("renders error and binary segments", () => {
    const segs: ReadSegment[] = [
      { path: "miss.ts", startLine: 0, endLine: 0, totalLines: 0, lines: [], truncated: false, error: "not found" },
      { path: "img.png", startLine: 0, endLine: 0, totalLines: 0, lines: [], truncated: false, binary: true },
    ];
    const out = formatReadResult(segs);
    expect(out).toContain("[error: not found]");
    expect(out).toContain("[skipped: binary file]");
  });
});

describe("formatSearchGroups", () => {
  it("groups by file, marks match vs context, and appends a summary", () => {
    const groups = [
      { file: "a.ts", hits: [{ line: 11, text: "ctx", isMatch: false }, { line: 12, text: "hit", isMatch: true }] as Hit[] },
    ];
    const out = formatSearchGroups(groups, { total: 1, files: 1, capped: false, limit: 100 });
    expect(out).toContain("a.ts");
    expect(out).toContain("  11- ctx");
    expect(out).toContain("  12: hit");
    expect(out).toContain("(1 matches in 1 files)");
  });
  it("notes capping and empty results", () => {
    expect(formatSearchGroups([], { total: 0, files: 0, capped: false, limit: 100 })).toContain("No matches");
    const capped = formatSearchGroups([{ file: "a", hits: [{ line: 1, text: "h", isMatch: true }] }], {
      total: 100, files: 1, capped: true, limit: 100,
    });
    expect(capped).toContain("capped at 100");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run batch-tools/format.test.ts`
预期：FAIL，`Cannot find module './format.js'`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// extensions/batch-tools/format.ts
// 纯函数：把 read_files 的分段与 search 的分组渲染成紧凑文本。

export interface ReadSegment {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: string[];
  truncated: boolean;
  error?: string;
  binary?: boolean;
}

function formatReadSegment(seg: ReadSegment): string {
  if (seg.error) return `===== ${seg.path} =====\n[error: ${seg.error}]`;
  if (seg.binary) return `===== ${seg.path} =====\n[skipped: binary file]`;
  const span = seg.startLine === seg.endLine ? `line ${seg.startLine}` : `lines ${seg.startLine}-${seg.endLine}`;
  const showTotal = seg.startLine > 1 || seg.endLine < seg.totalLines;
  const header = showTotal
    ? `===== ${seg.path} (${span} of ${seg.totalLines}) =====`
    : `===== ${seg.path} (${span}) =====`;
  const body = seg.lines.map((l, i) => `${seg.startLine + i}: ${l}`).join("\n");
  const tail = seg.truncated
    ? `\n[truncated at line ${seg.endLine}; use read with offset=${seg.endLine + 1} for the rest]`
    : "";
  return `${header}\n${body}${tail}`;
}

export function formatReadResult(segs: ReadSegment[]): string {
  return segs.map(formatReadSegment).join("\n\n");
}

export interface Hit {
  line: number;
  text: string;
  isMatch: boolean;
}

export function formatSearchGroups(
  groups: { file: string; hits: Hit[] }[],
  opts: { total: number; files: number; capped: boolean; limit: number; invalidPatterns?: string[] },
): string {
  if (!groups.length) {
    const inv = opts.invalidPatterns?.length ? ` (invalid patterns: ${opts.invalidPatterns.join(", ")})` : "";
    return `No matches.${inv}`;
  }
  const blocks = groups.map(
    (g) => g.file + "\n" + g.hits.map((h) => `  ${h.line}${h.isMatch ? ":" : "-"} ${h.text}`).join("\n"),
  );
  const cap = opts.capped ? `; capped at ${opts.limit}` : "";
  const inv = opts.invalidPatterns?.length ? `; invalid patterns: ${opts.invalidPatterns.join(", ")}` : "";
  blocks.push(`(${opts.total} matches in ${opts.files} files${cap}${inv})`);
  return blocks.join("\n");
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run batch-tools/format.test.ts`
预期：PASS（formatReadResult 2 + formatSearchGroups 2 = 4 passed）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/batch-tools/format.ts extensions/batch-tools/format.test.ts
git commit -m "feat(batch-tools): output formatting for read_files and search"
```

---

## 任务 3：read-files.ts（批量读取纯函数 + 工具壳）

**文件：**
- 创建：`extensions/batch-tools/read-files.ts`
- 测试：`extensions/batch-tools/read-files.test.ts`

依赖任务 2 的 `ReadSegment` / `formatReadResult`。本任务先做三个纯函数（`normalizeFiles` / `looksBinary` / `sliceLines`，单测覆盖），再写工具壳 `registerReadFiles`（I/O，运行验证在任务 5/6）。

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/batch-tools/read-files.test.ts
import { describe, expect, it } from "vitest";
import { looksBinary, normalizeFiles, sliceLines } from "./read-files.js";

describe("normalizeFiles", () => {
  it("coerces strings to FileReq and de-dups by path+offset+limit", () => {
    const out = normalizeFiles(["a.ts", "a.ts", { path: "a.ts", offset: 5 }]);
    expect(out).toEqual([{ path: "a.ts" }, { path: "a.ts", offset: 5 }]);
  });
});

describe("looksBinary", () => {
  it("flags known binary extensions regardless of bytes", () => {
    expect(looksBinary("x.png", Buffer.from("plain text"))).toBe(true);
  });
  it("flags a NUL byte and high non-printable ratio", () => {
    expect(looksBinary("x.txt", Buffer.from([0x00, 0x41]))).toBe(true);
    expect(looksBinary("x.txt", Buffer.from("hello world\n"))).toBe(false);
  });
});

describe("sliceLines", () => {
  it("applies offset/limit (1-indexed) and reports truncation when more remain", () => {
    const all = ["a", "b", "c", "d", "e"];
    const r = sliceLines(all, { offset: 2, limit: 2, maxLines: 400, maxBytes: 51200 });
    expect(r.lines).toEqual(["b", "c"]);
    expect(r.startLine).toBe(2);
    expect(r.endLine).toBe(3);
    expect(r.truncated).toBe(true);
  });
  it("caps at maxLines", () => {
    const all = ["a", "b", "c", "d"];
    const r = sliceLines(all, { maxLines: 2, maxBytes: 51200 });
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.truncated).toBe(true);
  });
  it("does not truncate when the whole file fits", () => {
    const r = sliceLines(["a", "b"], { maxLines: 400, maxBytes: 51200 });
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.endLine).toBe(2);
    expect(r.truncated).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run batch-tools/read-files.test.ts`
预期：FAIL，`Cannot find module './read-files.js'`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// extensions/batch-tools/read-files.ts
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
  ".lib", ".pyc", ".woff", ".woff2", ".ttf", ".mp4", ".mp3", ".mov", ".avi", ".png",
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run batch-tools/read-files.test.ts`
预期：PASS（normalizeFiles 1 + looksBinary 2 + sliceLines 3 = 6 passed）。

- [ ] **步骤 5：类型检查（工具壳无独立单测）**

运行：`cd cli && npm run build`（或仓库既有 typecheck）。预期：`read-files.ts` 无类型错误（壳的运行验证在任务 6）。

- [ ] **步骤 6：Commit**

```bash
git add extensions/batch-tools/read-files.ts extensions/batch-tools/read-files.test.ts
git commit -m "feat(batch-tools): read_files (batch read with ranges + binary/error isolation)"
```

---

## 任务 4：search.ts（结构化检索纯函数 + 工具壳）

**文件：**
- 创建：`extensions/batch-tools/search.ts`
- 测试：`extensions/batch-tools/search.test.ts`

依赖任务 1（`walkFiles`）与任务 2（`Hit` / `formatSearchGroups`）。先做纯函数 `compilePatterns` / `searchInText`（单测），再写工具壳 `registerSearch`。

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/batch-tools/search.test.ts
import { describe, expect, it } from "vitest";
import { compilePatterns, searchInText } from "./search.js";

describe("compilePatterns", () => {
  it("compiles regex patterns and collects invalid ones", () => {
    const { regexes, invalid } = compilePatterns(["foo", "("], {});
    expect(regexes).toHaveLength(1);
    expect(invalid).toEqual(["("]);
  });
  it("escapes when literal and adds i flag when ignoreCase", () => {
    const { regexes } = compilePatterns(["a.b"], { literal: true });
    expect(regexes[0].test("a.b")).toBe(true);
    expect(regexes[0].test("axb")).toBe(false);
    const ci = compilePatterns(["foo"], { ignoreCase: true }).regexes[0];
    expect(ci.test("FOO")).toBe(true);
  });
});

describe("searchInText", () => {
  const text = ["import x", "const y = 1", "y()", "done"].join("\n");
  it("returns match lines for any pattern (OR)", () => {
    const { regexes } = compilePatterns(["import", "y\\("], {});
    const hits = searchInText(text, regexes, 0);
    expect(hits.filter((h) => h.isMatch).map((h) => h.line)).toEqual([1, 3]);
  });
  it("includes context lines marked as non-match", () => {
    const { regexes } = compilePatterns(["const"], {});
    const hits = searchInText(text, regexes, 1);
    expect(hits.map((h) => `${h.line}${h.isMatch ? ":" : "-"}`)).toEqual(["1-", "2:", "3-"]);
  });
  it("returns nothing when no line matches", () => {
    const { regexes } = compilePatterns(["zzz"], {});
    expect(searchInText(text, regexes, 0)).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run batch-tools/search.test.ts`
预期：FAIL，`Cannot find module './search.js'`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// extensions/batch-tools/search.ts
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run batch-tools/search.test.ts`
预期：PASS（compilePatterns 2 + searchInText 3 = 5 passed）。

- [ ] **步骤 5：类型检查**

运行：`cd cli && npm run build`。预期：`search.ts` 无类型错误。

- [ ] **步骤 6：Commit**

```bash
git add extensions/batch-tools/search.ts extensions/batch-tools/search.test.ts
git commit -m "feat(batch-tools): search (multi-pattern + glob, pure-JS, early stop)"
```

---

## 任务 5：扩展入口 index.ts + package.json

**文件：**
- 创建：`extensions/batch-tools/index.ts`
- 创建：`extensions/batch-tools/package.json`
- 测试：`extensions/batch-tools/index.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/batch-tools/index.test.ts
import { describe, expect, it, vi } from "vitest";
import batchTools from "./index.js";

function fakePi() {
  const tools: string[] = [];
  return { tools, registerTool: (t: { name: string }) => tools.push(t.name) } as never;
}

describe("batch-tools entry", () => {
  it("registers read_files and search by default", () => {
    const prev = process.env.BATCH_TOOLS_ENABLED;
    delete process.env.BATCH_TOOLS_ENABLED;
    const pi = fakePi() as unknown as { tools: string[] };
    batchTools(pi as never);
    expect(pi.tools).toContain("read_files");
    expect(pi.tools).toContain("search");
    if (prev !== undefined) process.env.BATCH_TOOLS_ENABLED = prev;
  });
  it("registers nothing when BATCH_TOOLS_ENABLED=0", () => {
    process.env.BATCH_TOOLS_ENABLED = "0";
    const pi = fakePi() as unknown as { tools: string[] };
    batchTools(pi as never);
    expect(pi.tools).toEqual([]);
    delete process.env.BATCH_TOOLS_ENABLED;
  });
});
```

> 注：`getConfig` 读取运行时配置（env 派生）。本测试用 `BATCH_TOOLS_ENABLED` 环境变量驱动开关分支；若本仓 `getConfig` 不直接读 env，则改为按 `_shared/runtime-config` 的现有测试约定注入（与 `code-search` 同款），断言不变。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run batch-tools/index.test.ts`
预期：FAIL，`Cannot find module './index.js'`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// extensions/batch-tools/index.ts
// batch-tools 扩展入口：默认注册 read_files / search。BATCH_TOOLS_ENABLED=0 关闭。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { registerReadFiles } from "./read-files.js";
import { registerSearch } from "./search.js";

export default function (pi: ExtensionAPI): void {
  if ((getConfig("BATCH_TOOLS_ENABLED") ?? "1") === "0") return;
  registerReadFiles(pi);
  registerSearch(pi);
}
```

```json
// extensions/batch-tools/package.json
{
  "name": "pi-batch-tools",
  "version": "0.1.0",
  "description": "Batch read_files + structured search tools for the Pi coding agent.",
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "batch", "read", "search"],
  "license": "MIT",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run batch-tools/index.test.ts`
预期：PASS（默认注册 + 关闭分支 = 2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/batch-tools/index.ts extensions/batch-tools/package.json extensions/batch-tools/index.test.ts
git commit -m "feat(batch-tools): extension entry with enable switch"
```

---

## 任务 6：接入 allExtensions + 构建冒烟

**文件：**
- 修改：`extensions/index.ts`

- [ ] **步骤 1：在 import 段加入（与既有风格一致）**

```ts
import batchTools from "./batch-tools/index.js";
```

- [ ] **步骤 2：在命名 `export { ... }` 与 `allExtensions` 数组中各加入 `batchTools`**

放在 `codeSearch,` 之后（与 D 区编码工具相邻）：

```ts
  codeSearch,
  batchTools,
```

`allExtensions` 数组同样在 `codeSearch,` 之后加入：

```ts
  codeSearch,
  batchTools,
```

- [ ] **步骤 3：全量单测**

运行：`cd extensions && npx vitest run batch-tools/`
预期：walk 7 + format 4 + read-files 6 + search 5 + index 2 = 24 passed。

- [ ] **步骤 4：构建 CLI 验证扩展编译进 sidecar**

运行：`cd cli && npm run build`
预期：构建成功（`extensions/index.ts` 引入 batch-tools 后无解析/类型错误）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/index.ts
git commit -m "feat(batch-tools): register batchTools in allExtensions"
```

- [ ] **步骤 6（可 build 环境的手动验证）**

构建后启动主 agent，给「读懂 X 并改动」类任务，确认：
- 主 agent 用 `read_files` 一次读多个文件（对话里 1 条 toolResult 而非多条 read）；
- 主 agent 用 `search` 多 pattern/glob 检索（替代 bash rg/find）；
- 设 `BATCH_TOOLS_ENABLED=0` 后两个工具消失。

---

## 自检（规格覆盖 / 占位符 / 类型一致性）

**规格覆盖度（对照 `2026-06-17-batch-tools-design.md`）：**
- §4 read_files（files/offset/limit、maxLinesPerFile、合并输出、二进制/错误隔离、去重）→ 任务 3。
- §5 search（patterns OR、globs、path、ignoreCase、literal、contextLines、maxResults、分组输出、非法正则跳过、早停）→ 任务 4。
- §3 架构（walk/format 纯函数 + 薄壳）→ 任务 1/2 + 3/4。
- §7 引导（promptGuidelines）→ 任务 3/4 工具定义内。
- §8 配置键（BATCH_TOOLS_ENABLED / READ_FILES_MAX_LINES / READ_FILES_MAX_BYTES / SEARCH_MAX_RESULTS / SEARCH_MAX_FILES / SEARCH_MAX_FILE_BYTES）→ 任务 3/4/5 各处 `getConfig`。
- §9 错误处理（fail-soft）→ 任务 3（空 files isError、单文件隔离）、任务 4（无有效 pattern、单文件读失败跳过）。
- §10 测试 → 任务 1-5 各 `*.test.ts`。
- §11 文件清单 / §13 排序 → 任务 1-6 顺序。
- §12 已完成资产核验 → 为运行时手动核验项，不属本扩展代码任务（保留在规格，落地时按 §12 验证）。

**占位符扫描：** 无 TODO/待定；每个代码步骤含完整可运行代码与命令。`contextLines` 在 `searchInText` 已实数实现（非占位）。

**类型一致性：** `ReadSegment`/`Hit` 定义于 `format.ts`，被 `read-files.ts`/`search.ts` 复用；`FileReq` 定义于 `read-files.ts` 并在 `normalizeFiles`/execute 一致使用；`walkFiles`/`globToRegExp`/`matchesAnyGlob` 签名在任务 1 定义、任务 4 使用一致；`compilePatterns`/`searchInText` 在任务 4 定义并自用；入口 `registerReadFiles`/`registerSearch` 命名在任务 3/4 定义、任务 5 使用一致；扩展 default export 形状与其它扩展（如 `code-search`）一致。

**偏差说明：** 任务 5 的 `index.test.ts` 用环境变量驱动开关；若 `getConfig` 不直接读 env，按 `_shared/runtime-config` 既有测试约定注入（断言不变）。ripgrep 后端、`gather` 组合工具、`.gitignore` 精确解析均为规格 §1.3 明列的范围外增强，不在本计划。
