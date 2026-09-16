# SP-5 after-tool 写后回灌实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** edit/write 后自动跑诊断并把结果 patch 进 tool result，让模型同轮看到并修复自己引入的错误。

**架构：** 新扩展 `after-tool-feedback`，挂 `pi.on("tool_result")`；用类型守卫过滤 edit/write，取被改文件，复用 `diagnostics` 的 check/parse，渲染诊断追加进结果 content；fail-soft、去重、可配置。

**技术栈：** TypeScript 扩展、`pi.on("tool_result")` + `ToolResultEventResult`、复用 `extensions/diagnostics/`、vitest。

设计来源：`docs/superpowers/specs/2026-06-26-after-tool-feedback-design.md`。

---

## 文件结构

- 创建：`extensions/after-tool-feedback/render.ts` —— `renderDiagnostics()` + `patchContent()`（纯）。
- 创建：`extensions/after-tool-feedback/select.ts` —— `extractEditedPaths()` + `diffNewDiagnostics()`（纯）。
- 创建：`extensions/after-tool-feedback/index.ts` —— 扩展工厂，挂 `tool_result`。
- 创建：`extensions/after-tool-feedback/render.test.ts`、`select.test.ts`。
- 修改：`extensions/index.ts` —— 注册新扩展进 `allExtensions`。

---

## 任务 1：`renderDiagnostics` + `patchContent` 纯逻辑

**文件：**
- 创建：`extensions/after-tool-feedback/render.ts`
- 测试：`extensions/after-tool-feedback/render.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/after-tool-feedback/render.test.ts
import { describe, expect, it } from "vitest";
import { patchContent, renderDiagnostics, type Diag } from "./render.js";

const diags: Diag[] = [
  { file: "a.ts", line: 3, col: 5, severity: "error", message: "Type 'x' is not assignable", source: "tsc" },
];

describe("renderDiagnostics", () => {
  it("renders one line per diagnostic", () => {
    expect(renderDiagnostics(diags, 50)).toBe("ERROR a.ts:3:5 [tsc] Type 'x' is not assignable");
  });
  it("truncates and notes remainder", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...diags[0], line: i }));
    const out = renderDiagnostics(many, 2);
    expect(out).toContain("... 还有 3 条");
  });
});

describe("patchContent", () => {
  it("appends a diagnostics block after original content", () => {
    const out = patchContent([{ type: "text", text: "edited a.ts" }], "ERROR a.ts:3 ...");
    expect(out).toEqual([
      { type: "text", text: "edited a.ts" },
      { type: "text", text: "\n[写后诊断]\nERROR a.ts:3 ..." },
    ]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run after-tool-feedback/render.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：编写实现**

```ts
// extensions/after-tool-feedback/render.ts
export interface Diag {
  file: string;
  line: number;
  col?: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
}

export function renderDiagnostics(diags: Diag[], max: number): string {
  const shown = diags.slice(0, max).map(
    (d) => `${d.severity.toUpperCase()} ${d.file}:${d.line}${d.col ? `:${d.col}` : ""} [${d.source}] ${d.message}`,
  );
  const rest = diags.length - shown.length;
  if (rest > 0) shown.push(`... 还有 ${rest} 条`);
  return shown.join("\n");
}

export type ContentBlock = { type: string; text?: string };

