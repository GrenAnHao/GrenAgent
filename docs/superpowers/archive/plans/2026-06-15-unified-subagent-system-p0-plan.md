# 融合子代理系统 P0 实现计划 — 能力档案地基（CapabilityProfile）

> **面向 AI 代理的工作者：** 用 `superpowers:executing-plans` 逐任务**内联**实现本计划（本仓库**禁止子代理**）。步骤用复选框 `- [ ]` 跟踪，每个任务结尾 commit 一次。

**目标：** 建立子代理「能力档案」抽象层 —— 用一份可组合、可增减的 `CapabilityProfile`（预设名 / 内联 / extends 三种拼法）统一声明子代理的模型、文件系统权限（只读 / 写白名单）、联网、MCP、工具黑名单、隔离级别；P0 让 model + fs(只读/写白名单) + net + mcp + tools.deny 五类能力位**端到端真正生效**。

**架构：** 新增纯函数模块 `extensions/multi-agent/capability.ts`（档案解析 + 翻译成「子进程 model + env」）；`spawn_agent` 增可选 `profile` 参数；`safety` 扩展消费注入的 env（只读 / 写白名单 / 工具黑名单）；`runner` 支持把 env 注入子进程。隔离维度（worktree/sandbox）与控制面（注册表/wait/cancel）分别留 P2 / P3。

**技术栈：** TypeScript（Node ≥ 22）+ `@earendil-works/pi-coding-agent` ExtensionAPI + typebox + vitest（node 环境）。

**设计依据：** `docs/superpowers/specs/2026-06-15-unified-subagent-system-design.md`。

**与 `improve-adapters` 的关系（重要）：**
- improve P1（per-task model）**已落地** → 本 P0 把它**收编**进档案，并增强为 `cheap`/`strong` 别名。
- improve P3（只读边界）**未落地** → 本 P0 **取代**之，用 capability 统一承载（不再单独走散参数 `readonly`/`writeAllow`）。
- improve P2（worktree 隔离）**保留**，落入本系统 **P2**（独立计划）；本 P0 的 `isolation` 字段已进 schema，但仅实现 `process`，传入 `worktree`/`sandbox` 时**明确报「尚未支持」**（不静默降级，杜绝误以为已隔离）。

**命令约定：**
- 扩展单测：`cd extensions && npx vitest run <相对路径>`（找不到 vitest 时改 `npx -y vitest run <file>`）
- 前端类型检查：`cd tauri-agent && npx tsc --noEmit`
- 集成构建（最终验证门，编译 cli+extensions 为二进制）：`cd tauri-agent && npm run build:sidecar`
- 子代理冒烟：用产物二进制 `pi --mode json -p --no-session --model <m> "..."`

> **STOP 条件（贯穿）：** 若 `cd extensions && npx vitest run` 因找不到 vitest 失败，改 `npx -y vitest run <file>`；若仍失败，停止并报告（可能需在 `extensions/package.json` 加 `vitest` devDependency），不要擅自改测试框架。

---

## 文件结构

**新建**
- `extensions/multi-agent/capability.ts` — 能力档案类型 + 预设 + 解析 + 翻译（纯函数）
- `extensions/multi-agent/capability.test.ts` — 档案解析 / 翻译单测

**修改**
- `extensions/multi-agent/runner.ts` — `spawnPiAgent` 增 `opts.env` 注入
- `extensions/multi-agent/index.ts` — `spawn_agent` 增 `profile` 参数并接入
- `extensions/safety/rules.ts` — `normalizePath` / `matchWriteAllowed` / `isMutatingBash` 纯函数
- `extensions/safety/rules.test.ts` — 新规则单测
- `extensions/safety/index.ts` — 只读 / 写白名单 / 工具黑名单拦截
- `tauri-agent/src/features/settings/settingsSchema.ts` — 子代理模型别名字段（cheap/strong）

---

# 阶段 P0 — 能力档案地基

## 任务 T0.1：`capability.ts` 纯函数 + 单测

把档案的「解析（预设 / extends / 内联）」与「翻译（→ model、→ 子进程 env）」做成可单测纯函数。

**文件：**
- 创建：`extensions/multi-agent/capability.ts`
- 测试：`extensions/multi-agent/capability.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `extensions/multi-agent/capability.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { PRESETS, resolveProfile, profileToModel, profileToEnv } from "./capability.js";

