# MCP 工具权限控制（阶段 1）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增 `extensions/mcp-policy/` 扩展，用一个 `tool_call` 钩子对所有 `mcp__*` 工具做三态权限（auto/needs_approval/disabled）+ 参数级规则 + 危险默认规则 + 调用时审批（含记忆）+ 审计，策略落 `~/.pi/mcp-policy.json`、运行时读写、不重启生效。

**架构：** 纯逻辑集中在可单测的 `policy.ts`（解析策略、匹配规则、危险启发式、`decide` 决策）；I/O 与交互接线在 `index.ts`（读策略 + mtime 缓存、`ctx.ui.select` 审批、原子写回「总是允许」、追加审计），遵循现有 `safety` 扩展「纯逻辑测试、接线不测」的模式。server 级启停沿用现有 `MCP_SERVERS` 机制，不在本计划内。

**技术栈：** TypeScript（ESM，import 带 `.js` 后缀）+ `@earendil-works/pi-coding-agent` 的 `ExtensionAPI` + Node `node:fs`/`node:os`/`node:path` + vitest 4。

**参考设计：** `docs/superpowers/specs/2026-06-15-mcp-tool-permission-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `extensions/mcp-policy/package.json`（创建） | 独立扩展包，仿 `extensions/safety/package.json`；声明 `pi.extensions` + vitest |
| `extensions/mcp-policy/policy.ts`（创建） | 纯逻辑：类型、`parsePolicy`、`globMatch`、`matchRules`、`matchDanger`、`summarize`、`decide`；无 I/O |
| `extensions/mcp-policy/policy.test.ts`（创建） | `policy.ts` 单测（vitest） |
| `extensions/mcp-policy/index.ts`（创建） | 接线：`loadPolicy`（mtime 缓存）、`writeAlwaysAllow`（原子写）、`audit`、`tool_call` 钩子 |
| `extensions/index.ts`（修改） | 导入 `mcpPolicy` 并加入 `allExtensions`，让其编进 sidecar |

钩子互相独立（与 `safety` 的 `tool_call` 不冲突：safety 管内置 `bash/write/edit`，mcp-policy 只处理 `mcp__*`）。

---

## 任务 1：扩展脚手架 + `parsePolicy`

**文件：**
- 创建：`extensions/mcp-policy/package.json`
- 创建：`extensions/mcp-policy/policy.ts`
- 创建：`extensions/mcp-policy/policy.test.ts`

- [ ] **步骤 1：创建 `package.json`**

```json
{
  "name": "pi-mcp-policy",
  "version": "0.1.0",
  "description": "Per-tool permission control for mcp__* tools (three-state + param rules + call-time approval + audit).",
  "private": true,
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "mcp", "permission"],
  "license": "MIT",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **步骤 2：安装依赖**

运行：`cd extensions/mcp-policy && npm install`
预期：成功，生成 `node_modules`，`npx vitest --version` 可用（打印 4.x）。

- [ ] **步骤 3：编写失败的测试 `policy.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parsePolicy } from "./policy.js";

describe("parsePolicy", () => {
  it("returns defaults for empty / invalid json", () => {
    expect(parsePolicy("")).toEqual({
      version: 1,
      defaultPermission: "auto",
      tools: {},
      audit: { enabled: true },
    });
    expect(parsePolicy("not json")).toMatchObject({ defaultPermission: "auto", tools: {} });
  });

  it("parses tool permission and ordered rules", () => {
    const p = parsePolicy(
      JSON.stringify({
        tools: {
          mcp__fs__rm: {
            permission: "needs_approval",
            rules: [{ match: { path: "/etc/**" }, policy: "always" }, { policy: "never" }],
          },
        },
      }),
    );
    expect(p.tools.mcp__fs__rm.permission).toBe("needs_approval");
    expect(p.tools.mcp__fs__rm.rules).toEqual([
      { match: { path: "/etc/**" }, policy: "always" },
      { policy: "never" },
    ]);
  });

  it("drops invalid permission / policy values", () => {
    const p = parsePolicy(
      JSON.stringify({ defaultPermission: "weird", tools: { x: { permission: "nope", rules: [{ policy: "bad" }] } } }),
    );
    expect(p.defaultPermission).toBe("auto");
    expect(p.tools.x.permission).toBeUndefined();
    expect(p.tools.x.rules).toEqual([]);
  });

  it("audit defaults true; false only when explicitly disabled", () => {
    expect(parsePolicy("{}").audit.enabled).toBe(true);
    expect(parsePolicy(JSON.stringify({ audit: { enabled: false } })).audit.enabled).toBe(false);
  });
});
```

