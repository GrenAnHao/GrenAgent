# 子项目 A：Goal 停止条件 + 独立裁判 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 新增纯扩展 `extensions/goal/`，给会话设完成条件；agent 自然结束时由独立裁判 LLM 判定是否达成，未达成自动重入继续，防长程任务乐观早停。

**架构：** `agent_end` 钩子内 `await` 一次裁判 LLM 调用（复用当前 `ctx.model`），未达成则 `pi.sendMessage(理由, { triggerTurn: true })` 重入；目标态用 `appendEntry` 持久化、`session_start` 恢复。零核心改动。

**技术栈：** TypeScript（Pi 扩展，ESM `.js` 导入）、typebox（无需，本扩展不注册工具）、pi-ai `completeSimple`、Vitest。

**规格依据：** `docs/superpowers/specs/2026-06-16-goal-stop-condition-design.md`

---

## 关键约束（务必先读）

1. **零核心改动**：全部用扩展运行时公开 API（`@earendil-works/pi-coding-agent@0.79.x`）。
2. **加载/构建机制**：tauri-agent sidecar 把扩展经 `extensions/index.ts` 的 `allExtensions` 数组**编译进二进制**（`cli/src/main.ts:25` `import { allExtensions }`）。故新扩展**必须加入 `extensions/index.ts`**；改后必须 `cd tauri-agent && bun run build:sidecar` 才进运行时（仅改源不重编译无效）。
3. **扩展自包含**：不跨扩展 import；可 import `../_shared/*`。LLM 助手 **mirror** `long-term-memory/llm.ts`（复制，不跨扩展依赖）。
4. **ESM 导入后缀**：源码用 `.js` 后缀导入本地/`_shared` 模块（与现网一致，如 `./llm.js`、`../_shared/runtime-config.js`）。
5. **测试命令**：`cd extensions && bunx vitest run goal/<file>`（node_modules 在 `extensions/`；无 vitest 配置，裸跑发现 `*.test.ts`）。
6. **禁 emoji**（项目规则）。

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `extensions/goal/package.json` | Pi 包清单（mirror `plan-mode/package.json`） |
| 创建 `extensions/goal/llm.ts` | `AskFn` 类型 + `parseJsonLoose` + `resolveModel` + `askLlm`（mirror `long-term-memory/llm.ts`） |
| 创建 `extensions/goal/state.ts` | `GoalState` + `restoreFromEntries`（纯函数） |
| 创建 `extensions/goal/judge.ts` | `Verdict` + `flattenTranscript` + `buildJudgeUser` + `parseVerdict` + `judge`（fail-open） |
| 创建 `extensions/goal/index.ts` | 工厂：注册 `/goal` 命令 + `session_start`/`agent_end` 钩子 + 编排 |
| 创建 `extensions/goal/llm.test.ts`、`state.test.ts`、`judge.test.ts`、`index.test.ts` | 单测 |
| 修改 `extensions/index.ts` | 把 `goal` 加入 import + `export` + `allExtensions` |

---

## 任务 1：脚手架 + LLM 助手（llm.ts）

**文件：**
- 创建：`extensions/goal/package.json`
- 创建：`extensions/goal/llm.ts`
- 测试：`extensions/goal/llm.test.ts`

- [ ] **步骤 1：创建 package.json**（mirror `plan-mode/package.json`）