export function patchContent(original: ContentBlock[], diagText: string): ContentBlock[] {
  return [...original, { type: "text", text: `\n[写后诊断]\n${diagText}` }];
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run after-tool-feedback/render.test.ts`
预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/after-tool-feedback/render.ts extensions/after-tool-feedback/render.test.ts
git commit -m "feat(sp5): diagnostics render + patchContent"
```

## 任务 2：`extractEditedPaths` + `diffNewDiagnostics` 纯逻辑

**文件：**
- 创建：`extensions/after-tool-feedback/select.ts`
- 测试：`extensions/after-tool-feedback/select.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/after-tool-feedback/select.test.ts
import { describe, expect, it } from "vitest";
import { diffNewDiagnostics, extractEditedPaths } from "./select.js";
import type { Diag } from "./render.js";

describe("extractEditedPaths", () => {
  it("reads path from edit/write input", () => {
    expect(extractEditedPaths({ toolName: "edit", input: { path: "src/a.ts" } })).toEqual(["src/a.ts"]);
    expect(extractEditedPaths({ toolName: "write", input: { path: "b.ts" } })).toEqual(["b.ts"]);
  });
  it("returns [] for non-edit tools", () => {
    expect(extractEditedPaths({ toolName: "read", input: { path: "x" } })).toEqual([]);
  });
});

describe("diffNewDiagnostics", () => {
  it("keeps only diagnostics not present before", () => {
    const prev: Diag[] = [{ file: "a", line: 1, severity: "error", message: "m1", source: "tsc" }];
    const curr: Diag[] = [
      { file: "a", line: 1, severity: "error", message: "m1", source: "tsc" },
      { file: "a", line: 2, severity: "error", message: "m2", source: "tsc" },
    ];
    expect(diffNewDiagnostics(prev, curr).map((d) => d.message)).toEqual(["m2"]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run after-tool-feedback/select.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：编写实现**

```ts
// extensions/after-tool-feedback/select.ts
import type { Diag } from "./render.js";

export function extractEditedPaths(event: { toolName: string; input: Record<string, unknown> }): string[] {
  if (event.toolName !== "edit" && event.toolName !== "write") return [];
  const p = event.input?.path;
  return typeof p === "string" && p.length > 0 ? [p] : [];
}

const key = (d: Diag) => `${d.file}|${d.line}|${d.col ?? ""}|${d.severity}|${d.message}`;

export function diffNewDiagnostics(prev: Diag[], curr: Diag[]): Diag[] {
  const seen = new Set(prev.map(key));
  return curr.filter((d) => !seen.has(key(d)));
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run after-tool-feedback/select.test.ts`
预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/after-tool-feedback/select.ts extensions/after-tool-feedback/select.test.ts
git commit -m "feat(sp5): edited-path extraction + new-diagnostic dedup"
```

## 任务 3：扩展工厂挂 `tool_result`

**文件：**
- 创建：`extensions/after-tool-feedback/index.ts`

- [ ] **步骤 1：编写工厂（复用 diagnostics 的 check/parse）**

```ts
// extensions/after-tool-feedback/index.ts
// edit/write 后自动诊断并 patch 进 tool result。纯扩展，复用 diagnostics 的 runChecks/parsers。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { resolveCommands } from "../diagnostics/config.js";
import { parseEslintJson, parseTsc, type Diagnostic } from "../diagnostics/parsers.js";
import { runChecks } from "../diagnostics/runner.js";
import { patchContent, renderDiagnostics, type Diag } from "./render.js";
import { diffNewDiagnostics, extractEditedPaths } from "./select.js";

const enabled = () => (getConfig("AFTER_TOOL_FEEDBACK") ?? "1") !== "0";
const maxLines = () => Number(getConfig("AFTER_TOOL_MAX") ?? "30") || 30;

function parse(source: string, stdout: string, stderr: string): Diagnostic[] {
  return source === "eslint" ? parseEslintJson(stdout || stderr) : parseTsc(`${stdout}\n${stderr}`);
}

export default function (pi: ExtensionAPI) {
  let lastByFile = new Map<string, Diag[]>();

  pi.on("tool_result", async (event, ctx) => {
    if (!enabled()) return undefined;
    const paths = extractEditedPaths({ toolName: event.toolName, input: event.input });
    if (paths.length === 0) return undefined;
    try {
      const commands = resolveCommands(ctx.cwd);
      if (!commands.length) return undefined;
      const raws = await runChecks(ctx.cwd, commands, ctx.signal ?? undefined, 60000);
      const all = raws.flatMap((r) => parse(r.source, r.stdout, r.stderr)) as Diag[];
      const forFile = all.filter((d) => paths.some((p) => d.file.replace(/\\/g, "/").includes(p.replace(/\\/g, "/"))));
      const fresh = diffNewDiagnostics(lastByFile.get(paths[0]) ?? [], forFile);
      lastByFile.set(paths[0], forFile);
      if (fresh.length === 0) return undefined;
      return { content: patchContent(event.content, renderDiagnostics(fresh, maxLines())) };
    } catch (e) {
      console.error("[after-tool-feedback] 诊断失败（忽略）:", e instanceof Error ? e.message : e);
      return undefined; // fail-soft：绝不改/阻断结果
    }
  });
}
```

> 注：`resolveCommands`/`runChecks`/`parseTsc`/`parseEslintJson` 的导出路径以 `extensions/diagnostics/` 实际文件为准（`config.ts`/`runner.ts`/`parsers.ts`，已在 SP-5 spec §2 核实）。若 diagnostics 未导出这些，先在 diagnostics 内 `export` 它们（小改）。

- [ ] **步骤 2：typecheck**

运行：`cd cli && npm run typecheck`（sidecar 编译会带上 extensions）
预期：通过。

- [ ] **步骤 3：Commit**

```bash
git add extensions/after-tool-feedback/index.ts
git commit -m "feat(sp5): tool_result hook runs diagnostics and patches result"
```

## 任务 4：注册进 allExtensions

**文件：**
- 修改：`extensions/index.ts`

- [ ] **步骤 1：import + 加入数组**

在 `extensions/index.ts` 顶部 import：`import afterToolFeedback from "./after-tool-feedback/index.js";`；在 `export {...}` 与 `allExtensions` 数组中加入 `afterToolFeedback`（放在 `diagnostics` 之后）。

- [ ] **步骤 2：jiti smoke（扩展加载不崩）**

运行：`cd cli && npm run build`
预期：构建成功（37 → 38 扩展编入）。

- [ ] **步骤 3：Commit**

```bash
git add extensions/index.ts
git commit -m "feat(sp5): register after-tool-feedback extension"
```

---

## 自检

- 规格覆盖：tool_result 钩子（任务3）✓、edit/write 过滤（任务2）✓、诊断渲染/patch（任务1）✓、去重（任务2）✓、复用 diagnostics（任务3）✓、注册（任务4）✓、fail-soft（任务3 catch）✓。
- 占位符：无；`diagnostics` 导出路径标注"以实际文件为准"并给补救（加 export）。
- 类型一致：`Diag`（render.ts）被 select.ts/index.ts 共用；`diagnostics` 的 `Diagnostic` 与 `Diag` 字段对齐（file/line/col/severity/message/source）——任务3 用 `as Diag[]`，实现时确认字段同构，否则加一行映射。
