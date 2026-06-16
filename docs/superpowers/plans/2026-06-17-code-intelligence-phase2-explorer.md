# 代码智能内置 · Phase 2（Context-Explorer 探索子代理）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 给主 agent 暴露一个只读的 `explore_context({ query, max_turns? })` 工具：在独立上下文窗口里跑一个只读探索子代理（优先用已内置的 CodeGraph 引擎工具，辅以 Read/Glob/Grep），只把紧凑的 `path:start-end` 引用回传主 agent —— 即 FastContext 的「探索/解题分离」，直接服务「省 token / 压缩上下文」。

**架构：** 复用 `multi-agent` 既有运行时（`runner.spawnPiAgent` + `capability` 纯函数），不新增进程模型。新建独立扩展 `extensions/code-intel/`：`explorer.ts`（纯函数 `buildExploreProfile`/`extractFinalAnswer` + FastContext 改编 system prompt + 工具注册），`index.ts`（扩展入口，带开关与子代理守卫），`package.json`；并注册进 `extensions/index.ts` 的 `allExtensions`。探索子代理经 capability `fs:readonly` + `deny:["bash"]` + `mcp:[engine]`（`net:false`）约束为只读，模型走便宜档。

**技术栈：** TypeScript（extensions sidecar）、Vitest、typebox（工具参数 schema）、`@earendil-works/pi-coding-agent`（ExtensionAPI）。

**对应规格：** `docs/superpowers/specs/2026-06-17-code-intelligence-builtin-design.md`（Spec 2）。依赖 Phase 1（Spec 0+1，已完成：CodeGraph 内置 + 默认 MCP 注入 + 自动 init）。

---

## 执行结果（2026-06-17 内联执行，已完成）

5 个任务全部内联执行 + 分段 commit：

| 任务 | commit | 验证 |
| --- | --- | --- |
| 1 explorer 纯函数 + system prompt | `4c611ee` | `explorer.test.ts` 8 passed |
| 2 注册 explore_context 工具 | `6abd2ec` | ReadLints 零错误 + 纯函数回归 8 passed |
| 3 code-intel 扩展化 + allExtensions | `171d8457` | cli esbuild build 成功（dist/main.js 9.0mb），实现代码 typecheck 零错误 |
| 4 runner deny explore_context | `a970cc2` | `runner.test.ts` 10 passed |
| 5 端到端验证 | （无代码） | `code-intel/` + `multi-agent/` vitest 8 files / 74 passed |

**验证状态：**

- 本机已验证：code-intel + multi-agent 单测 74 passed；cli esbuild 打包成功（扩展正确接入 sidecar）；`explorer.ts`/`index.ts` 实现代码 typecheck 零错误（各扩展 `.test.ts` 的 `Cannot find module 'vitest'` 是全仓既有现象，vitest 实跑无碍）。
- 待 build 环境手动验证（本机受限，同 Phase 1）：`tauri dev` 启动后在已 `codegraph init` 的项目让主 agent 调 `explore_context`，确认回传紧凑 `path:行号` 引用且子代理使用 `mcp__codegraph__*`；删 `.codegraph/` 或设 `CODE_INTEL=off` 后降级为 Glob/Grep/Read；`CODE_INTEL_EXPLORER=0` 时工具消失；子代理内 `explore_context`/`spawn_agent` 被 deny。

**提交粒度备注：** 任务 4 的 `runner.ts`/`runner.test.ts` 在本次改动前已有前序未提交修改，`git commit -- <文件>` 连带提交了这两个文件的完整工作区状态（含前序改动）；其余任务 commit 粒度纯净（仅本任务文件）。

---

## 调研纪要（针对真实接口，避免推测性代码）

执行期已核实以下真实接口（计划代码均据此编写）：