```json
{
  "name": "pi-goal",
  "version": "0.1.0",
  "description": "Goal stop-condition + independent judge for the Pi coding agent (prevents optimistic early stop).",
  "private": true,
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "goal"],
  "license": "MIT",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **步骤 2：编写 llm.ts**（mirror `long-term-memory/llm.ts`）

```ts
// In-process LLM access for the goal judge. Uses the current agent model
// (ctx.model) via pi-ai's completeSimple — no sub-process, no extra API key.
import type { Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type AskFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Extract the first JSON value from possibly noisy / fenced LLM output. */
export function parseJsonLoose<T = unknown>(raw: string): T | undefined {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return undefined;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === open) depth++;
    else if (candidate[i] === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Resolve the judge model: GOAL_MODEL ("provider/id") or the current ctx.model. */
export function resolveModel(
  current: Model<never> | undefined,
  registry: Pick<ModelRegistry, "find">,
  override: string | undefined,
): Model<never> | undefined {
  const spec = override?.trim();
  if (spec && spec.includes("/")) {
    const slash = spec.indexOf("/");
    const found = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (found) return found as Model<never>;
  }
  return current;
}

/** Call the model with system + user prompt; return concatenated assistant text. */
export async function askLlm(
  model: Model<never>,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const { completeSimple } = await import("@earendil-works/pi-ai");
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  };
  const msg = await completeSimple(model, context, { reasoning: "off", signal } as never);
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}
```

- [ ] **步骤 3：编写 llm.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { parseJsonLoose, resolveModel } from "./llm.js";

describe("parseJsonLoose", () => {
  it("parses plain json", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses fenced json with trailing prose", () => {
    expect(parseJsonLoose('```json\n{"v":"ok"}\n```\nthanks')).toEqual({ v: "ok" });
  });
  it("returns undefined on garbage", () => {
    expect(parseJsonLoose("no json here")).toBeUndefined();
  });
});

describe("resolveModel", () => {
  const reg = { find: (p: string, id: string) => (p === "x" && id === "y" ? ({ id: "found" } as never) : undefined) };
  it("resolves provider/id override via registry", () => {
    expect(resolveModel(undefined, reg, "x/y")).toEqual({ id: "found" });
  });
  it("falls back to current when no override", () => {
    expect(resolveModel({ id: "cur" } as never, reg, undefined)).toEqual({ id: "cur" });
  });
  it("falls back to current when override not found", () => {
    expect(resolveModel({ id: "cur" } as never, reg, "nope/missing")).toEqual({ id: "cur" });
  });
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && bunx vitest run goal/llm.test.ts`
预期：PASS（6 个用例）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/goal/package.json extensions/goal/llm.ts extensions/goal/llm.test.ts
git commit -m "feat(goal): scaffold extension + llm helper (parse/resolve/ask)"
```

---

## 任务 2：目标态持久化（state.ts）

**文件：**
- 创建：`extensions/goal/state.ts`
- 测试：`extensions/goal/state.test.ts`

- [ ] **步骤 1：编写 state.ts**

```ts
export interface GoalState {
  condition: string;
  react: number;
}

interface CustomEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

/**
 * Restore goal state from session entries: take the LAST custom entry with
 * customType "goal". A null/empty data (written on /goal clear) yields undefined.
 */
export function restoreFromEntries(entries: CustomEntryLike[]): GoalState | undefined {
  const entry = entries.filter((e) => e.type === "custom" && e.customType === "goal").pop();
  const data = entry?.data as Partial<GoalState> | null | undefined;
  if (data && typeof data.condition === "string" && data.condition.length > 0) {
    return { condition: data.condition, react: Number(data.react) || 0 };
  }
  return undefined;
}
```

- [ ] **步骤 2：编写 state.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { restoreFromEntries } from "./state.js";

describe("restoreFromEntries", () => {
  it("returns undefined when no goal entry", () => {
    expect(restoreFromEntries([])).toBeUndefined();
    expect(restoreFromEntries([{ type: "custom", customType: "plan-mode", data: {} }])).toBeUndefined();
  });
  it("restores the latest goal entry", () => {
    expect(
      restoreFromEntries([{ type: "custom", customType: "goal", data: { condition: "c", react: 2 } }]),
    ).toEqual({ condition: "c", react: 2 });
  });
  it("treats a cleared (null) latest goal entry as no goal", () => {
    expect(
      restoreFromEntries([
        { type: "custom", customType: "goal", data: { condition: "a", react: 1 } },
        { type: "custom", customType: "goal", data: null },
      ]),
    ).toBeUndefined();
  });
});
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd extensions && bunx vitest run goal/state.test.ts`
预期：PASS（3 个用例）。

- [ ] **步骤 4：Commit**

```bash
git add extensions/goal/state.ts extensions/goal/state.test.ts
git commit -m "feat(goal): goal state restore from session entries"
```

---

## 任务 3：裁判（judge.ts）

**文件：**
- 创建：`extensions/goal/judge.ts`
- 测试：`extensions/goal/judge.test.ts`

- [ ] **步骤 1：编写 judge.ts**

```ts
import { type AskFn, parseJsonLoose } from "./llm.js";

export interface Verdict {
  ok: boolean;
  reason: string;
}

/** Flatten heterogeneous AgentMessage[] to "role: text" lines; keep the tail. */
function messageToText(m: unknown): string {
  const obj = (m ?? {}) as { role?: string; content?: unknown };
  const role = obj.role ?? "";
  const content = obj.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return text ? `${role}: ${text}` : "";
}

export function flattenTranscript(messages: unknown[], maxChars = 12000): string {
  return messages.map(messageToText).filter(Boolean).join("\n").slice(-maxChars);
}

const JUDGE_SYSTEM =
  "You are an independent judge. Decide whether the assistant has ACTUALLY satisfied the user's stated " +
  "completion condition, based strictly on the transcript. Be skeptical of optimistic self-claims; require evidence. " +
  'Output STRICT JSON only (no prose): {"verdict":"ok"|"not_ok","reason":string}. ok = condition fully met; not_ok = not yet.';

export function buildJudgeUser(condition: string, transcript: string): string {
  return `Completion condition:\n${condition}\n\nTranscript (most recent last):\n${transcript}`;
}

export function parseVerdict(raw: string): Verdict {
  const parsed = parseJsonLoose<{ verdict?: string; reason?: string }>(raw);
  if (parsed?.verdict === "not_ok") return { ok: false, reason: parsed.reason ?? "条件未满足" };
  if (parsed?.verdict === "ok") return { ok: true, reason: parsed.reason ?? "条件已满足" };
  // Text fallback: only a clear "not ok" keeps the agent going.
  if (/\bnot[_\s-]?ok\b/i.test(raw)) return { ok: false, reason: raw.trim().slice(0, 200) || "条件未满足" };
  // Unparseable → fail-open (release; never trap the user).
  return { ok: true, reason: "裁判输出无法解析，放行" };
}

/** Run the judge. Never throws: any failure is fail-open (ok=true → release). */
export async function judge(ask: AskFn, messages: unknown[], condition: string, maxChars = 12000): Promise<Verdict> {
  try {
    const transcript = flattenTranscript(messages, maxChars);
    const raw = await ask(JUDGE_SYSTEM, buildJudgeUser(condition, transcript));
    return parseVerdict(raw);
  } catch {
    return { ok: true, reason: "裁判调用失败，放行" };
  }
}
```

- [ ] **步骤 2：编写 judge.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { type AskFn } from "./llm.js";
import { flattenTranscript, judge } from "./judge.js";

describe("flattenTranscript", () => {
  it("joins string and block content as role: text", () => {
    expect(
      flattenTranscript([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "yo" }, { type: "thinking", text: "x" }] },
      ]),
    ).toBe("user: hi\nassistant: yo");
  });
});

