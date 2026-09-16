# 子项目 C：压缩精细化（compaction-policy）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤用复选框（`- [ ]`）跟踪。

**目标：** 新增纯扩展 `extensions/compaction-policy/`：每次 LLM 前经 `context` 钩子把超出保护窗口的旧 toolResult 输出体替换为占位符（prune）；并从 `getContextUsage()` 派生 0-3 压力级显示在状态栏。零核心改动。

**架构：** `pi.on("context", e => ({ messages: prune(e.messages) }))` 做 ephemeral prune（不改 session 文件）；`turn_end`/`agent_end` 刷新压力状态；`/compaction` 命令查看。prune 只动「超保护窗口 + 已完成」的 toolResult，保留 `role:"toolResult"` 结构（`convertToLlm` 原样放行）。

**技术栈：** TypeScript（Pi 扩展，ESM `.js`）、Vitest。

**规格依据：** `docs/superpowers/specs/2026-06-16-compaction-policy-design.md`

---

## 关键约束

1. 零核心改动；纯扩展。`context` 钩子返回 `{ messages }` 覆盖发往 LLM 的消息（`types.d.ts:819,735-737`，runner `runner.js:685-712`）。
2. prune 保留 `toolResult` 结构：`ToolResultMessage { role:"toolResult"; toolCallId; toolName; content:(TextContent|ImageContent)[]; isError; timestamp }`（pi-ai `types.d.ts:213-221`）；只换 `content` 为占位 `[{type:"text",text}]`。
3. 压力源：`ContextUsage { tokens; contextWindow; percent }`（`types.d.ts:192-198`），`ctx.getContextUsage()`（`:236`）。
4. 默认 **prune 关、pressure 开**（保守，不改上游行为）。
5. 接入 `extensions/index.ts` 的 `allExtensions`；测试 `cd extensions && bunx vitest run compaction-policy/<file>`。
6. 禁 emoji。提交用 `git commit -- extensions/compaction-policy extensions/index.ts`（保留用户其余暂存）。

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `extensions/compaction-policy/package.json` | Pi 包清单（mirror plan-mode） |
| 创建 `extensions/compaction-policy/prune.ts` | `pruneMessages`（纯函数，泛型，结构化操作 toolResult） |
| 创建 `extensions/compaction-policy/pressure.ts` | `classify(percent)` → 0-3 级 + label |
| 创建 `extensions/compaction-policy/index.ts` | 工厂：`context`/`turn_end`/`agent_end` + `/compaction` |
| 创建 `*.test.ts` | 单测 |
| 修改 `extensions/index.ts` | 接入 `compactionPolicy` |

---

## 任务 1：脚手架 + prune

**文件：** 创建 `extensions/compaction-policy/package.json`、`prune.ts`、`prune.test.ts`

- [ ] **步骤 1：package.json**

```json
{
  "name": "pi-compaction-policy",
  "version": "0.1.0",
  "description": "Context prune (ephemeral tool-output elision) + pressure levels for the Pi coding agent.",
  "private": true,
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "compaction"],
  "license": "MIT",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": { "test": "vitest run" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **步骤 2：prune.ts**

```ts
// Ephemeral context prune: replace old, completed toolResult output bodies that
// fall outside the protection window (last `keepRecentTurns` user turns) with a
// short placeholder, keeping the toolResult message structure intact.
export interface PruneOptions {
  keepRecentTurns: number;
  minBodyChars: number;
}

type MessageLike = { role?: string; content?: unknown; toolName?: string };

function textLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
    .reduce((n, c) => n + (c.text?.length ?? 0), 0);
}