- **扩展机制：** 每个扩展 = 目录 + `package.json`（含 `"pi": { "extensions": ["./index.ts"] }`）+ `index.ts`（`export default function (pi: ExtensionAPI) {}`）。汇总在 `extensions/index.ts` 的 `allExtensions` 数组，编译进 sidecar。`extensions/code-intel/` 当前**只有 `engines.ts`（被 mcp 扩展 import 的纯模块），不是独立扩展**——本计划将其扩展化。
- **工具注册：** `pi.registerTool({ name, label, description, promptGuidelines?, parameters: Type.Object({...}), execute(toolCallId, params, signal, onUpdate, ctx) })`；`ctx.cwd` 可用（见 `extensions/code-search/index.ts` 范本）。
- **子代理运行时：** `spawnPiAgent(cwd, task, { model?, systemPrompt?, tools?, env?, mcp?, timeoutMs?, signal?, onUpdate? }) => Promise<AgentResult{ ok, output, exitCode, error?, transcript }>`（`extensions/multi-agent/runner.ts`）。内部执行 `pi --mode json -p --no-session --no-approve [--model] [--tools] [--append-system-prompt] <task>`。`env` 经派生 runtime-config 落盘生效；`mcp`（`boolean | string[]`）经 `resolveMcpServers` 从父 MCP 裁剪子代理可见的 server。
- **capability（纯函数，`extensions/multi-agent/capability.ts`）：** `resolveProfile`、`profileToEnv`（`fs:"readonly"`→`SAFETY_READONLY=1`；`net:false`→deny web_*；`tools.deny`→`SAFETY_DENY_TOOLS`）、`profileToModel(p, getEnv)`（`"cheap"`→`SUBAGENT_MODEL_CHEAP`→`SUBAGENT_MODEL`）。已存在 `explore` preset，本计划用同形 inline profile（额外 `mcp:[engine]` 与 `deny:["bash"]`）。
- **MCP 工具命名：** `mcp__<server>__<tool>`，故 codegraph 工具是 `mcp__codegraph__codegraph_explore` 等；经 `mcp:["codegraph"]` 让子代理获得整组 codegraph 工具（无需在 `--tools` 里逐个白名单——避免依赖框架 `--tools` 是否接受 MCP 名）。
- **子代理守卫：** 子进程带 `PI_IS_SUBAGENT=1`；`runner.buildSubagentRuntimeConfig` 已把 `spawn_agent` 并入 `SAFETY_DENY_TOOLS`。本计划同样把 `explore_context` 加入该 deny 列表，并在扩展入口 `PI_IS_SUBAGENT===1` 时跳过注册（双防线，防嵌套探索）。
- **引擎抽象（Phase 1，`extensions/code-intel/engines.ts`）：** `getEngine(name)` 返回 `{ serverName, toolPrefix, buildConfig }`；配置键 `CODE_INTEL`（`codegraph`/`gitnexus`/`off`，默认 `codegraph`）。
- **配置读取：** `getConfig(key)`（`extensions/_shared/runtime-config.js`）。

**Spec 2 偏差更正（执行期发现）：**

- Spec 2 写「在现有 capability→model 预设 UI（`capabilityModelPresets.ts` / `CapabilityModelField.tsx`）新增档位」。实测这两个前端文件是 **image/embedding/tts** 的模型建议（`Capability = 'image' | 'embedding' | 'tts'`），**与探索子代理无关**。因此 Phase 2 **不碰**这两个文件；探索子代理模型由 sidecar 配置键决定（`CODE_INTEL_EXPLORER_MODEL`，回退 `SUBAGENT_MODEL_CHEAP`/`SUBAGENT_MODEL`）。前端的「探索子代理模型选择」UI 归 Phase 3（Spec 3 管理 UI），不在本计划。
- Spec 2 capability 档位写「工具白名单 = Read/Glob/Grep + 引擎工具」。`capability.ts` 注释「P0 consumes deny only; allow reserved」——白名单用 **deny 实现**（`fs:readonly` 禁写、`net:false` 禁 web、`deny:["bash"]` 禁 bash），等价于「只剩 Read/Glob/Grep + 经 mcp 提供的引擎工具」。