describe("resolveProfile", () => {
  it("undefined → default preset", () => {
    expect(resolveProfile(undefined).fs).toBe("workspace");
    expect(resolveProfile(undefined).isolation).toBe("process");
  });
  it("preset name → that preset", () => {
    expect(resolveProfile("explore").fs).toBe("readonly");
    expect(resolveProfile("explore").model).toBe("cheap");
  });
  it("unknown name → falls back to default", () => {
    expect(resolveProfile("nope").fs).toBe("workspace");
  });
  it("extends preset + inline override (additive)", () => {
    const p = resolveProfile({ extends: "explore", fs: { writeAllow: ["notes/"] } });
    expect(p.fs).toEqual({ writeAllow: ["notes/"] }); // overridden
    expect(p.net).toBe(true); // inherited from explore
    expect(p.model).toBe("cheap"); // inherited from explore
  });
  it("pure inline merges onto default base", () => {
    const p = resolveProfile({ fs: "readonly", net: false });
    expect(p.fs).toBe("readonly");
    expect(p.net).toBe(false);
    expect(p.isolation).toBe("process"); // from default base
    expect(p.spawn).toBe(false); // from default base
  });
  it("inline tools deny is carried through", () => {
    expect(resolveProfile({ tools: { deny: ["bash"] } }).tools).toEqual({ deny: ["bash"] });
  });
  it("every preset is self-consistent (process isolation by default in P0)", () => {
    for (const name of Object.keys(PRESETS)) {
      expect(["process", "worktree", "sandbox"]).toContain(PRESETS[name].isolation);
    }
  });
});

describe("profileToModel", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  it("cheap → SUBAGENT_MODEL_CHEAP", () => {
    expect(profileToModel({ model: "cheap" }, env({ SUBAGENT_MODEL_CHEAP: "deepseek/deepseek-chat" }))).toBe(
      "deepseek/deepseek-chat",
    );
  });
  it("cheap falls back to SUBAGENT_MODEL when no _CHEAP", () => {
    expect(profileToModel({ model: "cheap" }, env({ SUBAGENT_MODEL: "foo/bar" }))).toBe("foo/bar");
  });
  it("strong → SUBAGENT_MODEL_STRONG", () => {
    expect(profileToModel({ model: "strong" }, env({ SUBAGENT_MODEL_STRONG: "openai/o3" }))).toBe("openai/o3");
  });
  it("literal provider/id passes through", () => {
    expect(profileToModel({ model: "openai/gpt-4o" }, env({}))).toBe("openai/gpt-4o");
  });
  it("no model → undefined", () => {
    expect(profileToModel({}, env({}))).toBeUndefined();
  });
});