- [ ] **步骤 4：运行测试验证失败**

运行：`cd extensions/mcp-policy && npx vitest run policy.test.ts`
预期：FAIL，报错无法解析 `./policy.js` 或 `parsePolicy is not a function`。

- [ ] **步骤 5：编写 `policy.ts`（类型 + helpers + parsePolicy）**

```ts
// Pure policy logic for the mcp-policy extension. No I/O here so the decision
// logic stays unit-testable; all fs / ui side effects live in index.ts.

export type Permission = "auto" | "needs_approval" | "disabled";
export type RulePolicy = "never" | "required" | "always";

export interface Rule {
  match?: Record<string, string>;
  policy: RulePolicy;
}

export interface ToolEntry {
  permission?: Permission;
  rules?: Rule[];
}

export interface Policy {
  version: number;
  defaultPermission: Permission;
  tools: Record<string, ToolEntry>;
  audit: { enabled: boolean };
}

export type Decision =
  | { action: "pass" }
  | { action: "block"; code: "disabled" | "headless"; reason: string }
  | { action: "prompt"; recordable: boolean; summary: string };

const PERMISSIONS: Permission[] = ["auto", "needs_approval", "disabled"];

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isPermission(v: unknown): v is Permission {
  return PERMISSIONS.includes(v as Permission);
}

export function parsePolicy(json: string): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = {};
  }
  const root = asRecord(raw);
  const tools: Record<string, ToolEntry> = {};
  for (const [name, entryRaw] of Object.entries(asRecord(root.tools))) {
    const entry = asRecord(entryRaw);
    const out: ToolEntry = {};
    if (isPermission(entry.permission)) out.permission = entry.permission;
    if (Array.isArray(entry.rules)) {
      const rules: Rule[] = [];
      for (const r of entry.rules) {
        const rr = asRecord(r);
        if (rr.policy === "never" || rr.policy === "required" || rr.policy === "always") {
          const rule: Rule = { policy: rr.policy };
          const matchRaw = asRecord(rr.match);
          if (Object.keys(matchRaw).length > 0) {
            const m: Record<string, string> = {};
            for (const [k, val] of Object.entries(matchRaw)) {
              if (typeof val === "string") m[k] = val;
            }
            rule.match = m;
          }
          rules.push(rule);
        }
      }
      out.rules = rules;
    }
    tools[name] = out;
  }
  const auditRaw = asRecord(root.audit);
  return {
    version: typeof root.version === "number" ? root.version : 1,
    defaultPermission: isPermission(root.defaultPermission) ? root.defaultPermission : "auto",
    tools,
    audit: { enabled: auditRaw.enabled !== false },
  };
}
```

- [ ] **步骤 6：运行测试验证通过**

运行：`cd extensions/mcp-policy && npx vitest run policy.test.ts`
预期：PASS（parsePolicy 的 4 个用例通过）。

- [ ] **步骤 7：Commit**

```bash
git add extensions/mcp-policy/package.json extensions/mcp-policy/policy.ts extensions/mcp-policy/policy.test.ts
git commit -m "feat(mcp-policy): scaffold extension + parsePolicy"
```

---

## 任务 2：`globMatch` + `matchRules`

**文件：**
- 修改：`extensions/mcp-policy/policy.ts`
- 修改：`extensions/mcp-policy/policy.test.ts`

- [ ] **步骤 1：追加失败的测试到 `policy.test.ts`**

```ts
import { globMatch, matchRules, type Rule } from "./policy.js";

describe("globMatch", () => {
  it("matches * across slashes and exact strings", () => {
    expect(globMatch("/etc/**", "/etc/passwd")).toBe(true);
    expect(globMatch("**/.ssh/**", "/home/u/.ssh/id_rsa")).toBe(true);
    expect(globMatch("npx", "npx")).toBe(true);
    expect(globMatch("/etc/*", "/var/log")).toBe(false);
  });
  it("escapes regex metacharacters", () => {
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("a.b", "a.b")).toBe(true);
  });
});

describe("matchRules", () => {
  const rules: Rule[] = [{ match: { path: "/etc/**" }, policy: "always" }, { policy: "never" }];
  it("first matching rule wins; bare rule is catch-all", () => {
    expect(matchRules(rules, { path: "/etc/passwd" })).toBe("always");
    expect(matchRules(rules, { path: "/tmp/x" })).toBe("never");
  });
  it("returns undefined when no rules", () => {
    expect(matchRules(undefined, {})).toBeUndefined();
  });
  it("non-string arg value does not match", () => {
    expect(matchRules([{ match: { n: "1" }, policy: "required" }], { n: 1 })).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions/mcp-policy && npx vitest run policy.test.ts`