**新增配置键：**

- `CODE_INTEL_EXPLORER` = `1`|`0`（默认 `1`）——是否注册 `explore_context` 工具（Spec 0 已规划此键）。
- `CODE_INTEL_EXPLORER_MODEL`（可选）——探索子代理模型；缺省回退 `SUBAGENT_MODEL_CHEAP`→`SUBAGENT_MODEL`→主默认。
- `CODE_INTEL_EXPLORER_TIMEOUT_MS`（可选）——探索子代理 idle 超时；缺省走 runner 默认（`SUBAGENT_TIMEOUT_MS`）。

---

## 文件结构

- 创建 `extensions/code-intel/explorer.ts` — FastContext 改编 system prompt 常量；纯函数 `buildExploreProfile(engineName, indexed)` 与 `extractFinalAnswer(output)`；`registerExploreContext(pi)` 注册 `explore_context` 工具。职责：探索子代理的「能力推导 + 产物解析 + 工具壳」。
- 创建 `extensions/code-intel/explorer.test.ts` — 纯函数单测（capability 推导、降级、`<final_answer>` 解析）。
- 创建 `extensions/code-intel/index.ts` — 扩展入口：开关 + 子代理守卫 + 调 `registerExploreContext`。
- 创建 `extensions/code-intel/package.json` — pi-extension 清单。
- 修改 `extensions/index.ts` — import 并把 `codeIntel` 加入 `allExtensions`。
- 修改 `extensions/multi-agent/runner.ts` — `buildSubagentRuntimeConfig` 的子代理 deny 列表追加 `explore_context`（防嵌套）。

---

## 任务 1：探索子代理的纯函数与 system prompt（`explorer.ts` 核心）

**文件：**
- 创建：`extensions/code-intel/explorer.ts`
- 测试：`extensions/code-intel/explorer.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/code-intel/explorer.test.ts
import { describe, expect, it } from "vitest";
import { buildExploreProfile, extractFinalAnswer, EXPLORE_SYSTEM_PROMPT } from "./explorer.js";

describe("buildExploreProfile", () => {
  it("uses the engine MCP when codegraph is active and the workspace is indexed", () => {
    const p = buildExploreProfile("codegraph", true);
    expect(p.fs).toBe("readonly");
    expect(p.net).toBe(false);
    expect(p.mcp).toEqual(["codegraph"]);
    expect(p.tools?.deny).toContain("bash");
    expect(p.model).toBe("cheap");
  });

  it("degrades to no MCP when not indexed (grep/glob/read baseline)", () => {
    expect(buildExploreProfile("codegraph", false).mcp).toBe(false);
  });

  it("degrades to no MCP when engine is off", () => {
    expect(buildExploreProfile("off", true).mcp).toBe(false);
  });

  it("degrades to no MCP for an unknown engine", () => {
    expect(buildExploreProfile("nope", true).mcp).toBe(false);
  });
});

describe("extractFinalAnswer", () => {
  it("extracts the <final_answer> block", () => {
    const out = "thinking...\n<final_answer>\nsrc/a.ts:10-20 - does X\n</final_answer>\ntrailing";
    expect(extractFinalAnswer(out)).toBe("src/a.ts:10-20 - does X");
  });

  it("falls back to the full output when no block is present", () => {
    expect(extractFinalAnswer("just some text")).toBe("just some text");
  });

  it("is case-insensitive and trims", () => {
    expect(extractFinalAnswer("<FINAL_ANSWER>  hi  </FINAL_ANSWER>")).toBe("hi");
  });
});

describe("EXPLORE_SYSTEM_PROMPT", () => {
  it("instructs read-only exploration and the final_answer contract", () => {
    expect(EXPLORE_SYSTEM_PROMPT).toMatch(/final_answer/);
    expect(EXPLORE_SYSTEM_PROMPT.toLowerCase()).toMatch(/read-only|只读/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run code-intel/explorer.test.ts`