describe("profileToEnv", () => {
  it("fs=readonly → SAFETY_READONLY + empty allowlist", () => {
    const e = profileToEnv({ fs: "readonly" });
    expect(e.SAFETY_READONLY).toBe("1");
    expect(e.SAFETY_WRITE_ALLOW).toBe("");
    expect(e.MCP_SERVERS).toBe("");
  });
  it("fs writeAllow → readonly + joined prefixes", () => {
    const e = profileToEnv({ fs: { writeAllow: ["plans/", "docs/"] } });
    expect(e.SAFETY_READONLY).toBe("1");
    expect(e.SAFETY_WRITE_ALLOW).toBe("plans/,docs/");
  });
  it("fs=workspace → no SAFETY_READONLY", () => {
    expect(profileToEnv({ fs: "workspace" }).SAFETY_READONLY).toBeUndefined();
  });
  it("net=false → deny web tools", () => {
    expect(profileToEnv({ net: false }).SAFETY_DENY_TOOLS).toBe("web_search,web_fetch,web_crawler");
  });
  it("mcp allowlist → MCP_SERVERS", () => {
    expect(profileToEnv({ mcp: ["github"] }).MCP_SERVERS).toBe("github");
  });
  it("tools.deny merges into deny list", () => {
    expect(profileToEnv({ net: false, tools: { deny: ["bash"] } }).SAFETY_DENY_TOOLS).toBe(
      "web_search,web_fetch,web_crawler,bash",
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

`cd extensions && npx vitest run multi-agent/capability.test.ts` — 预期 FAIL（无法解析 `./capability`）。

- [ ] **步骤 3：实现 `capability.ts`**

创建 `extensions/multi-agent/capability.ts`：

```ts
// Capability profiles: a composable, declarative description of what a sub-agent
// is allowed to do. Resolves preset + extends + inline overrides into one
// effective profile, then translates it into spawn-time model + child env.
// Pure module (no I/O) so it is fully unit-testable.

export interface CapabilityProfile {
  name?: string;
  /** Tool gating. P0 consumes `deny` only; `allow` is reserved for a later phase. */
  tools?: { allow?: string[]; deny?: string[] };
  /** Filesystem capability: read-only, full workspace, or write-only under prefixes. */
  fs?: "readonly" | "workspace" | { writeAllow: string[] };
  /** Allow web_search / web_fetch / web_crawler. */
  net?: boolean;
  /** MCP: false = off (P0 default); string[] = server allowlist. `true` (full) treated as off in P0. */
  mcp?: boolean | string[];
  /** Allow this sub-agent to itself spawn sub-agents. Reserved (P3 enforces). */
  spawn?: boolean;
  /** Isolation tier. P0 implements `process` only. */
  isolation?: "process" | "worktree" | "sandbox";
  /** Model: provider/id, or alias `cheap` / `strong` resolved via env. */
  model?: string;
  limits?: { timeoutMs?: number; maxConcurrency?: number; tokenBudget?: number };
}

/** Inline profile may reference a preset to extend. */
export type ProfileInput = string | (CapabilityProfile & { extends?: string });

export const PRESETS: Record<string, CapabilityProfile> = {
  default: { name: "default", fs: "workspace", net: true, mcp: false, spawn: false, isolation: "process" },
  explore: { name: "explore", fs: "readonly", net: true, mcp: false, spawn: false, isolation: "process", model: "cheap" },
  planner: {
    name: "planner",
    fs: { writeAllow: ["plans/", "docs/"] },
    net: true,
    mcp: false,
    spawn: false,
    isolation: "process",
    model: "strong",
  },
  // P0: executor runs as `process` (no write isolation yet). P2 upgrades this to
  // `isolation: "worktree"` once createWorktree lands.
  executor: { name: "executor", fs: "workspace", net: false, mcp: false, spawn: false, isolation: "process", model: "cheap" },
  reviewer: { name: "reviewer", fs: "readonly", net: false, mcp: false, spawn: false, isolation: "process", model: "strong" },
};

function mergeProfile(base: CapabilityProfile, over: CapabilityProfile): CapabilityProfile {
  return {
    ...base,
    ...over,
    name: over.name ?? base.name,
    tools:
      base.tools || over.tools
        ? { allow: over.tools?.allow ?? base.tools?.allow, deny: over.tools?.deny ?? base.tools?.deny }
        : undefined,
    limits: base.limits || over.limits ? { ...base.limits, ...over.limits } : undefined,
  };
}

/** Resolve a profile input into one effective profile (inline > extends > default). */
export function resolveProfile(
  input: ProfileInput | undefined,
  userPresets: Record<string, CapabilityProfile> = {},
): CapabilityProfile {
  const presets = { ...PRESETS, ...userPresets };
  if (input === undefined) return { ...presets.default };
  if (typeof input === "string") return { ...(presets[input] ?? presets.default) };
  const base = input.extends ? presets[input.extends] ?? presets.default : presets.default;
  const { extends: _extends, ...inline } = input;
  return mergeProfile(base, inline);
}

/** Resolve model alias (cheap/strong) via env getter, or pass a literal through. */
export function profileToModel(
  p: CapabilityProfile,
  getEnv: (key: string) => string | undefined,
): string | undefined {
  const m = p.model?.trim();
  if (!m) return undefined;
  if (m === "cheap") return getEnv("SUBAGENT_MODEL_CHEAP")?.trim() || getEnv("SUBAGENT_MODEL")?.trim() || undefined;
  if (m === "strong") return getEnv("SUBAGENT_MODEL_STRONG")?.trim() || getEnv("SUBAGENT_MODEL")?.trim() || undefined;
  return m;
}

/** Translate an effective profile into child-process env consumed by the safety extension. */
export function profileToEnv(p: CapabilityProfile): Record<string, string> {
  const env: Record<string, string> = {};
  if (p.fs === "readonly") {
    env.SAFETY_READONLY = "1";
    env.SAFETY_WRITE_ALLOW = "";
  } else if (p.fs && typeof p.fs === "object" && Array.isArray(p.fs.writeAllow)) {
    env.SAFETY_READONLY = "1";
    env.SAFETY_WRITE_ALLOW = p.fs.writeAllow.join(",");
  }
  // P0 MCP: off (default) or explicit allowlist. `true` (full open) deliberately
  // treated as off here — revisit when MCP fan-out cost/recursion is addressed.
  env.MCP_SERVERS = Array.isArray(p.mcp) ? p.mcp.join(",") : "";
  const deny: string[] = [];
  if (p.net === false) deny.push("web_search", "web_fetch", "web_crawler");
  if (p.tools?.deny?.length) deny.push(...p.tools.deny);
  if (deny.length) env.SAFETY_DENY_TOOLS = deny.join(",");
  return env;
}
```

- [ ] **步骤 4：运行测试验证通过**

`cd extensions && npx vitest run multi-agent/capability.test.ts` — 预期 PASS（resolveProfile 7 + profileToModel 5 + profileToEnv 6 = 18 用例）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/capability.ts extensions/multi-agent/capability.test.ts
git commit -m "feat(multi-agent): add CapabilityProfile resolve + env/model translation"
```

## 任务 T0.2：`spawnPiAgent` 支持 `opts.env` 注入

让 `spawn_agent` 能把档案翻译出的 env 下发给子进程。

**文件：**
- 修改：`extensions/multi-agent/runner.ts`

- [ ] **步骤 1：扩展 opts 类型（`runner.ts` 的 `spawnPiAgent` 签名，约 75 行）**

把：

```ts
  opts: { model?: string; signal?: AbortSignal; onUpdate?: (update: AgentUpdate) => void } = {},
```

改为：

```ts
  opts: { model?: string; signal?: AbortSignal; onUpdate?: (update: AgentUpdate) => void; env?: Record<string, string> } = {},
```

- [ ] **步骤 2：合并 env（`runner.ts` 的 `env:{...}` 块，约 97-107 行）**

在 `env: { ...process.env, KB_AUTO_INJECT: "0", ..., MCP_SERVERS: "" }` 对象里、`MCP_SERVERS: "",` 之后追加一行，让调用方 env 覆盖默认：

```ts
        ...(opts.env ?? {}),
```

改完该对象应形如：

```ts
      env: {
        ...process.env,
        KB_AUTO_INJECT: "0",
        MEMORY_AUTO_INJECT: "0",
        MEMORY_AUTO_CAPTURE: "0",
        MEMORY_EXTRACT: "0",
        MCP_SERVERS: "",
        ...(opts.env ?? {}),
      },
```

- [ ] **步骤 3：单测无回归**

`cd extensions && npx vitest run multi-agent/runner.test.ts` — 预期 PASS（现有纯函数测试不受影响）。

- [ ] **步骤 4：Commit**

```bash
git add extensions/multi-agent/runner.ts
git commit -m "feat(multi-agent): allow env injection into spawned sub-agent"
```

## 任务 T0.3：`safety/rules.ts` 新增白名单 / mutating 纯函数 + 单测

**文件：**
- 修改：`extensions/safety/rules.ts`
- 修改：`extensions/safety/rules.test.ts`

- [ ] **步骤 1：在 `rules.test.ts` 追加失败用例**

在 `extensions/safety/rules.test.ts` 顶部 import 增加新函数（与现有 import 同行或新增一行），并在文件末尾追加：

```ts
import { isMutatingBash, matchWriteAllowed, normalizePath } from "./rules.js";

describe("normalizePath", () => {
  it("converts backslashes and strips ./", () => {
    expect(normalizePath(".\\plans\\a.md")).toBe("plans/a.md");
  });
});

describe("matchWriteAllowed", () => {
  it("allows paths under an allowlisted prefix", () => {
    expect(matchWriteAllowed("plans/001.md", ["plans/"])).toBe(true);
    expect(matchWriteAllowed("plans", ["plans/"])).toBe(true);
  });
  it("rejects paths outside the allowlist", () => {
    expect(matchWriteAllowed("src/index.ts", ["plans/"])).toBe(false);
  });
  it("rejects path traversal", () => {
    expect(matchWriteAllowed("plans/../src/x.ts", ["plans/"])).toBe(false);
  });
  it("empty allowlist allows nothing", () => {
    expect(matchWriteAllowed("plans/001.md", [])).toBe(false);
  });
});

describe("isMutatingBash", () => {
  it("flags redirects, rm/mv, sed -i, git mutators, pkg installs", () => {
    expect(isMutatingBash("echo hi > out.txt")).toBe(true);
    expect(isMutatingBash("rm foo")).toBe(true);
    expect(isMutatingBash("sed -i 's/a/b/' f")).toBe(true);
    expect(isMutatingBash("git commit -m x")).toBe(true);
    expect(isMutatingBash("npm install left-pad")).toBe(true);
  });
  it("allows read-only commands", () => {
    expect(isMutatingBash("ls -la")).toBe(false);
    expect(isMutatingBash("git status")).toBe(false);
    expect(isMutatingBash("grep foo src")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

`cd extensions && npx vitest run safety/rules.test.ts` — 预期 FAIL（未导出新函数）。

- [ ] **步骤 3：在 `rules.ts` 末尾追加实现**

向 `extensions/safety/rules.ts` 追加：

```ts
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True if `path` falls under any allowlisted prefix. Rejects `..` traversal. */
export function matchWriteAllowed(path: string, allowlist: string[]): boolean {
  if (!path) return false;
  const np = normalizePath(path);
  if (np.split("/").includes("..")) return false;
  return allowlist
    .map((a) => normalizePath(a.trim()).replace(/\/+$/, ""))
    .filter(Boolean)
    .some((prefix) => np === prefix || np.startsWith(prefix + "/"));
}

const MUTATING_BASH = [
  />>?/,
  /\b(rm|mv|cp|mkdir|rmdir|touch|tee|truncate|dd|ln)\b/,
  /\bsed\b[^\n]*\s-i/,
  /\bgit\b[^\n]*\b(commit|checkout|reset|merge|rebase|apply|stash|clean|restore)\b/,
  /\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|add|i|ci|remove|rm)\b/,
];

export function isMutatingBash(command: string): boolean {
  return MUTATING_BASH.some((re) => re.test(command));
}
```

- [ ] **步骤 4：运行测试验证通过**

`cd extensions && npx vitest run safety/rules.test.ts` — 预期 PASS（新用例 + 原有用例全绿）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/safety/rules.ts extensions/safety/rules.test.ts
git commit -m "feat(safety): add write-allowlist and mutating-bash rules"
```

## 任务 T0.4：`safety/index.ts` 接入只读 / 写白名单 / 工具黑名单

子进程通过注入的 env 收紧能力。**优先读 `process.env`（per-subagent 注入），回退 `getConfig`（全局）**——保证 per-subagent 收紧不被全局覆盖，也不污染主代理。

**文件：**
- 修改：`extensions/safety/index.ts`

- [ ] **步骤 1：扩展 import（`safety/index.ts:2`）**

把：

```ts
import { extractPath, isDangerousBash, matchProtectedPath } from "./rules.js";
```

改为：

```ts
import { extractPath, isDangerousBash, isMutatingBash, matchProtectedPath, matchWriteAllowed } from "./rules.js";
```

- [ ] **步骤 2：在 `pi.on("tool_call", ...)` 钩子开头读取并叠加只读 / 工具门**

把现有：

```ts
  pi.on("tool_call", async (event, ctx) => {
    const guardBash = !off(getConfig("SAFETY_BASH_CONFIRM"));
    const guardPaths = !off(getConfig("SAFETY_PROTECT_PATHS"));
```

改为（在两行 guard 之后插入只读 / 工具门逻辑）：

```ts
  pi.on("tool_call", async (event, ctx) => {
    const guardBash = !off(getConfig("SAFETY_BASH_CONFIRM"));
    const guardPaths = !off(getConfig("SAFETY_PROTECT_PATHS"));

    // Capability-profile gating. Prefer per-subagent injected process.env over
    // the global runtime config so a sub-agent's tightening cannot be loosened by
    // (or leak into) the main agent.
    const on = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";
    const readonly = on(process.env.SAFETY_READONLY ?? getConfig("SAFETY_READONLY"));
    const writeAllow = (process.env.SAFETY_WRITE_ALLOW ?? getConfig("SAFETY_WRITE_ALLOW") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const denyTools = (process.env.SAFETY_DENY_TOOLS ?? getConfig("SAFETY_DENY_TOOLS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (denyTools.includes(event.toolName)) {
      return { block: true, reason: `能力档案禁用工具：${event.toolName}` };
    }
    if (readonly) {
      if (event.toolName === "write" || event.toolName === "edit") {
        const p = extractPath((event.input ?? {}) as Record<string, unknown>);
        if (!p || !matchWriteAllowed(p, writeAllow)) {
          return { block: true, reason: `只读模式：仅允许写 ${writeAllow.join(", ") || "(无)"}` };
        }
      }
      if (event.toolName === "bash" && isMutatingBash(String(event.input?.command ?? ""))) {
        return { block: true, reason: "只读模式：禁止会改动文件系统的命令" };
      }
    }
```

> 注：`const off = ...` 已在文件顶部定义；此处新增的 `const on = ...` 为局部，不冲突。

- [ ] **步骤 3：集成构建验证编译**

`cd tauri-agent && npm run build:sidecar` — 预期成功（safety 改动编译进二进制）。

- [ ] **步骤 4：Commit**

```bash
git add extensions/safety/index.ts
git commit -m "feat(safety): readonly/write-allowlist/tool-deny gating from capability env"
```

## 任务 T0.5：`spawn_agent` 增 `profile` 参数并接入

**文件：**
- 修改：`extensions/multi-agent/index.ts`

- [ ] **步骤 1：补充 import（`index.ts` 顶部 import 区）**

在 `import { normalizeTasks } from "./tasks.js";` 之后追加：

```ts
import { resolveProfile, profileToModel, profileToEnv, type ProfileInput } from "./capability.js";
import { getConfig } from "../_shared/runtime-config.js";
```

- [ ] **步骤 2：加 `profile` 参数（在 `parameters` 的 `tasks` 字段之后）**

```ts
      profile: Type.Optional(
        Type.Union(
          [
            Type.String({ description: "Preset profile: explore | planner | executor | reviewer | default" }),
            Type.Object(
              {
                extends: Type.Optional(Type.String()),
                fs: Type.Optional(
                  Type.Union([
                    Type.Literal("readonly"),
                    Type.Literal("workspace"),
                    Type.Object({ writeAllow: Type.Array(Type.String()) }),
                  ]),
                ),
                net: Type.Optional(Type.Boolean()),
                mcp: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
                spawn: Type.Optional(Type.Boolean()),
                isolation: Type.Optional(
                  Type.Union([Type.Literal("process"), Type.Literal("worktree"), Type.Literal("sandbox")]),
                ),
                model: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ],
          { description: "Capability profile: preset name or inline object. Composable, additive/subtractive." },
        ),
      ),
```

- [ ] **步骤 3：在 `execute` 顶部解析档案并加隔离守卫**

把 `execute` 开头：

```ts
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const list = normalizeTasks(params);
      if (!list.length) throw new Error("provide `task` or `tasks`");
```

改为：

```ts
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const list = normalizeTasks(params);
      if (!list.length) throw new Error("provide `task` or `tasks`");

      const profile = resolveProfile(params.profile as ProfileInput | undefined);
      if (profile.isolation && profile.isolation !== "process") {
        throw new Error(
          `isolation '${profile.isolation}' 尚未支持（worktree 规划于 P2、sandbox 于 P4）；当前仅支持 process`,
        );
      }
      const profileModel = profileToModel(profile, getConfig);
      const profileEnv = params.profile ? profileToEnv(profile) : {};
```

- [ ] **步骤 4：单任务分支透传 model + env**

把单任务分支的 `spawnPiAgent(ctx.cwd, task, { model, signal: ... , onUpdate: ... })` 改为（`model` 兜底用 `profileModel`，并注入 `env`）：

```ts
      if (list.length === 1) {
        const { task, model } = list[0];
        const r = await spawnPiAgent(ctx.cwd, task, {
          model: model ?? profileModel,
          env: profileEnv,
          signal: signal ?? undefined,
          onUpdate: onUpdate
            ? (u) =>
                onUpdate({
                  content: [{ type: "text", text: u.text }],
                  details: { streaming: true, transcript: u.transcript },
                })
            : undefined,
        });
        if (!r.ok) throw new Error(`sub-agent failed (exit ${r.exitCode}): ${r.error ?? "unknown error"}`);
        return {
          content: [{ type: "text", text: r.output || "(no output)" }],
          details: { exitCode: r.exitCode, transcript: r.transcript },
        };
      }
```

- [ ] **步骤 5：并行分支透传 model + env**

把并行分支里的 `batch.map(...)` 改为：

```ts
        const settled = await Promise.all(
          batch.map((t) =>
            spawnPiAgent(ctx.cwd, t.task, {
              model: t.model ?? profileModel,
              env: profileEnv,
              signal: signal ?? undefined,
            }),
          ),
        );
```

- [ ] **步骤 6：类型检查 + 集成构建**

`cd tauri-agent && npm run build:sidecar` — 预期成功（capability.ts、index.ts 改动编译进二进制；typebox Union/Literal 通过）。

> STOP 条件：若构建因 typebox `Type.Literal` / `additionalProperties` 报错，确认 typebox 版本支持（≥ 0.32）；若不支持 `additionalProperties` 选项，去掉该选项（仅放宽校验，不影响功能）。

- [ ] **步骤 7：Commit**

```bash
git add extensions/multi-agent/index.ts
git commit -m "feat(multi-agent): spawn_agent accepts composable capability profile"
```

## 任务 T0.6：GUI 暴露子代理模型别名（cheap / strong）

让档案里的 `model: "cheap" | "strong"` 有可配置来源。

**文件：**
- 修改：`tauri-agent/src/features/settings/settingsSchema.ts`

- [ ] **步骤 1：在「子代理」section 追加两个字段**

在 `id: 'web'` 分类 → `title: '子代理'` 的 `fields` 数组里、`SUBAGENT_MODEL` 字段对象之后、`PI_BIN` 之前插入：

```ts
          {
            key: 'SUBAGENT_MODEL_CHEAP',
            label: '子代理便宜模型（档案别名 cheap）',
            type: 'model',
            placeholder: '如 deepseek/deepseek-chat',
            description: '能力档案 model:"cheap" 解析到此；留空回退「子代理模型」',
          },
          {
            key: 'SUBAGENT_MODEL_STRONG',
            label: '子代理强模型（档案别名 strong）',
            type: 'model',
            placeholder: '如 openai/gpt-4o',
            description: '能力档案 model:"strong" 解析到此；留空回退「子代理模型」',
          },
```

- [ ] **步骤 2：类型检查 + 前端测试无回归**

`cd tauri-agent && npx tsc --noEmit` — 无错误。
`cd tauri-agent && npx vitest run src/features/settings` — 预期全绿（仅新增声明式字段，无逻辑改动）。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/settings/settingsSchema.ts
git commit -m "feat(settings): expose SUBAGENT_MODEL_CHEAP/STRONG for profile aliases"
```

## 任务 T0.7：集成构建 + 端到端冒烟

- [ ] **步骤 1：集成构建**

`cd tauri-agent && npm run build:sidecar` — 预期成功产出 `src-tauri/binaries/pi-<triple>`。

- [ ] **步骤 2：向后兼容冒烟（无 profile）**

构造或经主代理调用 `spawn_agent({ task: "reply with the single word: ok" })`。
预期：行为与改动前一致（子代理正常返回 `ok`，未注入任何收紧 env）。

- [ ] **步骤 3：只读档案冒烟（explore）**

`spawn_agent({ task: "create a file hacked.txt with content x", profile: "explore" })`。
预期：子代理尝试 `write` 被 block，返回文本含「只读模式：仅允许写 (无)」；工作区**没有** `hacked.txt`。

- [ ] **步骤 4：写白名单档案冒烟（planner）**

`spawn_agent({ task: "write plans/note.md saying hi, then try to write src/x.ts", profile: "planner" })`。
预期：`plans/note.md` 允许；`src/x.ts` 被 block（「仅允许写 plans/, docs/」）。

- [ ] **步骤 5：模型别名冒烟**

先在设置里填 `SUBAGENT_MODEL_CHEAP`（任一已配置便宜模型），再 `spawn_agent({ task: "say ok", profile: { model: "cheap" } })`。
预期：子进程命令行带 `--model <便宜模型>`（可在子代理 transcript / 进程参数确认）。

- [ ] **步骤 6：隔离守卫冒烟**

`spawn_agent({ task: "x", profile: { isolation: "worktree" } })`。
预期：立即报错「isolation 'worktree' 尚未支持（worktree 规划于 P2…）」，不执行。

> STOP 条件：若只读未生效（`hacked.txt` 真被创建），检查链路：`profileToEnv` 是否输出 `SAFETY_READONLY` → `spawnPiAgent` 的 `...(opts.env)` 是否合并 → 子进程 safety 是否读到 `process.env.SAFETY_READONLY`。注意冒烟前确认**主进程环境干净**（无残留 `SAFETY_READONLY`），避免误判。

P0 完成 —— 能力档案可用：`profile` 预设 / 内联 / extends 三种拼法，model（cheap/strong/字面）+ fs（只读 / 写白名单）+ net + mcp + tools.deny 五类能力位端到端生效；isolation 字段就位，worktree/sandbox 留 P2/P4。

---

## 自检结果

**1. 设计覆盖度（对照 design §3 能力档案 / §9 路线图 P0）**

| design 要素 | 对应任务 | 状态 |
|-------------|----------|------|
| CapabilityProfile 类型 + 预设 | T0.1（PRESETS / 类型） | 完成 |
| 三种拼法（预设名 / extends / 内联） | T0.1 resolveProfile + 单测 | 完成 |
| model 收编 + cheap/strong 别名 | T0.1 profileToModel + T0.6 GUI | 完成 |
| fs 只读 / 写白名单生效 | T0.3 规则 + T0.4 拦截 + T0.1 profileToEnv | 完成 |
| net / mcp / tools.deny 生效 | T0.1 profileToEnv + T0.4 工具门 | 完成 |
| profile→env 翻译管道 | T0.1 profileToEnv + T0.2 runner env + T0.5 透传 | 完成 |
| isolation 就位但仅 process | T0.5 守卫 + T0.1 预设 isolation | 完成 |
| 向后兼容（无 profile 零变化） | T0.5 步骤 3（`params.profile ? ... : {}`） + T0.7 步骤 2 | 完成 |

**2. 占位符扫描：** 无「TODO / 待补充 / 适当处理」；每个实现步骤含完整可粘贴代码或精确改动位置。

**3. 类型一致性：**
- `CapabilityProfile` / `ProfileInput` / `PRESETS`（T0.1）被 T0.5 index.ts 引用。
- `resolveProfile` / `profileToModel` / `profileToEnv`（T0.1）签名与 T0.5 调用一致（`profileToModel(profile, getConfig)`、`profileToEnv(profile)`）。
- `profileToEnv` 输出键（`SAFETY_READONLY` / `SAFETY_WRITE_ALLOW` / `MCP_SERVERS` / `SAFETY_DENY_TOOLS`）与 T0.4 safety 消费键一致。
- `spawnPiAgent` 的 `opts.env`（T0.2）被 T0.5 的 `env: profileEnv` 使用。
- `matchWriteAllowed` / `isMutatingBash` / `normalizePath`（T0.3）被 T0.4 safety/index.ts 引用。

**4. 安全默认核对：**
- 未给 profile → 不注入收紧 env，行为同现状。
- profile.fs 默认（default 预设）= workspace（不锁），只有显式 readonly / writeAllow 才上锁。
- safety 只读优先读 `process.env`（per-subagent），回退 `getConfig`（全局），互不污染。
- P0 不实现 `tools.allow` 白名单（避免误伤瘫痪），只实现 `deny`；`isolation` 非 process 一律明确报错（不静默降级）。

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-06-15-unified-subagent-system-p0-plan.md`，设计见 `docs/superpowers/specs/2026-06-15-unified-subagent-system-design.md`。

本仓库**禁止子代理**，采用**内联执行**：
- **必需子技能：** `superpowers:executing-plans`
- 顺序：**T0.1 → T0.2 → T0.3 → T0.4 → T0.5 → T0.6 → T0.7**，每任务末尾 commit。
- 审查检查点：T0.4 / T0.5 集成构建；T0.7 端到端冒烟（向后兼容 / 只读 / 写白名单 / 模型别名 / 隔离守卫）。

**后续阶段（独立计划）：** P1 视情况已并入本 P0（只读）；P2 = worktree 隔离（把 executor 预设升 `isolation:"worktree"` + 接 `createWorktree`/`worktreeDiff`，复用 improve-adapters-plan 的 T2.x）；P3 = sqlite 注册表 + `action: spawn/status/wait/cancel` + 健壮性；P4 = sandbox + 配额 + 编排。
```