预期：FAIL，`globMatch` / `matchRules` 未导出。

- [ ] **步骤 3：追加实现到 `policy.ts`**

```ts
// Minimal glob: `*` matches any run of characters (including `/`), `?` one char.
// All other regex metacharacters are escaped. Used to test rule patterns.
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

export function matchRules(rules: Rule[] | undefined, args: Record<string, unknown>): RulePolicy | undefined {
  if (!rules) return undefined;
  for (const rule of rules) {
    if (!rule.match) return rule.policy; // bare rule ⇒ catch-all
    const hit = Object.entries(rule.match).every(([k, pat]) => {
      const v = args[k];
      return typeof v === "string" && globMatch(pat, v);
    });
    if (hit) return rule.policy;
  }
  return undefined;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions/mcp-policy && npx vitest run policy.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp-policy/policy.ts extensions/mcp-policy/policy.test.ts
git commit -m "feat(mcp-policy): globMatch + matchRules"
```

---

## 任务 3：`matchDanger` + `summarize`

**文件：**
- 修改：`extensions/mcp-policy/policy.ts`
- 修改：`extensions/mcp-policy/policy.test.ts`

- [ ] **步骤 1：追加失败的测试到 `policy.test.ts`**

```ts
import { matchDanger, summarize } from "./policy.js";

describe("matchDanger", () => {
  it("flags rm -rf, sudo, system paths and secrets", () => {
    expect(matchDanger({ command: "rm -rf /" })).toBe(true);
    expect(matchDanger({ command: "sudo reboot" })).toBe(true);
    expect(matchDanger({ path: "/etc/shadow" })).toBe(true);
    expect(matchDanger({ file: "/home/u/.ssh/id_rsa" })).toBe(true);
  });
  it("ignores benign args", () => {
    expect(matchDanger({ query: "hello world" })).toBe(false);
  });
});

describe("summarize", () => {
  it("truncates long args with an ellipsis", () => {
    expect(summarize({ a: "x".repeat(600) }).endsWith("…")).toBe(true);
  });
  it("returns compact json for short args", () => {
    expect(summarize({ a: "short" })).toBe('{"a":"short"}');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions/mcp-policy && npx vitest run policy.test.ts`
预期：FAIL，`matchDanger` / `summarize` 未导出。

- [ ] **步骤 3：追加实现到 `policy.ts`**

```ts
// Best-effort danger heuristics: scan the json blob of all args for risky
// shell fragments / system paths / secrets. Intentionally conservative; precise
// control is the user's per-tool rules. Documented as best-effort in the design.
const DANGEROUS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
  />\s*\/dev\/sd[a-z]/i,
  /\bchmod\b[^\n]*-R[^\n]*\b777\b/i,
  /(^|[\\/"])\/(etc|sys|proc)\//i,
  /[\\/]\.ssh[\\/]/i,
  /\.(pem|key)\b/i,
  /(^|[\\/"])\.env(\.|"|$)/i,
];

export function matchDanger(args: Record<string, unknown>): boolean {
  const blob = JSON.stringify(args ?? {});
  return DANGEROUS.some((re) => re.test(blob));
}

export function summarize(args: Record<string, unknown>, max = 500): string {
  const s = JSON.stringify(args ?? {});
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions/mcp-policy && npx vitest run policy.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp-policy/policy.ts extensions/mcp-policy/policy.test.ts
git commit -m "feat(mcp-policy): danger heuristics + summarize"
```

---

## 任务 4：`decide`（核心决策）

**文件：**
- 修改：`extensions/mcp-policy/policy.ts`
- 修改：`extensions/mcp-policy/policy.test.ts`

- [ ] **步骤 1：追加失败的测试到 `policy.test.ts`**