预期：FAIL，`Cannot find module './explorer.js'`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// extensions/code-intel/explorer.ts
// Context-Explorer：只读探索子代理。复用 multi-agent 运行时，把探索 token 关在
// 子代理窗口里，只回紧凑 path:start-end 引用（FastContext 的探索/解题分离）。
import type { CapabilityProfile } from "../multi-agent/capability.js";
import { getEngine } from "./engines.js";

// 改编自 FastContext system.md：只读、并行工具、优先预建索引（codegraph_explore），
// 再用 Glob/Grep/Read 补缺，最后只输出 <final_answer> 引用块。
export const EXPLORE_SYSTEM_PROMPT = `You are a read-only code exploration sub-agent.

Your job: answer the caller's question about THIS repository by locating the
relevant code, then return a COMPACT set of references — not full file dumps.

Rules:
- READ-ONLY. Never edit, write, or run build/mutating commands.
- Prefer the pre-built index first: if codegraph_* tools are available, use
  codegraph_explore / codegraph_search / codegraph_node to find symbols, call
  paths and source in one shot. They are far cheaper than scanning files.
- Fall back to Glob / Grep / Read only to fill gaps the index didn't cover.
- Run independent lookups in parallel.
- Stop as soon as you can answer; do not over-explore.

Output: end your turn with exactly one block:

<final_answer>
- path/to/file.ts:120-145 - one short sentence on why this is relevant
- path/to/other.ts:8-30 - ...
</final_answer>

Each line is a path:start-end reference plus a one-sentence note. Keep it tight:
the caller has NOT seen the files you read, and only this block returns to them.`;

/**
 * 纯函数：由「当前引擎名 + 是否已索引」推导探索子代理的 capability。
 * 已索引且引擎有效 → 开放该引擎的 MCP（codegraph_* 工具）；否则降级为
 * 纯 Read/Glob/Grep（mcp:false）。始终只读、禁 bash、禁 web、便宜模型档。
 */
export function buildExploreProfile(engineName: string, indexed: boolean): CapabilityProfile {
  const engine = engineName === "off" ? undefined : getEngine(engineName);
  const useEngine = !!engine && indexed;
  return {
    name: "context-explorer",
    fs: "readonly",
    net: false,
    mcp: useEngine ? [engine!.serverName] : false,
    spawn: false,
    isolation: "process",
    model: "cheap",
    tools: { deny: ["bash"] },
  };
}