export function pruneMessages<T extends MessageLike>(
  messages: T[],
  opts: PruneOptions,
): { messages: T[]; prunedCount: number } {
  const userIdxs = messages.map((m, i) => (m?.role === "user" ? i : -1)).filter((i) => i >= 0);
  // Not enough turns to have anything outside the window → prune nothing.
  if (userIdxs.length <= opts.keepRecentTurns) return { messages, prunedCount: 0 };
  const protectFrom = userIdxs[userIdxs.length - opts.keepRecentTurns];

  let prunedCount = 0;
  const out = messages.map((m, i) => {
    if (i >= protectFrom) return m;
    if (m?.role !== "toolResult") return m;
    const len = textLength(m.content);
    if (len < opts.minBodyChars) return m;
    prunedCount++;
    return {
      ...m,
      content: [{ type: "text", text: `[pruned tool output: ${m.toolName ?? "tool"}, ${len} chars]` }],
    } as T;
  });
  return { messages: out, prunedCount };
}
```

- [ ] **步骤 3：prune.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { pruneMessages } from "./prune.js";

const tr = (toolName: string, text: string) => ({ role: "toolResult", toolName, content: [{ type: "text", text }] });
const user = (t: string) => ({ role: "user", content: t });
const asst = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });

describe("pruneMessages", () => {
  it("prunes nothing when turns <= keepRecentTurns", () => {
    const msgs = [user("a"), tr("read", "x".repeat(5000)), asst("b")];
    expect(pruneMessages(msgs, { keepRecentTurns: 6, minBodyChars: 1000 }).prunedCount).toBe(0);
  });
  it("prunes old toolResult bodies outside the protection window", () => {
    const msgs = [
      user("u1"), tr("read", "x".repeat(5000)), asst("a1"),
      user("u2"), tr("grep", "y".repeat(5000)), asst("a2"),
    ];
    const res = pruneMessages(msgs, { keepRecentTurns: 1, minBodyChars: 1000 });
    expect(res.prunedCount).toBe(1);
    expect((res.messages[1] as { content: { text: string }[] }).content[0].text).toMatch(/pruned tool output: read, 5000 chars/);
    // recent turn (u2 onward) kept verbatim
    expect((res.messages[4] as { content: { text: string }[] }).content[0].text).toBe("y".repeat(5000));
  });
  it("does not prune small bodies or non-toolResult messages", () => {
    const msgs = [user("u1"), tr("ls", "short"), asst("a1"), user("u2"), asst("a2")];
    const res = pruneMessages(msgs, { keepRecentTurns: 1, minBodyChars: 1000 });
    expect(res.prunedCount).toBe(0);
    expect(res.messages).toEqual(msgs);
  });
});
```

- [ ] **步骤 4：运行**

`cd extensions && bunx vitest run compaction-policy/prune.test.ts` → 预期 3 PASS。

---

## 任务 2：压力分级（pressure.ts）

**文件：** 创建 `pressure.ts`、`pressure.test.ts`

- [ ] **步骤 1：pressure.ts**

```ts
export interface PressureLevel {
  level: 0 | 1 | 2 | 3;
  label: string;
}

/** Classify context pressure from usage percent (0-100), or null when unknown. */
export function classify(percent: number | null): PressureLevel {
  if (percent == null) return { level: 0, label: "ctx —" };
  const p = Math.max(0, Math.min(100, percent));
  const level = p >= 85 ? 3 : p >= 70 ? 2 : p >= 50 ? 1 : 0;
  return { level, label: `ctx ${Math.round(p)}% L${level}` };
}
```

- [ ] **步骤 2：pressure.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { classify } from "./pressure.js";

describe("classify", () => {
  it("null → L0 unknown", () => {
    expect(classify(null)).toEqual({ level: 0, label: "ctx —" });
  });
  it("maps percent to levels", () => {
    expect(classify(40).level).toBe(0);
    expect(classify(60).level).toBe(1);
    expect(classify(78).level).toBe(2);
    expect(classify(90).level).toBe(3);
  });
  it("clamps and labels", () => {
    expect(classify(150)).toEqual({ level: 3, label: "ctx 100% L3" });
  });
});
```

- [ ] **步骤 3：运行**

`cd extensions && bunx vitest run compaction-policy/pressure.test.ts` → 预期 3 PASS。

---

## 任务 3：工厂（index.ts）

**文件：** 创建 `index.ts`、`index.test.ts`

- [ ] **步骤 1：index.ts**

```ts
// compaction-policy: ephemeral context prune via the `context` hook + context
// pressure indicator. Pure extension; default prune OFF, pressure ON.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { classify } from "./pressure.js";
import { pruneMessages } from "./prune.js";