```ts
import { decide, type Policy, type ToolEntry } from "./policy.js";

describe("decide", () => {
  const base: Policy = { version: 1, defaultPermission: "auto", tools: {}, audit: { enabled: true } };
  const withTool = (entry: ToolEntry): Policy => ({ ...base, tools: { mcp__s__t: entry } });

  it("passes non-mcp tools untouched (even dangerous)", () => {
    expect(decide(base, "bash", { command: "rm -rf /" }, true)).toEqual({ action: "pass" });
  });
  it("auto passes", () => {
    expect(decide(withTool({ permission: "auto" }), "mcp__s__t", { q: "ok" }, true)).toEqual({ action: "pass" });
  });
  it("unknown tool uses defaultPermission (auto)", () => {
    expect(decide(base, "mcp__s__t", { q: "ok" }, true)).toEqual({ action: "pass" });
  });
  it("disabled blocks", () => {
    expect(decide(withTool({ permission: "disabled" }), "mcp__s__t", {}, true)).toMatchObject({
      action: "block",
      code: "disabled",
    });
  });
  it("needs_approval prompts (recordable) with UI", () => {
    expect(decide(withTool({ permission: "needs_approval" }), "mcp__s__t", {}, true)).toMatchObject({
      action: "prompt",
      recordable: true,
    });
  });
  it("needs_approval blocks when headless", () => {
    expect(decide(withTool({ permission: "needs_approval" }), "mcp__s__t", {}, false)).toMatchObject({
      action: "block",
      code: "headless",
    });
  });
  it("required rule prompts but is not recordable", () => {
    const p = withTool({ permission: "auto", rules: [{ match: { p: "x" }, policy: "required" }] });
    expect(decide(p, "mcp__s__t", { p: "x" }, true)).toMatchObject({ action: "prompt", recordable: false });
  });
  it("never rule passes and exempts danger", () => {
    const p = withTool({ permission: "needs_approval", rules: [{ policy: "never" }] });
    expect(decide(p, "mcp__s__t", { command: "rm -rf /" }, true)).toEqual({ action: "pass" });
  });
  it("danger upgrades auto to prompt, not recordable", () => {
    expect(decide(withTool({ permission: "auto" }), "mcp__s__t", { command: "rm -rf /" }, true)).toMatchObject({
      action: "prompt",
      recordable: false,
    });
  });
  it("danger under headless blocks", () => {
    expect(decide(withTool({ permission: "auto" }), "mcp__s__t", { command: "sudo x" }, false)).toMatchObject({
      action: "block",
      code: "headless",
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions/mcp-policy && npx vitest run policy.test.ts`
预期：FAIL，`decide` 未导出。

- [ ] **步骤 3：追加实现到 `policy.ts`**

```ts
// Priority: disabled > param rule > danger upgrade > tool permission > default.
// Explicit `never` outranks the danger heuristic (user opt-out). Only a pure
// permission=needs_approval prompt (no rule hit) is recordable ("总是允许").
export function decide(
  policy: Policy,
  toolName: string,
  args: Record<string, unknown>,
  hasUI: boolean,
): Decision {
  if (!toolName.startsWith("mcp__")) return { action: "pass" };

  const entry = policy.tools[toolName];
  const perm = entry?.permission ?? policy.defaultPermission ?? "auto";
  if (perm === "disabled") {
    return { action: "block", code: "disabled", reason: "该工具已被禁用，可在 MCP 权限设置中启用" };
  }

  const rulePolicy = matchRules(entry?.rules, args);
  const danger = matchDanger(args);

  let needApproval: boolean;
  let recordable: boolean;
  if (rulePolicy === "never") {
    needApproval = false;
    recordable = false;
  } else if (rulePolicy === "always" || rulePolicy === "required") {
    needApproval = true;
    recordable = false;
  } else {
    needApproval = perm === "needs_approval";
    recordable = needApproval;
  }
  if (danger && rulePolicy !== "never") {
    needApproval = true;
    recordable = false;
  }

  if (!needApproval) return { action: "pass" };
  if (!hasUI) return { action: "block", code: "headless", reason: "需要审批但当前无界面（headless），已阻止" };
  return { action: "prompt", recordable, summary: summarize(args) };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions/mcp-policy && npx vitest run policy.test.ts`
预期：PASS（全部 policy 用例通过）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp-policy/policy.ts extensions/mcp-policy/policy.test.ts
git commit -m "feat(mcp-policy): decide() core decision logic"
```

---

## 任务 5：`index.ts` 接线（钩子 + 策略读写 + 审计）

**文件：**
- 创建：`extensions/mcp-policy/index.ts`

> 遵循 `extensions/safety/` 的模式：接线层不单测（决策逻辑已由 `policy.ts` 全覆盖），以类型检查 + 任务 6 的构建冒烟验证。

- [ ] **步骤 1：编写 `index.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decide, parsePolicy, type Policy } from "./policy.js";

const DIR = join(homedir(), ".pi");
const POLICY_PATH = join(DIR, "mcp-policy.json");
const AUDIT_PATH = join(DIR, "mcp-audit.jsonl");