describe("judge", () => {
  it("ok verdict → ok:true", async () => {
    const ask: AskFn = async () => '{"verdict":"ok","reason":"done"}';
    expect(await judge(ask, [], "c")).toEqual({ ok: true, reason: "done" });
  });
  it("fenced not_ok verdict → ok:false", async () => {
    const ask: AskFn = async () => '```json\n{"verdict":"not_ok","reason":"tests missing"}\n```';
    expect(await judge(ask, [], "c")).toEqual({ ok: false, reason: "tests missing" });
  });
  it("text 'not ok' fallback → ok:false", async () => {
    const ask: AskFn = async () => "Honestly this is not ok yet.";
    expect((await judge(ask, [], "c")).ok).toBe(false);
  });
  it("unparseable → fail-open ok:true", async () => {
    const ask: AskFn = async () => "hmm maybe?";
    expect((await judge(ask, [], "c")).ok).toBe(true);
  });
  it("ask throws → fail-open ok:true", async () => {
    const ask: AskFn = async () => {
      throw new Error("no model");
    };
    expect((await judge(ask, [], "c")).ok).toBe(true);
  });
});
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd extensions && bunx vitest run goal/judge.test.ts`
预期：PASS（6 个用例）。

- [ ] **步骤 4：Commit**

```bash
git add extensions/goal/judge.ts extensions/goal/judge.test.ts
git commit -m "feat(goal): independent judge with fail-open verdict parsing"
```

---

## 任务 4：工厂编排（index.ts）

**文件：**
- 创建：`extensions/goal/index.ts`
- 测试：`extensions/goal/index.test.ts`

- [ ] **步骤 1：编写 index.ts**

```ts
// goal: set a session completion condition; on agent_end an independent judge
// LLM decides whether it is actually met. If not, re-enter (triggerTurn) with
// the reason until met / react cap / user abort. Fail-open on any judge failure.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { type AskFn, askLlm, resolveModel } from "./llm.js";
import { judge } from "./judge.js";
import { type GoalState, restoreFromEntries } from "./state.js";