const pruneEnabled = () => (getConfig("COMPACTION_POLICY_PRUNE") ?? "0") !== "0";
const keepTurns = () => Number(getConfig("COMPACTION_POLICY_KEEP_TURNS") ?? "6") || 6;
const minBody = () => Number(getConfig("COMPACTION_POLICY_MIN_BODY") ?? "1000") || 1000;
const pressureEnabled = () => (getConfig("COMPACTION_POLICY_PRESSURE") ?? "1") !== "0";

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event) => {
    if (!pruneEnabled()) return undefined;
    const res = pruneMessages(event.messages, { keepRecentTurns: keepTurns(), minBodyChars: minBody() });
    if (res.prunedCount === 0) return undefined;
    return { messages: res.messages };
  });

  const updatePressure = (ctx: ExtensionContext) => {
    if (!pressureEnabled()) return;
    ctx.ui.setStatus("ctx", classify(ctx.getContextUsage()?.percent ?? null).label);
  };

  pi.on("turn_end", async (_event, ctx) => updatePressure(ctx));
  pi.on("agent_end", async (_event, ctx) => updatePressure(ctx));

  pi.registerCommand("compaction", {
    description: "查看上下文压力与 prune 状态",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const { level, label } = classify(usage?.percent ?? null);
      ctx.ui.notify(
        `上下文：${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} tokens（${label}，级别 ${level}）\n` +
          `prune: ${pruneEnabled() ? "开" : "关"}（保护窗口 ${keepTurns()} 轮，最小裁剪 ${minBody()} 字符）`,
        "info",
      );
    },
  });
}
```

- [ ] **步骤 2：index.test.ts**

```ts
import { describe, expect, it } from "vitest";
import factory from "./index.js";

describe("compaction-policy factory", () => {
  it("registers context/turn_end/agent_end hooks and /compaction command", () => {
    const commands: string[] = [];
    const events: string[] = [];
    factory({
      registerCommand: (n: string) => commands.push(n),
      on: (e: string) => events.push(e),
    } as never);
    expect(commands).toContain("compaction");
    expect(events).toEqual(expect.arrayContaining(["context", "turn_end", "agent_end"]));
  });
});
```

- [ ] **步骤 3：运行全量**

`cd extensions && bunx vitest run compaction-policy` → 预期 3 文件全 PASS。

---

## 任务 4：接入 allExtensions + 验证 + 提交

**文件：** 修改 `extensions/index.ts`

- [ ] **步骤 1：加 import**（top，`import loopGuard` 附近）

```ts
import compactionPolicy from "./compaction-policy/index.js";
```

- [ ] **步骤 2：加入 export 块与 allExtensions**（`loopGuard,` 之后，两处都加）

```ts
  loopGuard,
  compactionPolicy,
  autoTitle,
```

- [ ] **步骤 3：导入冒烟**

`cd extensions && bun -e "const m = await import('./index.ts'); console.log(m.allExtensions.length, m.allExtensions.includes(m.compactionPolicy));"`
预期：`19 true`。

- [ ] **步骤 4：lint**

ReadLints `extensions/compaction-policy` + `extensions/index.ts` → 无错。

- [ ] **步骤 5：提交（仅 compaction-policy 路径）**

```bash
git add extensions/compaction-policy extensions/index.ts
git commit -m "feat(compaction-policy): context prune + pressure levels (pure extension)" -- extensions/compaction-policy extensions/index.ts
```

---

## 自检

**规格覆盖度（对照 `2026-06-16-compaction-policy-design.md`）：**
- §3 组件 index/prune/pressure → 任务 1-3。
- §1.1 prune（context 钩子，保护窗口，占位符）→ prune.ts + index.ts context 钩子。
- §1.1 压力分级 → pressure.ts + updatePressure。
- §6 边界（只动超窗口已完成 toolResult、fail-safe）→ pruneMessages（role/window/minBody 守卫）。
- §7 配置（PRUNE/KEEP_TURNS/MIN_BODY/PRESSURE）→ index.ts getConfig。
- §8 测试（保护窗口、尾轮保留、默认关闭）→ prune.test + index smoke。

**占位符扫描：** 无 TODO；全部步骤含完整代码与命令。

**类型一致性：** `PruneOptions`/`pruneMessages`（prune.ts，index.ts 复用）；`classify`/`PressureLevel`（pressure.ts，index.ts 复用）；`ContextEventResult.messages` 与 `pruneMessages` 返回的 `messages` 同为消息数组。

**默认安全：** prune 默认关（`COMPACTION_POLICY_PRUNE` 缺省 "0"）→ context 钩子 return undefined，行为与上游一致。