const EMPTY: Policy = { version: 1, defaultPermission: "auto", tools: {}, audit: { enabled: true } };

// mtime cache so the hook re-reads only when the file actually changed (front-end
// edits in phase 2 are picked up on the next tool call without a restart).
let cache: { mtimeMs: number; data: Policy } | undefined;

function loadPolicy(): Policy {
  try {
    const { mtimeMs } = statSync(POLICY_PATH);
    if (cache && cache.mtimeMs === mtimeMs) return cache.data;
    const data = parsePolicy(readFileSync(POLICY_PATH, "utf8"));
    cache = { mtimeMs, data };
    return data;
  } catch {
    return EMPTY; // missing / unreadable ⇒ empty policy (everything via default)
  }
}

// "总是允许": set this tool's permission to auto, keep its existing rules, atomic write.
function writeAlwaysAllow(toolName: string): void {
  try {
    mkdirSync(DIR, { recursive: true });
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as Record<string, unknown>;
    } catch {
      raw = {};
    }
    const tools: Record<string, Record<string, unknown>> =
      raw.tools && typeof raw.tools === "object" && !Array.isArray(raw.tools)
        ? (raw.tools as Record<string, Record<string, unknown>>)
        : {};
    const entry: Record<string, unknown> =
      tools[toolName] && typeof tools[toolName] === "object" ? tools[toolName] : {};
    entry.permission = "auto";
    tools[toolName] = entry;
    raw.tools = tools;
    const tmp = `${POLICY_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
    renameSync(tmp, POLICY_PATH);
    cache = undefined; // force reload next time
  } catch (e) {
    console.error(`[mcp-policy] persist always-allow failed for ${toolName}: ${e instanceof Error ? e.message : e}`);
  }
}

function parseToolName(toolName: string): { server: string; tool: string } {
  const rest = toolName.slice("mcp__".length);
  const parts = rest.split("__");
  return { server: parts[0] ?? "", tool: parts.slice(1).join("__") || rest };
}

function audit(enabled: boolean, server: string, tool: string, decision: string, args: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    mkdirSync(DIR, { recursive: true });
    const s = JSON.stringify(args ?? {});
    const argsDigest = s.length > 500 ? `${s.slice(0, 500)}…` : s;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), server, tool, decision, argsDigest })}\n`;
    appendFileSync(AUDIT_PATH, line, "utf8");
  } catch {
    // best-effort; never block a tool call because audit failed
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = String(event.toolName ?? "");
    if (!toolName.startsWith("mcp__")) return undefined;

    const policy = loadPolicy();
    const args = (event.input ?? {}) as Record<string, unknown>;
    const { server, tool } = parseToolName(toolName);
    const d = decide(policy, toolName, args, ctx.hasUI);

    if (d.action === "pass") {
      audit(policy.audit.enabled, server, tool, "auto", args);
      return undefined;
    }
    if (d.action === "block") {
      const decision = d.code === "disabled" ? "blocked-disabled" : "blocked-headless";
      audit(policy.audit.enabled, server, tool, decision, args);
      return { block: true, reason: d.reason };
    }

    const options = d.recordable ? ["允许本次", "总是允许", "拒绝"] : ["允许本次", "拒绝"];
    const choice = await ctx.ui.select(
      `MCP 工具调用审批\n\n  ${server}: ${tool}\n  参数：${d.summary}\n\n是否允许？`,
      options,
    );
    if (choice === "总是允许") {
      writeAlwaysAllow(toolName);
      audit(policy.audit.enabled, server, tool, "always-approved", args);
      return undefined;
    }
    if (choice === "允许本次") {
      audit(policy.audit.enabled, server, tool, "approved", args);
      return undefined;
    }
    audit(policy.audit.enabled, server, tool, "rejected", args);
    return { block: true, reason: "用户拒绝执行" };
  });
}
```

- [ ] **步骤 2：本地类型检查**

运行：`cd extensions/mcp-policy && npx tsc --noEmit index.ts policy.ts --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck`
预期：无类型错误（若 `ExtensionAPI` 的 `event`/`ctx` 推断报错，对照 `extensions/safety/index.ts` 的同款 `pi.on("tool_call", (event, ctx) => ...)` 用法调整；`event.toolName`、`event.input`、`ctx.hasUI`、`ctx.ui.select(message, options)` 均与 safety 一致）。

- [ ] **步骤 3：Commit**

```bash
git add extensions/mcp-policy/index.ts
git commit -m "feat(mcp-policy): tool_call hook (approval + always-allow + audit)"
```

---

## 任务 6：注册进 sidecar + 全量验证

**文件：**
- 修改：`extensions/index.ts`

- [ ] **步骤 1：在 `extensions/index.ts` 注册扩展**

在 import 区（`import mcp from "./mcp/index.js";` 之后）加入：

```ts
import mcpPolicy from "./mcp-policy/index.js";
```

在具名 `export { ... }` 块中、`mcp,` 之后加入 `mcpPolicy,`；并在 `allExtensions` 数组中、`mcp,` 之后加入 `mcpPolicy,`。结果如下（节选）：

```ts
export {
  safety,
  // ...
  mcp,
  mcpPolicy,
  imageGen,
  // ...
};