/** 纯函数：抽取 <final_answer> 块；缺失时回退整段输出（降级，不硬失败）。 */
export function extractFinalAnswer(output: string): string {
  const m = output.match(/<final_answer>([\s\S]*?)<\/final_answer>/i);
  return (m ? m[1] : output).trim();
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run code-intel/explorer.test.ts`
预期：PASS（buildExploreProfile 4 + extractFinalAnswer 3 + prompt 1 = 8 passed）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/code-intel/explorer.ts extensions/code-intel/explorer.test.ts
git commit -m "feat(code-intel): context-explorer pure helpers + system prompt"
```

---

## 任务 2：注册 `explore_context` 工具（execute 调 spawnPiAgent）

**文件：**
- 修改：`extensions/code-intel/explorer.ts`（追加 `registerExploreContext`）

依赖任务 1 的 `buildExploreProfile`/`extractFinalAnswer`/`EXPLORE_SYSTEM_PROMPT`。本任务为工具壳（含 I/O 与子进程），不写纯函数单测；其行为在任务 3 扩展接好后做手动验证。

- [ ] **步骤 1：在 `explorer.ts` 顶部补充 import**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { profileToEnv, profileToModel } from "../multi-agent/capability.js";
import { spawnPiAgent } from "../multi-agent/runner.js";
```

- [ ] **步骤 2：在 `explorer.ts` 末尾追加工具注册**

```ts
/** 注册 explore_context 工具：在独立只读子代理里探索，回传紧凑引用。 */
export function registerExploreContext(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "explore_context",
    label: "Explore Context",
    description:
      "Delegate a repository question to a read-only exploration sub-agent (separate context window). " +
      "It prefers the built-in CodeGraph index (codegraph_* tools), falls back to Glob/Grep/Read, and " +
      "returns a COMPACT set of path:start-end references instead of full file contents.",
    promptGuidelines: [
      "For where/how/find questions about THIS repo, call explore_context instead of grepping/reading files yourself — it keeps the exploration tokens out of your context window.",
      "Pass a precise natural-language query; the sub-agent returns compact path:start-end references you can then open directly.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language question about the codebase to explore." }),
      max_turns: Type.Optional(Type.Number({ description: "Soft budget for tool-call rounds (default ~6)." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // 防嵌套：子代理不得再发起探索（双防线，另见 index.ts 跳过注册 + runner deny）。
      if (process.env.PI_IS_SUBAGENT === "1") {
        throw new Error("explore_context 不可在子代理内调用（嵌套探索已被拦截）");
      }
      const engineName = getConfig("CODE_INTEL") ?? "codegraph";
      const indexed = existsSync(join(ctx.cwd, ".codegraph"));
      const profile = buildExploreProfile(engineName, indexed);
      const model = getConfig("CODE_INTEL_EXPLORER_MODEL")?.trim() || profileToModel(profile, getConfig);
      const timeoutMs = Number(getConfig("CODE_INTEL_EXPLORER_TIMEOUT_MS") ?? "") || undefined;
      const budget = typeof params.max_turns === "number" && params.max_turns > 0 ? params.max_turns : undefined;
      const task = budget
        ? `${params.query}\n\n(Budget: about ${budget} tool-call rounds — converge quickly.)`
        : params.query;

      const r = await spawnPiAgent(ctx.cwd, task, {
        model,
        systemPrompt: EXPLORE_SYSTEM_PROMPT,
        env: profileToEnv(profile),
        mcp: profile.mcp,
        timeoutMs,
        signal: signal ?? undefined,
        onUpdate: onUpdate
          ? (u) => onUpdate({ content: [{ type: "text", text: u.text }], details: { streaming: true } })
          : undefined,
      });
      if (!r.ok) {
        return {
          content: [{ type: "text", text: `explore_context failed: ${r.error ?? "unknown error"}` }],
          details: { engine: engineName, indexed, exitCode: r.exitCode },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: extractFinalAnswer(r.output) || "(no findings)" }],
        details: { engine: engineName, indexed, model: model ?? null },
      };
    },
  });
}
```

- [ ] **步骤 3：类型检查（无独立单测）**

运行：`cd extensions && npx tsc --noEmit -p tsconfig.json`（若无 per-package tsconfig，则在仓库根按既有方式 typecheck）
预期：`explorer.ts` 无类型错误（工具壳的运行验证在任务 3 后手动进行）。

- [ ] **步骤 4：Commit**

```bash
git add extensions/code-intel/explorer.ts
git commit -m "feat(code-intel): register explore_context tool (read-only sub-agent)"
```

---

## 任务 3：code-intel 扩展化 + 注册进 allExtensions

**文件：**
- 创建：`extensions/code-intel/index.ts`
- 创建：`extensions/code-intel/package.json`
- 修改：`extensions/index.ts`

- [ ] **步骤 1：写扩展入口 `index.ts`**

```ts
// extensions/code-intel/index.ts
// Code Intelligence 扩展入口：注册 explore_context（只读探索子代理）。
// 引擎内置 / 默认 MCP 注入在 Phase 1（mcp 扩展 + engines.ts）已完成；本入口聚焦工具层。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { registerExploreContext } from "./explorer.js";