const enabled = () => (getConfig("GOAL_ENABLED") ?? "1") !== "0";
const maxReact = () => Number(getConfig("GOAL_MAX_REACT") ?? "12") || 12;
const goalModel = () => getConfig("GOAL_MODEL");

export default function (pi: ExtensionAPI) {
  let state: GoalState | undefined;

  const persist = () => pi.appendEntry("goal", state ?? null);

  const setStatus = (ctx: ExtensionContext) =>
    ctx.ui.setStatus("goal", state ? `goal: ${state.condition.slice(0, 24)}` : undefined);

  const makeAsk = (ctx: ExtensionContext): AskFn | undefined => {
    const model = resolveModel(
      ctx.model as never,
      (ctx.modelRegistry ?? { find: () => undefined }) as never,
      goalModel(),
    );
    if (!model) return undefined;
    return (system, user) => askLlm(model, system, user, ctx.signal);
  };

  const clear = (ctx: ExtensionContext) => {
    state = undefined;
    persist();
    setStatus(ctx);
  };

  pi.registerCommand("goal", {
    description: "设定/清除会话完成条件：/goal <条件> | /goal clear",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text || text === "clear") {
        clear(ctx);
        ctx.ui.notify("已清除目标。", "info");
        return;
      }
      state = { condition: text, react: 0 };
      persist();
      setStatus(ctx);
      ctx.ui.notify(`已设定目标：${text}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreFromEntries(ctx.sessionManager.getEntries() as never);
    setStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled() || !state) return;
    if (ctx.signal?.aborted) return; // user abort → do not re-enter

    const ask = makeAsk(ctx);
    if (!ask) {
      ctx.ui.notify("Goal: 无可用裁判模型，已放行。", "warning");
      clear(ctx);
      return;
    }

    const verdict = await judge(ask, event.messages as unknown[], state.condition);
    if (verdict.ok) {
      ctx.ui.notify(`目标达成：${state.condition}`, "info");
      clear(ctx);
      return;
    }
    if (state.react >= maxReact()) {
      ctx.ui.notify(`Goal: 已达重入上限(${maxReact()})，停止。最后判定：${verdict.reason}`, "warning");
      clear(ctx);
      return;
    }
    state.react += 1;
    persist();
    setStatus(ctx);
    pi.sendMessage(
      {
        customType: "goal-reentry",
        content: `目标尚未达成：${verdict.reason}\n请继续完成目标：${state.condition}`,
        display: true,
      },
      { triggerTurn: true },
    );
  });
}
```

- [ ] **步骤 2：编写 index.test.ts（工厂接线 smoke）**

```ts
import { describe, expect, it } from "vitest";
import factory from "./index.js";

describe("goal extension factory", () => {
  it("registers /goal command and session_start/agent_end hooks", () => {
    const commands: string[] = [];
    const events: string[] = [];
    factory({
      registerCommand: (n: string) => commands.push(n),
      on: (e: string) => events.push(e),
      appendEntry: () => {},
      sendMessage: () => {},
    } as never);
    expect(commands).toContain("goal");
    expect(events).toEqual(expect.arrayContaining(["session_start", "agent_end"]));
  });
});
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd extensions && bunx vitest run goal/index.test.ts`
预期：PASS（1 个用例）。

- [ ] **步骤 4：运行 goal 全量测试**

运行：`cd extensions && bunx vitest run goal`
预期：4 个测试文件全 PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/goal/index.ts extensions/goal/index.test.ts
git commit -m "feat(goal): factory wiring (command + session_start/agent_end orchestration)"
```

---

## 任务 5：接入 allExtensions + 构建验证

**文件：**
- 修改：`extensions/index.ts`

- [ ] **步骤 1：在 extensions/index.ts 加 import**

在 import 区（`import longTermMemory from "./long-term-memory/index.js";` 附近、字母序）加：

```ts
import goal from "./goal/index.js";
```

- [ ] **步骤 2：加入 export 块与 allExtensions 数组**

在 `export { ... }` 块内 `planMode,` 之后加 `goal,`；在 `allExtensions` 数组内 `planMode,` 之后加 `goal,`：

```ts
  todo,
  planMode,
  goal,
  knowledgeRag,
```

（两处都要加：`export {}` 与 `allExtensions`。顺序放 planMode 之后，使 goal 的 agent_end 在 plan-mode 之后运行。）

- [ ] **步骤 3：类型/加载冒烟（jiti 解析 index.ts）**

运行：`cd extensions && bunx vitest run goal`
预期：仍全 PASS（确认新增 import 不破坏）。

- [ ] **步骤 4：重编译 sidecar**

运行：`cd tauri-agent && bun run build:sidecar:dev`
预期：成功生成 `src-tauri/binaries/pi-<triple>`，无 “Could not resolve” 报错（goal 的 import 全部可解析）。

> 若 `build:sidecar:dev` 不存在，用 `bun run build:sidecar`（见 `tauri-agent/package.json` scripts）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/index.ts
git commit -m "feat(goal): register goal extension in allExtensions"
```

---

## 任务 6：端到端手测（成功标准验证）

- [ ] **步骤 1：起 app**

运行：`cd tauri-agent && bun run tauri dev`

- [ ] **步骤 2：验证成功标准**

1. 发 `/goal 创建一个 hello.txt 并写入 done`，状态栏出现 `goal: ...`。
2. 让 agent 故意只回答不动手（或条件未满足）→ agent_end 后被裁判判 not_ok → 自动重入并附理由继续。
3. 条件满足后裁判判 ok → 通知“目标达成”，状态栏清空，不再重入。
4. 设 `GOAL_MAX_REACT=2`，构造持续 not_ok → 第 2 次后停止并通知达上限。
5. 设 `/goal` 后立即中止（Esc）一轮 → 不触发重入。

- [ ] **步骤 3：Commit（如有收尾）**

```bash
git add -A
git commit -m "chore(goal): e2e smoke polish"
```

---

## 自检

**规格覆盖度（对照 `2026-06-16-goal-stop-condition-design.md`）：**
- §3 组件 index/judge/state/llm → 任务 1-4。
- §4 数据流（/goal、agent_end 裁判→重入、clear、session_start 恢复）→ 任务 4 index.ts + 任务 2 state。
- §5 错误处理（fail-open、重入上限、中止不重入、无模型）→ judge.ts（fail-open）+ index.ts（cap/abort/no-model）。
- §6 配置（GOAL_MODEL/GOAL_MAX_REACT/GOAL_ENABLED）→ index.ts 顶部 getConfig。
- §7 测试（judge 解析兜底、超上限、fail-open、set/clear、smoke）→ 任务 1-4 各 test。
- §8 文件清单 → 文件结构表 + 任务 1/5。

**占位符扫描：** 无 TODO/待定；每个步骤含完整可运行代码与精确命令。

**类型一致性：** `AskFn`（llm.ts 定义，judge.ts/index.ts 复用）一致；`GoalState`（state.ts 定义，index.ts 复用）一致；`Verdict`（judge.ts）一致；`resolveModel`/`askLlm`/`parseJsonLoose` 命名贯穿；`restoreFromEntries` 在 index.ts 调用名一致；`appendEntry("goal", ...)` 与 `restoreFromEntries` 的 `customType === "goal"` 一致。

**构建依赖提醒：** 任务 5 步骤 4 显式 `build:sidecar`，否则 goal 不进 sidecar 运行时。