export const allExtensions = [
  safety,
  // ...
  mcp,
  mcpPolicy,
  imageGen,
  // ...
];
```

> 顺序：放在 `mcp` 之后。`tool_call` 钩子拦截与扩展加载顺序无关（拦截发生在运行时调用阶段），此处仅为可读性把权限控制紧挨 mcp。

- [ ] **步骤 2：全量单测**

运行：`cd extensions/mcp-policy && npx vitest run`
预期：PASS，所有 describe（parsePolicy / globMatch / matchRules / matchDanger / summarize / decide）全绿。

- [ ] **步骤 3：构建 sidecar 冒烟**

运行：`cd tauri-agent && node scripts/build-sidecar.mjs`
预期：构建成功，无 `Could not resolve ./mcp-policy/index.js`，产物体积与之前相近。

- [ ] **步骤 4：端到端冒烟（手动，可选但建议）**

1. 写一个最小策略文件 `~/.pi/mcp-policy.json`：

```json
{ "version": 1, "defaultPermission": "auto", "tools": { "mcp__open-websearch__search": { "permission": "needs_approval" } }, "audit": { "enabled": true } }
```

2. 在 app 内让 agent 调用该 MCP 工具 → 预期弹出 `ctx.ui.select` 审批（允许本次/总是允许/拒绝）。
3. 点「总是允许」→ 再次调用不再弹窗；检查 `~/.pi/mcp-policy.json` 中该工具变为 `"permission": "auto"`、原 rules 保留。
4. 检查 `~/.pi/mcp-audit.jsonl` 有对应 `approved` / `always-approved` 记录。
5. 命令行 headless 跑（无 UI）该 needs_approval 工具 → 预期被 block，stderr/结果含拒绝原因。

- [ ] **步骤 5：Commit**

```bash
git add extensions/index.ts
git commit -m "feat(mcp-policy): register extension into sidecar bundle"
```

---

## 自检（规格覆盖度对照）

| 设计章节/需求 | 对应任务 |
|----------------|----------|
| 三态 auto/needs_approval/disabled | 任务 4（decide）+ 任务 1（parsePolicy） |
| 参数级规则 never/required/always + 顺序匹配 | 任务 2（matchRules）+ 任务 4 |
| 危险默认规则升级、never 豁免 | 任务 3（matchDanger）+ 任务 4 |
| 调用时审批 ctx.ui.select | 任务 5 |
| 「总是允许」即时写回（设 auto、保留 rules、原子写） | 任务 5（writeAlwaysAllow） |
| headless block | 任务 4 + 任务 5 |
| 策略文件读取 + mtime 缓存 | 任务 5（loadPolicy） |
| 审计日志 JSONL + 开关 | 任务 5（audit） |
| 单一拦截点、仅管 mcp__\* | 任务 4（前缀判断）+ 任务 5 |
| 注册进 sidecar、不破坏现有 mcp | 任务 6 |
| server 级启停沿用 MCP_SERVERS | 非目标（不在本计划） |
| 阶段 2 前端面板 | 非本计划（后续） |

类型一致性：`Decision`（`pass`/`block{code}`/`prompt{recordable,summary}`）、`Policy`、`ToolEntry`、`Rule`、`Permission`、`RulePolicy` 在 `policy.ts` 定义并被 `policy.test.ts`、`index.ts` 一致引用；`decide` 签名 `(policy, toolName, args, hasUI)` 在测试与钩子中一致。无占位符。

---

## 执行交接

两种执行方式：

1. **子代理驱动（推荐）**：每个任务调度一个新子代理，任务间审查。必需子技能 superpowers:subagent-driven-development。
2. **内联执行**：当前会话用 superpowers:executing-plans 批量执行并设检查点。