export default function (pi: ExtensionAPI): void {
  // 子代理内不注册（防嵌套探索 + 保持子代理轻量），与 multi-agent/workflows 同款守卫。
  if (process.env.PI_IS_SUBAGENT === "1") return;
  // CODE_INTEL_EXPLORER=0 关闭（默认开）。
  if ((getConfig("CODE_INTEL_EXPLORER") ?? "1") === "0") return;
  registerExploreContext(pi);
}
```

- [ ] **步骤 2：写 `package.json`**

```json
{
  "name": "pi-code-intel",
  "version": "0.1.0",
  "description": "Built-in code intelligence (CodeGraph) tools for the Pi coding agent.",
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "code-intelligence", "codegraph"],
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

- [ ] **步骤 3：注册进 `extensions/index.ts`**

在 import 段加入（与既有风格一致）：

```ts
import codeIntel from "./code-intel/index.js";
```

在命名 `export { ... }` 与 `allExtensions` 数组中各加入 `codeIntel`（放在 `multiAgent` 之后、`codeSearch` 之前）：

```ts
  multiAgent,
  codeIntel,
  codeSearch,
```

- [ ] **步骤 4：构建 CLI 验证扩展被编译进 sidecar**

运行：`cd cli && npm run build`
预期：构建成功（`extensions/index.ts` 引入 `code-intel` 后无解析/类型错误）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/code-intel/index.ts extensions/code-intel/package.json extensions/index.ts
git commit -m "feat(code-intel): ship code-intel extension and register explore_context"
```

---

## 任务 4：子代理 deny 列表加固（防嵌套探索）

**文件：**
- 修改：`extensions/multi-agent/runner.ts`（`buildSubagentRuntimeConfig`）
- 测试：`extensions/multi-agent/runner.test.ts`（若已有对应 describe 则追加断言）

`runner.buildSubagentRuntimeConfig` 已把 `spawn_agent` 加入子代理 `SAFETY_DENY_TOOLS`。本任务把 `explore_context` 一并加入，作为「子代理不得发起探索」的硬防线（与 index.ts 跳过注册互补）。

- [ ] **步骤 1：编写失败的测试**

```ts
// 追加到 extensions/multi-agent/runner.test.ts
import { describe, expect, it } from "vitest";
import { buildSubagentRuntimeConfig } from "./runner.js";

describe("buildSubagentRuntimeConfig · explore_context guard", () => {
  it("denies both spawn_agent and explore_context in sub-agents", () => {
    const { env } = buildSubagentRuntimeConfig(false, {});
    const deny = (env.SAFETY_DENY_TOOLS ?? "").split(",");
    expect(deny).toContain("spawn_agent");
    expect(deny).toContain("explore_context");
  });

  it("preserves profile-provided deny entries", () => {
    const { env } = buildSubagentRuntimeConfig(false, { SAFETY_DENY_TOOLS: "bash" });
    const deny = (env.SAFETY_DENY_TOOLS ?? "").split(",");
    expect(deny).toContain("bash");
    expect(deny).toContain("explore_context");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run multi-agent/runner.test.ts`
预期：FAIL（`explore_context` 不在 deny 列表）。

- [ ] **步骤 3：编写最少实现代码**

在 `extensions/multi-agent/runner.ts` 的 `buildSubagentRuntimeConfig` 中，把现有：

```ts
  denyTools.add("spawn_agent");
```

改为：

```ts
  denyTools.add("spawn_agent");
  // 探索子代理也禁止再发起探索（与 spawn_agent 同款防递归）。
  denyTools.add("explore_context");
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run multi-agent/runner.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/runner.ts extensions/multi-agent/runner.test.ts
git commit -m "feat(code-intel): deny explore_context inside sub-agents (anti-recursion)"
```

---

## 任务 5：端到端手动验证（可 build 环境）

**文件：** 无（验证步骤）。

- [ ] **步骤 1：全量单测**

运行：`cd extensions && npx vitest run code-intel/ multi-agent/`
预期：全部 PASS（含任务 1/4 新增）。

- [ ] **步骤 2：构建并实跑探索**

构建 CLI（`cd cli && npm run build`），在一个已 `codegraph init` 的项目里启动主 agent，发问「where is X handled?」类问题，确认主 agent 调用 `explore_context` 且回传的是紧凑 `path:start-end` 引用（而非整文件）。
- 已索引：子代理应使用 `mcp__codegraph__*` 工具（可在子代理 transcript 中看到）。
- 删除 `.codegraph/` 或设 `CODE_INTEL=off` 后重试：应降级为 Glob/Grep/Read，仍返回引用（不硬失败）。

- [ ] **步骤 3：守卫验证**

确认子代理内 `spawn_agent`/`explore_context` 均不可用（`SAFETY_DENY_TOOLS` 生效），且 `CODE_INTEL_EXPLORER=0` 时主 agent 不再出现 `explore_context` 工具。

---

## 自检（规格覆盖 / 占位符 / 类型一致性）

- **规格覆盖（Spec 2）：** 落点复用 multi-agent（任务 1/2 import runner+capability，不新增运行时）；只读 capability 档位（任务 1 `buildExploreProfile`：fs readonly + deny bash + net false）；引擎工具经 `mcp:[engine]`（任务 1）；并行工具调用（system prompt 指示，子代理默认开并行）；模型便宜档（`profileToModel("cheap")` + `CODE_INTEL_EXPLORER_MODEL`）；`explore_context({ query, max_turns? })` 契约 + `<final_answer>` 产物（任务 2 + `extractFinalAnswer`）；主 agent 引导（任务 2 `promptGuidelines`）；降级 grep/glob/read（任务 1 `mcp:false` 分支 + system prompt fallback）；配置键 `CODE_INTEL_EXPLORER`（任务 3 开关）。**偏差更正：** capabilityModelPresets/CapabilityModelField 属 image/tts/embedding，前端探索模型 UI 归 Phase 3（见调研纪要）。
- **占位符扫描：** 无 TODO/待定；每个代码步骤含完整可运行代码与命令。`max_turns` 因 runner 是 one-shot print 模式无硬轮次上限，作为 system prompt 软预算注入 task（已说明，非占位）。
- **类型一致性：** `buildExploreProfile`→`CapabilityProfile`（复用 capability.ts 类型）；`profileToEnv`/`profileToModel`/`spawnPiAgent` 签名与 runner/capability 一致；`registerExploreContext`/`EXPLORE_SYSTEM_PROMPT`/`extractFinalAnswer` 命名在任务 1 定义、任务 2/3 使用一致；扩展 default export 形状与其它扩展一致。

## 风险与执行注意

- **`--tools` 与 MCP 名不确定性：** 本计划刻意不靠 `--tools` 白名单含 `mcp__*`，改用 capability env（readonly/deny/net）+ `mcp:[engine]`，全部是 Phase 1/multi-agent 已验证机制。
- **子代理冷启动：** 每次 `explore_context` spawn 一个新 pi 进程并各自连 codegraph MCP（stdio）。首次有冷启动开销；这是 multi-agent 子代理既有特性。若需复用，属后续优化（非 Phase 2 范围）。
- **prod 路径：** 探索子代理用 `process.execPath`（sidecar 自身）跑 `pi --mode json`，与 multi-agent 现有 spawn 同机制，不引入新的 prod 路径假设。
- **Phase 衔接：** 本计划完成后，Phase 3（管理 UI）再补「探索子代理开关 + 模型选择」前端（复用 `get/set_settings` + `useSettingsForm` 写 `CODE_INTEL_EXPLORER` / `CODE_INTEL_EXPLORER_MODEL`）。

## 后续计划（Phase 3 / 4）

- **Phase 3（Spec 3）· 管理 UI：** ExtensionsPanel 第三 tab；索引状态（复用 Phase 1 Rust `code_intel_*` 命令 + `codeIntelIo.ts`）；引擎/探索开关与模型选择（写本计划新增的配置键）。
- **Phase 4 · GitNexus opt-in：** 准备/下载 + 与 CodeGraph 互斥切换 + 增量能力。
