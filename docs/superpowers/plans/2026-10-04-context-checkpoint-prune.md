# 按压力裁工具结果 + 压缩时状态抽取兼作摘要 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** `compaction-policy` 默认按压力裁旧工具结果，裁法在缓存冷时定下、热时原样沿用；`session-memory` 在压缩时读待丢弃消息做唯一一次抽取，结果同时写入状态文件并作为压缩摘要返回。

**架构：** 纯函数放进新文件（`cache-warmth.ts`、`pressure-prune.ts`、`compaction.ts`、`serialize.ts`），入口 `index.ts` 只负责接线和进程内状态。裁剪计划按 `toolCallId` 记在进程内，`session_start` / `session_compact` 清空。状态文件第一行写分支锚点，不在当前分支上就不用。

**技术栈：** TypeScript（ESM）、vitest 4、`@earendil-works/pi-coding-agent` 1.0.2（`convertToLlm`、`serializeConversation`、扩展事件类型）。

**规格：** `docs/superpowers/specs/2026-10-04-context-checkpoint-prune-design.md`

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `extensions/compaction-policy/cache-warmth.ts` | 新建 | TTL 解析、最后活动时间（助手消息与 `cache_warm` 条目）、冷热判断 |
| `extensions/compaction-policy/pressure-prune.ts` | 新建 | 软裁文本、技能读取识别、定案 `planPressurePrune`、套用 `applyPrunePlan`、未裁占用、`runPressurePrune` |
| `extensions/compaction-policy/prune.ts` | 修改 | 导出 `textLength`，删除 `pruneMessages`，保留熔断 |
| `extensions/compaction-policy/index.ts` | 修改 | `context` 钩子接压力裁剪；`session_start` / `session_compact` 清空计划；开关默认开 |
| `extensions/session-memory/store.ts` | 修改 | 状态文件锚点读写、`stateOnBranch` |
| `extensions/session-memory/writer.ts` | 修改 | 压缩抽取的提示词与 `extractCompactionState` |
| `extensions/session-memory/compaction.ts` | 新建 | 前置条件、文件列表合并与格式化、组装压缩结果、判断条目来源 |
| `extensions/session-memory/serialize.ts` | 新建 | 与 Pi 内置摘要同一种序列化 |
| `extensions/session-memory/index.ts` | 重写 | 接线：周期写入带锚点和序号、压缩时抽取并返回结果、按事件字段决定注入 |
| 对应 `*.test.ts` | 新建/修改 | 每个文件的单测 |
| `docs/decisions/extensions/2026-10-04-session-state-as-compaction.md` | 新建 | 决策笔记 |
| `docs/architecture.md` | 修改 | 两个扩展的职责描述 |

所有命令都在仓库根 `D:\OneDrive\Project Files\Pi` 下的 PowerShell 里执行。

---

### 任务 0：基线与前置

**文件：** 无代码改动

- [ ] **步骤 1：确认工作区里没有混进本计划之外的改动**

运行：`git status --short -- extensions/compaction-policy extensions/session-memory docs/decisions/extensions`

当前 `extensions/compaction-policy/index.ts`、`index.test.ts` 已有未提交改动，`resume.ts`、`threshold.ts` 及其测试、对应的决策笔记（`2026-10-02-auto-compact-threshold.md`、`2026-10-03-auto-compact-resume.md`）未跟踪。这些属于自动压缩触发值和续跑的前一项工作。先请负责人把它们单独提交，再开始本计划；否则任务 10 的提交会把两项工作混在一起。

- [ ] **步骤 2：跑基线测试**

运行：`cd extensions; npx vitest run compaction-policy session-memory; cd ..`
预期：11 个文件、49 个用例全部 PASS。

- [ ] **步骤 3：提交规格和本计划**

```powershell
git add docs/superpowers/specs/2026-10-04-context-checkpoint-prune-design.md docs/superpowers/plans/2026-10-04-context-checkpoint-prune.md
git commit -m "docs: spec and plan for pressure prune and session-state compaction"
```

---

### 任务 1：缓存冷热判断

**文件：**
- 创建：`extensions/compaction-policy/cache-warmth.ts`
- 测试：`extensions/compaction-policy/cache-warmth.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/compaction-policy/cache-warmth.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PRUNE_TTL_MS, isCacheCold, lastActivityMs, parsePruneTtlMs } from "./cache-warmth.js";

describe("parsePruneTtlMs", () => {
  it("未设置、空、非法时用 300000", () => {
    expect(parsePruneTtlMs(undefined)).toBe(DEFAULT_PRUNE_TTL_MS);
    expect(parsePruneTtlMs("  ")).toBe(DEFAULT_PRUNE_TTL_MS);
    expect(parsePruneTtlMs("abc")).toBe(DEFAULT_PRUNE_TTL_MS);
    expect(parsePruneTtlMs("-1")).toBe(DEFAULT_PRUNE_TTL_MS);
  });

  it("接受 0 和正数", () => {
    expect(parsePruneTtlMs("0")).toBe(0);
    expect(parsePruneTtlMs("3600000")).toBe(3_600_000);
  });
});

describe("lastActivityMs", () => {
  it("取最后一条助手消息的时间戳", () => {
    const msgs = [
      { role: "assistant", timestamp: 1000 },
      { role: "user", timestamp: 2000 },
      { role: "assistant", timestamp: 3000 },
      { role: "toolResult", timestamp: 4000 },
    ];
    expect(lastActivityMs(msgs, [])).toBe(3000);
  });

  it("cache_warm 条目更晚时以它为准", () => {
    const branch = [{ type: "usage", kind: "cache_warm", timestamp: new Date(5000).toISOString() }];
    expect(lastActivityMs([{ role: "assistant", timestamp: 1000 }], branch)).toBe(5000);
  });

  it("助手消息更晚时以助手消息为准", () => {
    const branch = [{ type: "usage", kind: "cache_warm", timestamp: new Date(500).toISOString() }];
    expect(lastActivityMs([{ role: "assistant", timestamp: 1000 }], branch)).toBe(1000);
  });

  it("其他 usage 条目不算", () => {
    const branch = [{ type: "usage", kind: "other", timestamp: new Date(9000).toISOString() }];
    expect(lastActivityMs([{ role: "assistant", timestamp: 1000 }], branch)).toBe(1000);
  });

  it("都取不到时返回 undefined", () => {
    expect(lastActivityMs([{ role: "assistant" }], [])).toBeUndefined();
    expect(lastActivityMs([], [])).toBeUndefined();
  });
});

describe("isCacheCold", () => {
  it("按 TTL 判断", () => {
    expect(isCacheCold(10_000, 9_000, 5_000)).toBe(false);
    expect(isCacheCold(10_000, 5_000, 5_000)).toBe(true);
  });

  it("没有活动或 TTL 为 0 时为冷", () => {
    expect(isCacheCold(10_000, undefined, 5_000)).toBe(true);
    expect(isCacheCold(10_000, 9_999, 0)).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run compaction-policy/cache-warmth.test.ts; cd ..`
预期：FAIL，报错找不到 `./cache-warmth.js`。

- [ ] **步骤 3：编写实现**

创建 `extensions/compaction-policy/cache-warmth.ts`：

```ts
// 提示缓存冷热判断。最后活动 = 最后一条助手消息与分支上最后一次 cache_warm 保温中较晚的那个。
// Pi 1.0.2 的 CacheWarmer 保温不产生助手消息，只在分支上追加 type "usage"、kind "cache_warm" 的条目。

export const DEFAULT_PRUNE_TTL_MS = 300_000;

type TimedMessage = { role?: string; timestamp?: unknown };
type BranchEntryLike = { type?: string; kind?: string; timestamp?: unknown };

/** COMPACTION_POLICY_PRUNE_TTL_MS：未设置、空或非法时 300000；0 表示每次都按冷处理。 */
export function parsePruneTtlMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_PRUNE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PRUNE_TTL_MS;
}

function toMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export function lastActivityMs(
  messages: readonly TimedMessage[],
  branch: readonly BranchEntryLike[],
): number | undefined {
  let assistant: number | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    assistant = toMs(messages[i].timestamp);
    break;
  }
  let warm: number | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e?.type !== "usage" || e.kind !== "cache_warm") continue;
    warm = toMs(e.timestamp);
    break;
  }
  if (assistant == null) return warm;
  if (warm == null) return assistant;
  return Math.max(assistant, warm);
}

export function isCacheCold(now: number, lastActivity: number | undefined, ttlMs: number): boolean {
  if (ttlMs === 0 || lastActivity == null) return true;
  return now - lastActivity >= ttlMs;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run compaction-policy/cache-warmth.test.ts; cd ..`
预期：PASS（9 个用例）。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/compaction-policy/cache-warmth.ts extensions/compaction-policy/cache-warmth.test.ts
git commit -m "feat(compaction-policy): detect cold prompt cache from assistant and cache_warm entries"
```

---

### 任务 2：定案与套用（纯函数）

**文件：**
- 修改：`extensions/compaction-policy/prune.ts`（导出 `textLength`）
- 修改：`extensions/compaction-policy/prune.test.ts`
- 创建：`extensions/compaction-policy/pressure-prune.ts`
- 测试：`extensions/compaction-policy/pressure-prune.test.ts`

- [ ] **步骤 1：编写失败的测试**

`extensions/compaction-policy/prune.test.ts` 第 2 行改为：

```ts
import { fuseOversizeToolResults, pruneMessages, textLength } from "./prune.js";
```

并在 `describe("fuseOversizeToolResults"` 之前插入：

```ts
describe("textLength", () => {
  it("只加总文本块", () => {
    expect(textLength([{ type: "text", text: "abc" }, { type: "image" }, { type: "text", text: "de" }])).toBe(5);
    expect(textLength("plain")).toBe(0);
  });
});

```

创建 `extensions/compaction-policy/pressure-prune.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  applyPrunePlan,
  planPressurePrune,
  prunePlaceholder,
  RECENT_KEEP_CHARS,
  softTrimText,
} from "./pressure-prune.js";

type Msg = { role: string; content: unknown; toolCallId?: string; toolName?: string; timestamp?: number };

const user = (t: string): Msg => ({ role: "user", content: t });
const asst = (calls: Array<{ id: string; name?: string; path?: string }> = [], timestamp?: number): Msg => ({
  role: "assistant",
  timestamp,
  content: calls.map((c) => ({
    type: "toolCall",
    id: c.id,
    name: c.name ?? "bash",
    arguments: c.path ? { path: c.path } : {},
  })),
});
const tr = (id: string, text: string, toolName = "bash", extra: unknown[] = []): Msg => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  content: [{ type: "text", text }, ...extra],
});
const textOf = (m: Msg) => (m.content as Array<{ text?: string }>)[0].text;
const image = { type: "image", data: "AAAA", mimeType: "image/png" };

// 保护范围从 u1 开始（keepRecentTurns = 1）。near 刚好用满 160000，old 及更早进入候选。
const scenario = (): Msg[] => [
  user("u0"),
  asst([{ id: "tiny" }, { id: "old" }, { id: "near" }], 1_000),
  tr("tiny", "t".repeat(100)),
  tr("old", "o".repeat(5000)),
  tr("near", "n".repeat(RECENT_KEEP_CHARS)),
  user("u1"),
  asst([{ id: "fresh" }], 2_000),
  tr("fresh", "f".repeat(50_000)),
];

describe("softTrimText", () => {
  it("留头尾各 1536，中间写去掉的字符数", () => {
    const out = softTrimText("x".repeat(5000));
    expect(out).toBe(`${"x".repeat(1536)}\n[... trimmed, removed 1928 chars ...]\n${"x".repeat(1536)}`);
  });

  it("不切开代理对", () => {
    const text = `${"a".repeat(1535)}😀${"b".repeat(3000)}😀${"c".repeat(1535)}`;
    expect(softTrimText(text)).toBe(`${"a".repeat(1535)}\n[... trimmed, removed 3004 chars ...]\n${"c".repeat(1535)}`);
  });
});

describe("planPressurePrune", () => {
  const opts = { keepRecentTurns: 1, minBodyChars: 1000 };

  it("等级 0 不裁", () => {
    expect(planPressurePrune(scenario(), { ...opts, level: 0 }).size).toBe(0);
  });

  it("用户消息不超过保留轮数时不裁", () => {
    expect(planPressurePrune(scenario(), { ...opts, keepRecentTurns: 2, level: 3 }).size).toBe(0);
  });

  it("等级 1：最近 160000 字符和保护范围内不动，跨界那条起超过 4096 的标 soft", () => {
    const plan = planPressurePrune(scenario(), { ...opts, level: 1 });
    expect([...plan]).toEqual([["old", "soft"]]);
  });

  it("读 SKILL.md 的结果不计入 160000，也不进入候选", () => {
    const msgs: Msg[] = [
      user("u0"),
      asst([{ id: "old" }, { id: "near" }, { id: "sk", name: "read", path: "C:\\skills\\demo\\SKILL.md" }], 1_000),
      tr("old", "o".repeat(5000)),
      tr("near", "n".repeat(RECENT_KEEP_CHARS)),
      tr("sk", "s".repeat(200_000), "read"),
      user("u1"),
    ];
    const plan = planPressurePrune(msgs, { ...opts, level: 1 });
    expect([...plan]).toEqual([["old", "soft"]]);
  });

  it("等级 2：整段替换省下达到 80000 时标 replace，短于 MIN_BODY 的不动", () => {
    const msgs: Msg[] = [
      user("u0"),
      asst([], 1_000),
      tr("small", "s".repeat(500)),
      tr("big1", "a".repeat(50_000)),
      tr("big2", "b".repeat(50_000)),
      tr("near", "n".repeat(RECENT_KEEP_CHARS)),
      user("u1"),
    ];
    const plan = planPressurePrune(msgs, { ...opts, level: 2 });
    expect(Object.fromEntries(plan)).toEqual({ big1: "replace", big2: "replace" });
  });

  it("等级 3：省下不足 80000 时退回软裁", () => {
    const plan = planPressurePrune(scenario(), { ...opts, level: 3 });
    expect([...plan]).toEqual([["old", "soft"]]);
  });
});

describe("applyPrunePlan", () => {
  it("soft：文本块用换行接成一块放最前，非文本块跟在后面，不改输入", () => {
    const msg: Msg = {
      role: "toolResult",
      toolCallId: "x",
      toolName: "read",
      content: [{ type: "text", text: "p".repeat(3000) }, image, { type: "text", text: "q".repeat(3000) }],
    };
    const before = structuredClone(msg);
    const res = applyPrunePlan([msg], new Map([["x", "soft"]]));
    expect(res.applied).toBe(1);
    expect(res.messages[0].content).toEqual([
      { type: "text", text: `${"p".repeat(1536)}\n[... trimmed, removed 2929 chars ...]\n${"q".repeat(1536)}` },
      image,
    ]);
    expect(res.savedChars).toBe(6001 - textOf(res.messages[0])!.length);
    expect(msg).toEqual(before);
  });

  it("replace：整段换成占位，去掉非文本块", () => {
    const msg = tr("x", "z".repeat(2000), "", [image]);
    const res = applyPrunePlan([msg], new Map([["x", "replace"]]));
    expect(res.messages[0].content).toEqual([{ type: "text", text: prunePlaceholder(undefined, 2000) }]);
    expect(textOf(res.messages[0])).toBe("[pruned tool output: tool, 2000 chars]");
  });

  it("空计划或没命中时返回原数组", () => {
    const msgs = scenario();
    expect(applyPrunePlan(msgs, new Map()).messages).toBe(msgs);
    expect(applyPrunePlan(msgs, new Map([["missing", "soft"]])).messages).toBe(msgs);
  });

  it("soft 遇到不超过 4096 的正文保持原文", () => {
    const msgs = [tr("x", "short")];
    expect(applyPrunePlan(msgs, new Map([["x", "soft"]])).messages).toBe(msgs);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run compaction-policy/prune.test.ts compaction-policy/pressure-prune.test.ts; cd ..`
预期：FAIL。`pressure-prune.test.ts` 找不到 `./pressure-prune.js`；`prune.test.ts` 的 `textLength` 用例报 `textLength is not a function`。

- [ ] **步骤 3：编写实现**

`extensions/compaction-policy/prune.ts` 第 11 行：

```ts
function textLength(content: unknown): number {
```

改为：

```ts
export function textLength(content: unknown): number {
```

创建 `extensions/compaction-policy/pressure-prune.ts`：

```ts
// 按压力裁旧工具结果：缓存冷时定案（planPressurePrune），热时把同一份计划原样重放（applyPrunePlan）。
// 只改发往模型的副本，不原地修改消息对象。计划按 toolCallId 认消息：context 钩子每次拿到的是新克隆。
import { textLength } from "./prune.js";

export const RECENT_KEEP_CHARS = 160_000;
export const SOFT_TRIM_MIN_CHARS = 4096;
export const SOFT_TRIM_HEAD = 1536;
export const SOFT_TRIM_TAIL = 1536;
export const HARD_PRUNE_MIN_SAVINGS = 80_000;

export type PruneMode = "soft" | "replace";
export type PrunePlan = ReadonlyMap<string, PruneMode>;

export type PruneMessageLike = {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
};

type TextBlock = { type: "text"; text: string };

const isTextBlock = (c: unknown): c is TextBlock =>
  !!c &&
  typeof c === "object" &&
  (c as { type?: unknown }).type === "text" &&
  typeof (c as { text?: unknown }).text === "string";

function joinedText(content: unknown): string {
  return Array.isArray(content) ? content.filter(isTextBlock).map((c) => c.text).join("\n") : "";
}

function nonTextBlocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content.filter((c) => !isTextBlock(c)) : [];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** 前 1536、后 1536 个 UTF-16 码元，中间一行说明。调用方保证 text.length > SOFT_TRIM_MIN_CHARS。 */
export function softTrimText(text: string): string {
  let head = text.slice(0, SOFT_TRIM_HEAD);
  if (head.length > 0 && isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
  let tail = text.slice(text.length - SOFT_TRIM_TAIL);
  if (tail.length > 0 && isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1);
  const removed = text.length - head.length - tail.length;
  return `${head}\n[... trimmed, removed ${removed} chars ...]\n${tail}`;
}

export function prunePlaceholder(toolName: string | undefined, chars: number): string {
  return `[pruned tool output: ${toolName || "tool"}, ${chars} chars]`;
}

function readPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const { path, file_path } = args as { path?: unknown; file_path?: unknown };
  if (typeof path === "string") return path;
  return typeof file_path === "string" ? file_path : "";
}

/** 助手消息里直接读 SKILL.md 的 read 调用 id。codemode 嵌套调用不在这里。 */
export function skillReadCallIds(messages: readonly PruneMessageLike[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const c of m.content as Array<{ type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }>) {
      if (c?.type !== "toolCall" || c.name !== "read" || typeof c.id !== "string") continue;
      if (readPath(c.arguments).split(/[\\/]/).pop() === "SKILL.md") ids.add(c.id);
    }
  }
  return ids;
}

export interface PlanOptions {
  level: 0 | 1 | 2 | 3;
  keepRecentTurns: number;
  minBodyChars: number;
}

export function planPressurePrune(messages: readonly PruneMessageLike[], opts: PlanOptions): Map<string, PruneMode> {
  const plan = new Map<string, PruneMode>();
  if (opts.level === 0) return plan;
  const userIdxs: number[] = [];
  messages.forEach((m, i) => {
    if (m?.role === "user") userIdxs.push(i);
  });
  if (userIdxs.length <= opts.keepRecentTurns) return plan;
  const protectFrom = userIdxs[userIdxs.length - opts.keepRecentTurns];
  const skills = skillReadCallIds(messages);
  const candidates: Array<{ id: string; len: number; toolName?: string }> = [];
  let recent = 0;
  for (let i = protectFrom - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
    if (skills.has(m.toolCallId)) continue;
    const len = textLength(m.content);
    recent += len;
    if (recent <= RECENT_KEEP_CHARS) continue;
    candidates.push({ id: m.toolCallId, len, toolName: m.toolName });
  }
  if (opts.level >= 2) {
    const whole = candidates.filter((c) => c.len >= opts.minBodyChars);
    const savings = whole.reduce((n, c) => n + c.len - prunePlaceholder(c.toolName, c.len).length, 0);
    if (savings >= HARD_PRUNE_MIN_SAVINGS) {
      for (const c of whole) plan.set(c.id, "replace");
      return plan;
    }
  }
  for (const c of candidates) if (c.len > SOFT_TRIM_MIN_CHARS) plan.set(c.id, "soft");
  return plan;
}

export interface ApplyResult<T> {
  messages: T[];
  savedChars: number;
  applied: number;
}

export function applyPrunePlan<T extends PruneMessageLike>(messages: T[], plan: PrunePlan): ApplyResult<T> {
  if (plan.size === 0) return { messages, savedChars: 0, applied: 0 };
  let savedChars = 0;
  let applied = 0;
  const out = messages.map((m) => {
    if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") return m;
    const mode = plan.get(m.toolCallId);
    if (mode === "replace") {
      const len = textLength(m.content);
      const text = prunePlaceholder(m.toolName, len);
      savedChars += Math.max(0, len - text.length);
      applied++;
      return { ...m, content: [{ type: "text", text }] } as T;
    }
    if (mode === "soft") {
      const joined = joinedText(m.content);
      if (joined.length <= SOFT_TRIM_MIN_CHARS) return m;
      const text = softTrimText(joined);
      savedChars += joined.length - text.length;
      applied++;
      return { ...m, content: [{ type: "text", text }, ...nonTextBlocks(m.content)] } as T;
    }
    return m;
  });
  return { messages: applied ? out : messages, savedChars, applied };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run compaction-policy/prune.test.ts compaction-policy/pressure-prune.test.ts; cd ..`
预期：两个文件 PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/compaction-policy/prune.ts extensions/compaction-policy/prune.test.ts extensions/compaction-policy/pressure-prune.ts extensions/compaction-policy/pressure-prune.test.ts
git commit -m "feat(compaction-policy): plan and apply pressure-based tool result trimming"
```

---

### 任务 3：冷时定案、热时沿用

**文件：**
- 修改：`extensions/compaction-policy/pressure-prune.ts`
- 测试：`extensions/compaction-policy/pressure-prune.test.ts`

- [ ] **步骤 1：编写失败的测试**

`pressure-prune.test.ts` 的 import 改为：

```ts
import {
  applyPrunePlan,
  emptyPruneState,
  planPressurePrune,
  prunePlaceholder,
  RECENT_KEEP_CHARS,
  runPressurePrune,
  softTrimText,
  unprunedPercent,
} from "./pressure-prune.js";
```

在文件末尾追加：

```ts
describe("unprunedPercent", () => {
  it("把省下的字符折回百分比", () => {
    expect(unprunedPercent({ percent: 45, contextWindow: 100_000 }, 40_000)).toBe(55);
  });

  it("百分比缺失时返回 null", () => {
    expect(unprunedPercent({ percent: null, contextWindow: 100_000 }, 0)).toBeNull();
    expect(unprunedPercent(undefined, 0)).toBeNull();
  });
});

describe("runPressurePrune", () => {
  const base = { keepRecentTurns: 1, minBodyChars: 1000, ttlMs: 300_000 };
  const now = 10_000_000;

  it("冷时定案并套用，热时沿用同一份计划，即使占用已掉到 0 级", () => {
    const cold = runPressurePrune(emptyPruneState(), {
      ...base,
      messages: scenario(),
      now,
      lastActivity: now - 600_000,
      usage: { percent: 60, contextWindow: 200_000 },
    });
    const trimmed = textOf(cold.messages[3]);
    expect(trimmed).toContain("[... trimmed, removed");
    expect(cold.state.plan.get("old")).toBe("soft");
    expect(cold.state.savedChars).toBeGreaterThan(0);

    const next = [...scenario(), asst([], now - 1_000)];
    const warm = runPressurePrune(cold.state, {
      ...base,
      messages: next,
      now,
      lastActivity: now - 1_000,
      usage: { percent: 10, contextWindow: 200_000 },
    });
    expect(textOf(warm.messages[3])).toBe(trimmed);
    expect(warm.state.plan).toBe(cold.state.plan);
  });

  it("热且没有计划时，高占用也不裁", () => {
    const msgs = scenario();
    const res = runPressurePrune(emptyPruneState(), {
      ...base,
      messages: msgs,
      now,
      lastActivity: now - 1_000,
      usage: { percent: 95, contextWindow: 200_000 },
    });
    expect(res.messages).toBe(msgs);
  });

  it("再次变冷时按新等级重算", () => {
    const first = runPressurePrune(emptyPruneState(), {
      ...base,
      messages: scenario(),
      now,
      lastActivity: now - 600_000,
      usage: { percent: 60, contextWindow: 200_000 },
    });
    const again = runPressurePrune(first.state, {
      ...base,
      messages: scenario(),
      now,
      lastActivity: now - 600_000,
      usage: { percent: 5, contextWindow: 200_000 },
    });
    expect(again.state.plan.size).toBe(0);
  });

  it("上一次省下的字符折回后等级不下降", () => {
    const state = { plan: new Map(), savedChars: 40_000 };
    const res = runPressurePrune(state, {
      ...base,
      messages: scenario(),
      now,
      lastActivity: now - 600_000,
      usage: { percent: 45, contextWindow: 100_000 },
    });
    expect(res.state.plan.get("old")).toBe("soft");
  });

  it("百分比缺失时冷定案为空计划", () => {
    const msgs = scenario();
    const res = runPressurePrune(emptyPruneState(), {
      ...base,
      messages: msgs,
      now,
      lastActivity: undefined,
      usage: { percent: null, contextWindow: 200_000 },
    });
    expect(res.messages).toBe(msgs);
    expect(res.state.plan.size).toBe(0);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run compaction-policy/pressure-prune.test.ts; cd ..`
预期：FAIL，`unprunedPercent` / `runPressurePrune` / `emptyPruneState` 不是函数。

- [ ] **步骤 3：编写实现**

`pressure-prune.ts` 顶部的 import 改为：

```ts
import { isCacheCold } from "./cache-warmth.js";
import { classify } from "./pressure.js";
import { textLength } from "./prune.js";
```

在文件末尾追加：

```ts
export interface ContextUsageLike {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

/** 把上一次请求省下的字符按 4 字符约 1 token 折回，得到未裁时的占用百分比。 */
export function unprunedPercent(usage: ContextUsageLike | undefined, savedChars: number): number | null {
  const percent = usage?.percent;
  if (percent == null || !Number.isFinite(percent)) return null;
  const contextWindow = usage?.contextWindow ?? 0;
  if (!(contextWindow > 0) || !(savedChars > 0)) return percent;
  return percent + (savedChars / 4 / contextWindow) * 100;
}

export interface PruneState {
  plan: PrunePlan;
  /** 上一次请求按计划省下的字符数。 */
  savedChars: number;
}

export const emptyPruneState = (): PruneState => ({ plan: new Map(), savedChars: 0 });

export interface PressurePruneInput<T> {
  messages: T[];
  now: number;
  lastActivity: number | undefined;
  ttlMs: number;
  usage: ContextUsageLike | undefined;
  keepRecentTurns: number;
  minBodyChars: number;
}

/** 冷：按未裁占用重新定案；热：沿用已有计划。返回本次要发的消息和新状态。 */
export function runPressurePrune<T extends PruneMessageLike>(
  state: PruneState,
  input: PressurePruneInput<T>,
): { messages: T[]; state: PruneState } {
  let plan = state.plan;
  if (isCacheCold(input.now, input.lastActivity, input.ttlMs)) {
    const percent = unprunedPercent(input.usage, state.savedChars);
    const level = percent == null ? 0 : classify(percent).level;
    plan = planPressurePrune(input.messages, {
      level,
      keepRecentTurns: input.keepRecentTurns,
      minBodyChars: input.minBodyChars,
    });
  }
  const res = applyPrunePlan(input.messages, plan);
  return { messages: res.messages, state: { plan, savedChars: res.savedChars } };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run compaction-policy/pressure-prune.test.ts; cd ..`
预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/compaction-policy/pressure-prune.ts extensions/compaction-policy/pressure-prune.test.ts
git commit -m "feat(compaction-policy): latch the prune plan while the prompt cache is warm"
```

---

### 任务 4：状态文件分支锚点

**文件：**
- 修改：`extensions/session-memory/store.ts`
- 测试：`extensions/session-memory/store.test.ts`

- [ ] **步骤 1：编写失败的测试**

`store.test.ts` 第 5 行改为：

```ts
import { readState, readStateDoc, stateOnBranch, statePath, writeState, writeStateDoc } from "./store.js";
```

在文件末尾追加：

```ts
describe("state doc 锚点", () => {
  it("带锚点写入后读回正文和锚点", () => {
    const p = statePath(mkdtempSync(join(tmpdir(), "sm-")), "s");
    writeStateDoc(p, "## Intent\n- x", "e42");
    expect(readState(p)).toBe("<!-- session-state anchor=e42 -->\n## Intent\n- x");
    expect(readStateDoc(p)).toEqual({ body: "## Intent\n- x", anchor: "e42" });
  });

  it("没有锚点的旧文件只读出正文", () => {
    const p = statePath(mkdtempSync(join(tmpdir(), "sm-")), "s");
    writeState(p, "## Intent\n- legacy");
    expect(readStateDoc(p)).toEqual({ body: "## Intent\n- legacy" });
  });

  it("stateOnBranch 只在锚点位于分支且正文非空时返回正文", () => {
    const branch = [{ id: "e1" }, { id: "e2" }];
    expect(stateOnBranch({ body: "## Intent", anchor: "e2" }, branch)).toBe("## Intent");
    expect(stateOnBranch({ body: "## Intent", anchor: "gone" }, branch)).toBeUndefined();
    expect(stateOnBranch({ body: "## Intent" }, branch)).toBeUndefined();
    expect(stateOnBranch({ body: "  \n", anchor: "e1" }, branch)).toBeUndefined();
    expect(stateOnBranch(undefined, branch)).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run session-memory/store.test.ts; cd ..`
预期：FAIL，`writeStateDoc` / `readStateDoc` / `stateOnBranch` 不是函数。

- [ ] **步骤 3：编写实现**

`extensions/session-memory/store.ts` 整个文件替换为：

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function statePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "session-state", `${sessionId}.md`);
}

export function writeState(path: string, md: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, md, "utf8");
}

export function readState(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 第一行的分支锚点：写入开始时分支最后一条条目（叶子）的 id。 */
const ANCHOR_LINE = /^<!-- session-state anchor=(\S+) -->\r?\n/;

export interface StateDoc {
  body: string;
  anchor?: string;
}

export function readStateDoc(path: string): StateDoc | undefined {
  const raw = readState(path);
  if (raw == null) return undefined;
  const m = ANCHOR_LINE.exec(raw);
  return m ? { body: raw.slice(m[0].length), anchor: m[1] } : { body: raw };
}

export function writeStateDoc(path: string, body: string, anchor: string | undefined): void {
  writeState(path, anchor ? `<!-- session-state anchor=${anchor} -->\n${body}` : body);
}

/** 状态属于当前分支时返回正文：锚点存在、出现在分支条目 id 里、正文非空。没有锚点的旧文件不用。 */
export function stateOnBranch(
  doc: StateDoc | undefined,
  branch: readonly { id?: string }[],
): string | undefined {
  if (!doc?.anchor || !doc.body.trim()) return undefined;
  return branch.some((e) => e?.id === doc.anchor) ? doc.body : undefined;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run session-memory/store.test.ts; cd ..`
预期：PASS（5 个用例）。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/session-memory/store.ts extensions/session-memory/store.test.ts
git commit -m "feat(session-memory): anchor the state file to a branch entry"
```

---

### 任务 5：压缩抽取的提示词

**文件：**
- 修改：`extensions/session-memory/writer.ts`
- 测试：`extensions/session-memory/writer.test.ts`

- [ ] **步骤 1：编写失败的测试**

`writer.test.ts` 第 3 行改为：

```ts
import { buildCompactionPrompt, extractCompactionState, extractState } from "./writer.js";
```

在文件末尾追加：

```ts
describe("buildCompactionPrompt", () => {
  it("按顺序放上一份状态、上一份摘要、待丢弃对话和切轮前缀", () => {
    const prompt = buildCompactionPrompt({
      prevState: "## Intent\n- prev",
      previousSummary: "old summary",
      conversation: "[User]: hi",
      turnPrefix: "[User]: current turn",
    });
    const order = ["<previous-state>", "<previous-summary>", "<conversation>", "<current-turn-prefix>"].map((t) =>
      prompt.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain("<previous-state>\n## Intent\n- prev\n</previous-state>");
    expect(prompt).toContain("middle of the following turn");
  });

  it("缺的段省略", () => {
    const prompt = buildCompactionPrompt({ conversation: "[User]: hi" });
    expect(prompt).toBe("<conversation>\n[User]: hi\n</conversation>");
  });
});

describe("extractCompactionState", () => {
  it("成功时返回去掉首尾空白的输出，系统提示说明输出会替换历史", async () => {
    let system = "";
    const ask: AskFn = async (s) => {
      system = s;
      return "  ## Intent\n- x  ";
    };
    expect(await extractCompactionState(ask, { conversation: "c" })).toBe("## Intent\n- x");
    expect(system).toContain("your output replaces it");
    expect(system).toContain("## Key decisions");
  });

  it("空输出或抛错时返回 undefined，不回退到旧状态", async () => {
    expect(await extractCompactionState(async () => "  ", { conversation: "c", prevState: "old" })).toBeUndefined();
    const failing: AskFn = async () => {
      throw new Error("overflow");
    };
    expect(await extractCompactionState(failing, { conversation: "c", prevState: "old" })).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run session-memory/writer.test.ts; cd ..`
预期：FAIL，`buildCompactionPrompt` / `extractCompactionState` 不是函数。

- [ ] **步骤 3：编写实现**

`extensions/session-memory/writer.ts` 整个文件替换为：

```ts
import type { AskFn } from "./llm.js";

const SYSTEM =
  "You maintain a concise working-state summary of a coding session. Given the conversation, output " +
  "GitHub-flavored markdown with EXACTLY these sections (short bullet points): " +
  "'## Intent', '## Next step', '## Task progress', '## Key files', '## Key decisions'. " +
  "If a section has nothing, write '- (none)'. Output only the markdown, no prose around it.";

const COMPACTION_SYSTEM =
  "You maintain a concise working-state summary of a coding session. The earlier part of the conversation " +
  "is about to be removed from the context and your output replaces it. Merge the previous state, the previous " +
  "summary and the conversation into GitHub-flavored markdown with EXACTLY these sections (short bullet points): " +
  "'## Intent', '## Next step', '## Task progress', '## Key files', '## Key decisions'. " +
  "Keep every fact needed to continue: user requirements and constraints, finished and pending steps, file paths, " +
  "decisions with their reasons, unresolved errors. Drop details that no longer matter. " +
  "Messages after this point are kept verbatim and do not need to be restated. " +
  "If a section has nothing, write '- (none)'. Output only the markdown, no prose around it.";

export interface CompactionStateInput {
  prevState?: string;
  previousSummary?: string;
  /** 已序列化的待丢弃对话。 */
  conversation: string;
  /** 切在一轮中间时，这一轮前半段的序列化文本。 */
  turnPrefix?: string;
}

export function buildCompactionPrompt(input: CompactionStateInput): string {
  const parts: string[] = [];
  if (input.prevState?.trim()) parts.push(`<previous-state>\n${input.prevState.trim()}\n</previous-state>`);
  if (input.previousSummary?.trim()) {
    parts.push(`<previous-summary>\n${input.previousSummary.trim()}\n</previous-summary>`);
  }
  parts.push(`<conversation>\n${input.conversation}\n</conversation>`);
  if (input.turnPrefix?.trim()) {
    parts.push(
      "The kept messages start in the middle of the following turn. " +
        "Cover the user's request in this turn and the progress so far.\n" +
        `<current-turn-prefix>\n${input.turnPrefix}\n</current-turn-prefix>`,
    );
  }
  return parts.join("\n\n");
}

/** 压缩时的抽取。失败或空输出返回 undefined，由调用方交给 Pi；不回退到旧状态。 */
export async function extractCompactionState(ask: AskFn, input: CompactionStateInput): Promise<string | undefined> {
  try {
    const out = (await ask(COMPACTION_SYSTEM, buildCompactionPrompt(input))).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Extract structured state markdown. On empty/failed output, keep `prev` (graceful). */
export async function extractState(ask: AskFn, transcript: string, prev?: string): Promise<string | undefined> {
  try {
    const user = prev
      ? `Previous state:\n${prev}\n\nConversation (most recent last):\n${transcript}`
      : `Conversation (most recent last):\n${transcript}`;
    const out = (await ask(SYSTEM, user)).trim();
    return out.length > 0 ? out : prev;
  } catch {
    return prev;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run session-memory/writer.test.ts; cd ..`
预期：PASS（7 个用例）。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/session-memory/writer.ts extensions/session-memory/writer.test.ts
git commit -m "feat(session-memory): compaction-time state extraction prompt"
```

---

### 任务 6：组装压缩结果

**文件：**
- 创建：`extensions/session-memory/compaction.ts`
- 测试：`extensions/session-memory/compaction.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/session-memory/compaction.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  buildStateCompaction,
  canUseStateSummary,
  formatFileAppendix,
  isStateCompaction,
  mergeFileLists,
  previousStateFileLists,
} from "./compaction.js";

const ops = (read: string[], edited: string[], written: string[]) => ({
  read: new Set(read),
  edited: new Set(edited),
  written: new Set(written),
});

describe("canUseStateSummary", () => {
  const preparation = { firstKeptEntryId: "k1", tokensBefore: 100 };

  it("准备数据完整且没有附言时可用", () => {
    expect(canUseStateSummary({ preparation })).toBe(true);
    expect(canUseStateSummary({ preparation, customInstructions: "  " })).toBe(true);
  });

  it("带附言或准备数据不全时不可用", () => {
    expect(canUseStateSummary({ preparation, customInstructions: "focus" })).toBe(false);
    expect(canUseStateSummary({ preparation: { firstKeptEntryId: "", tokensBefore: 1 } })).toBe(false);
    expect(canUseStateSummary({ preparation: { firstKeptEntryId: "k1", tokensBefore: Number.NaN } })).toBe(false);
    expect(canUseStateSummary({})).toBe(false);
  });
});

describe("mergeFileLists", () => {
  it("edited/written 合入 modified，read 去掉已改的，合并上一份并排序", () => {
    const lists = mergeFileLists(ops(["b.ts", "a.ts"], ["b.ts"], ["c.ts"]), {
      readFiles: ["z.ts"],
      modifiedFiles: ["y.ts"],
    });
    expect(lists).toEqual({ readFiles: ["a.ts", "z.ts"], modifiedFiles: ["b.ts", "c.ts", "y.ts"] });
  });

  it("没有 fileOps 时只用上一份", () => {
    expect(mergeFileLists(undefined, { readFiles: ["r"], modifiedFiles: [] })).toEqual({
      readFiles: ["r"],
      modifiedFiles: [],
    });
  });
});

describe("previousStateFileLists", () => {
  const ours = { type: "compaction", details: { source: "session-state", readFiles: ["r.ts"], modifiedFiles: ["m.ts"] } };
  const pis = { type: "compaction", details: { readFiles: ["p.ts"], modifiedFiles: [] } };

  it("最后一条压缩是本扩展写的时取它的列表", () => {
    expect(previousStateFileLists([pis, { type: "message" }, ours, { type: "message" }])).toEqual({
      readFiles: ["r.ts"],
      modifiedFiles: ["m.ts"],
    });
  });

  it("最后一条压缩是 Pi 写的时不合并", () => {
    expect(previousStateFileLists([ours, pis])).toEqual({ readFiles: [], modifiedFiles: [] });
    expect(previousStateFileLists([])).toEqual({ readFiles: [], modifiedFiles: [] });
  });
});

describe("formatFileAppendix", () => {
  it("与 Pi 同样的标签，空的一类不写", () => {
    expect(formatFileAppendix({ readFiles: [], modifiedFiles: ["b.ts"] })).toBe("<modified-files>\nb.ts\n</modified-files>");
    expect(formatFileAppendix({ readFiles: [], modifiedFiles: [] })).toBe("");
  });

  it("每类最多 40 条，多出的写 (n more)", () => {
    const files = Array.from({ length: 45 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const text = formatFileAppendix({ readFiles: files, modifiedFiles: [] });
    expect(text).toContain("f39.ts\n(5 more)\n</read-files>");
    expect(text).not.toContain("f40.ts");
  });
});

describe("buildStateCompaction", () => {
  it("摘要以正文开头、空一行接附录，切点与 tokensBefore 原样带回，details 存完整列表", () => {
    const files = Array.from({ length: 41 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const result = buildStateCompaction(
      "## Intent\n- x",
      { firstKeptEntryId: "k1", tokensBefore: 1234 },
      { readFiles: files, modifiedFiles: [] },
    );
    expect(result.summary.startsWith("## Intent\n- x\n\n<read-files>\n")).toBe(true);
    expect(result.firstKeptEntryId).toBe("k1");
    expect(result.tokensBefore).toBe(1234);
    expect(result.details).toEqual({ source: "session-state", readFiles: files, modifiedFiles: [] });
    expect(result.usage).toBeUndefined();
  });

  it("没有文件时摘要就是正文", () => {
    const result = buildStateCompaction("## Intent", { firstKeptEntryId: "k", tokensBefore: 1 }, { readFiles: [], modifiedFiles: [] });
    expect(result.summary).toBe("## Intent");
  });
});

describe("isStateCompaction", () => {
  it("只认本扩展写的 session-state 条目", () => {
    expect(isStateCompaction({ fromExtension: true, compactionEntry: { details: { source: "session-state" } } })).toBe(true);
    expect(isStateCompaction({ fromExtension: false, compactionEntry: { details: { source: "session-state" } } })).toBe(false);
    expect(isStateCompaction({ fromExtension: true, compactionEntry: { details: { readFiles: [] } } })).toBe(false);
    expect(isStateCompaction({ fromExtension: true })).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run session-memory/compaction.test.ts; cd ..`
预期：FAIL，找不到 `./compaction.js`。

- [ ] **步骤 3：编写实现**

创建 `extensions/session-memory/compaction.ts`：

```ts
// 把压缩时的抽取正文组装成 Pi 的压缩结果：文件附录、details、前置条件与来源判断。
import type { CompactionResult, FileOperations } from "@earendil-works/pi-coding-agent";

export const STATE_SUMMARY_SOURCE = "session-state";
export const FILE_LIST_CAP = 40;

export interface FileLists {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface StateCompactionDetails extends FileLists {
  source: typeof STATE_SUMMARY_SOURCE;
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** 调用方没带附言、准备数据完整时，才用状态当摘要。 */
export function canUseStateSummary(event: {
  customInstructions?: string;
  preparation?: { firstKeptEntryId?: unknown; tokensBefore?: unknown };
}): boolean {
  if (event.customInstructions?.trim()) return false;
  const p = event.preparation;
  return (
    typeof p?.firstKeptEntryId === "string" &&
    p.firstKeptEntryId.length > 0 &&
    typeof p.tokensBefore === "number" &&
    Number.isFinite(p.tokensBefore)
  );
}

/**
 * 分支上最后一条压缩若由本扩展写入，取它 details 里的文件列表。
 * 最后一条是 Pi 写的时返回空：Pi 已经把它的列表并进 preparation.fileOps。
 */
export function previousStateFileLists(branchEntries: readonly { type?: string; details?: unknown }[]): FileLists {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i];
    if (e?.type !== "compaction") continue;
    const d = (e.details ?? {}) as { source?: unknown; readFiles?: unknown; modifiedFiles?: unknown };
    if (d.source !== STATE_SUMMARY_SOURCE) break;
    return { readFiles: asStrings(d.readFiles), modifiedFiles: asStrings(d.modifiedFiles) };
  }
  return { readFiles: [], modifiedFiles: [] };
}

/** 与 Pi 的 computeFileLists 同口径：modified = edited ∪ written，read 去掉已改的，各自排序。 */
export function mergeFileLists(fileOps: FileOperations | undefined, prev: FileLists): FileLists {
  const modified = new Set<string>([...prev.modifiedFiles, ...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])]);
  const read = new Set<string>([...prev.readFiles, ...(fileOps?.read ?? [])]);
  return {
    readFiles: [...read].filter((f) => !modified.has(f)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatList(tag: string, files: readonly string[], cap: number): string {
  const shown = files.slice(0, cap);
  const more = files.length - shown.length;
  return `<${tag}>\n${shown.join("\n")}${more > 0 ? `\n(${more} more)` : ""}\n</${tag}>`;
}

export function formatFileAppendix(lists: FileLists, cap = FILE_LIST_CAP): string {
  const parts: string[] = [];
  if (lists.readFiles.length) parts.push(formatList("read-files", lists.readFiles, cap));
  if (lists.modifiedFiles.length) parts.push(formatList("modified-files", lists.modifiedFiles, cap));
  return parts.join("\n\n");
}

export function buildStateCompaction(
  body: string,
  preparation: { firstKeptEntryId: string; tokensBefore: number },
  lists: FileLists,
): CompactionResult<StateCompactionDetails> {
  const appendix = formatFileAppendix(lists);
  return {
    summary: appendix ? `${body}\n\n${appendix}` : body,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { source: STATE_SUMMARY_SOURCE, ...lists },
  };
}

/** session_compact 的条目是否由本扩展用状态写成。 */
export function isStateCompaction(event: { fromExtension?: boolean; compactionEntry?: { details?: unknown } }): boolean {
  const details = event.compactionEntry?.details as { source?: unknown } | undefined;
  return event.fromExtension === true && details?.source === STATE_SUMMARY_SOURCE;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run session-memory/compaction.test.ts; cd ..`
预期：PASS（11 个用例）。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/session-memory/compaction.ts extensions/session-memory/compaction.test.ts
git commit -m "feat(session-memory): build compaction results from the state extraction"
```

---

### 任务 7：与 Pi 同口径的序列化

**文件：**
- 创建：`extensions/session-memory/serialize.ts`
- 测试：`extensions/session-memory/serialize.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/session-memory/serialize.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { serializeForSummary } from "./serialize.js";

describe("serializeForSummary", () => {
  it("按 Pi 的格式序列化，工具结果截到 2000 字符，自定义消息按用户消息处理", () => {
    const text = serializeForSummary([
      { role: "user", content: "fix the bug", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(3000) }],
        isError: false,
        timestamp: 3,
      },
      { role: "custom", customType: "note", content: "hidden context", display: false, timestamp: 4 },
    ]);
    expect(text).toContain("[User]: fix the bug");
    expect(text).toContain("[Assistant]: reading");
    expect(text).toContain('[Assistant tool calls]: read(path="a.ts")');
    expect(text).toContain("[Tool result]: ");
    expect(text).toContain("[... 1000 more characters truncated]");
    expect(text).toContain("[User]: hidden context");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run session-memory/serialize.test.ts; cd ..`
预期：FAIL，找不到 `./serialize.js`。

- [ ] **步骤 3：编写实现**

创建 `extensions/session-memory/serialize.ts`：

```ts
// 与 Pi 内置摘要同一种序列化：先 convertToLlm，再 serializeConversation（工具结果每条截到 2000 字符）。
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

export function serializeForSummary(messages: readonly unknown[]): string {
  return serializeConversation(convertToLlm(messages as Parameters<typeof convertToLlm>[0]));
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run session-memory/serialize.test.ts; cd ..`
预期：PASS。首次加载 Pi 包约 3 秒，属正常。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/session-memory/serialize.ts extensions/session-memory/serialize.test.ts
git commit -m "feat(session-memory): serialize discarded messages like Pi's summarizer"
```

---

### 任务 8：compaction-policy 接线（先不提交）

**文件：**
- 修改：`extensions/compaction-policy/index.ts`
- 修改：`extensions/compaction-policy/prune.ts`（删除 `pruneMessages`）
- 修改：`extensions/compaction-policy/prune.test.ts`
- 测试：`extensions/compaction-policy/index.test.ts`

本任务改了 `COMPACTION_POLICY_PRUNE` 未设置时的含义，属于对外行为变化，按 AGENTS.md 要和决策笔记同一次提交，所以留到任务 10 再提交。

- [ ] **步骤 1：编写失败的测试**

在 `extensions/compaction-policy/index.test.ts` 文件末尾追加：

```ts
describe("compaction-policy context 钩子按压力裁剪", () => {
  type Msg = { role: string; content: unknown; toolCallId?: string; toolName?: string; timestamp?: number };
  type Handler = (event: unknown, ctx: unknown) => unknown;

  const setup = () => {
    const handlers: Record<string, Handler> = {};
    factory({
      registerCommand: () => {},
      on: (e: string, h: Handler) => {
        handlers[e] = h;
      },
      appendEntry: () => {},
    } as never);
    return handlers;
  };

  const tr = (id: string, text: string): Msg => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
  });

  // 默认保留 6 轮。old 在保护范围之前，且 near1 + near2 已用掉 158000 字符的近期额度。
  const conversation = (lastAssistantTs: number): Msg[] => {
    const msgs: Msg[] = [
      { role: "user", content: "u0" },
      { role: "assistant", content: [], timestamp: lastAssistantTs - 1 },
      tr("old", "o".repeat(5000)),
      tr("near1", "n".repeat(79_000)),
      tr("near2", "m".repeat(79_000)),
    ];
    for (let i = 1; i <= 6; i++) {
      msgs.push({ role: "user", content: `u${i}` });
      msgs.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }], timestamp: lastAssistantTs });
    }
    return msgs;
  };

  const ctxWith = (percent: number) => ({
    getContextUsage: () => ({ tokens: percent * 2000, contextWindow: 200_000, percent }),
    sessionManager: { getBranch: () => [] },
    ui: { setStatus: () => {} },
  });

  const textAt = (res: unknown, i: number) =>
    ((res as { messages: Msg[] }).messages[i].content as Array<{ text: string }>)[0].text;

  it("未设置开关时按压力裁；热请求沿用冷时的裁法；session_compact 后清空", async () => {
    vi.mocked(getConfig).mockImplementation(() => undefined);
    const handlers = setup();
    const old = Date.now() - 10 * 60_000;

    const first = await handlers.context?.({ messages: conversation(old) }, ctxWith(60));
    const trimmed = textAt(first, 2);
    expect(trimmed).toContain("[... trimmed, removed");

    const warmMsgs = [...conversation(old), { role: "assistant", content: [], timestamp: Date.now() }];
    const second = await handlers.context?.({ messages: warmMsgs }, ctxWith(10));
    expect(textAt(second, 2)).toBe(trimmed);

    await handlers.session_compact?.({}, ctxWith(10));
    const third = await handlers.context?.({ messages: warmMsgs }, ctxWith(90));
    expect(third).toBeUndefined();
  });

  it("COMPACTION_POLICY_PRUNE=0 时高占用也不裁，熔断仍作用于保护范围内的超大结果", async () => {
    vi.mocked(getConfig).mockImplementation((name: string) => (name === "COMPACTION_POLICY_PRUNE" ? "0" : undefined));
    const handlers = setup();
    const old = Date.now() - 10 * 60_000;
    const msgs = [...conversation(old), tr("bomb", "x".repeat(100_000))];
    const res = await handlers.context?.({ messages: msgs }, ctxWith(95));
    expect(textAt(res, 2)).toBe("o".repeat(5000));
    expect(textAt(res, msgs.length - 1)).toMatch(/truncated tool output: bash, 100000 chars/);
  });
});
```

`extensions/compaction-policy/prune.test.ts`：第 2 行改为

```ts
import { fuseOversizeToolResults, textLength } from "./prune.js";
```

并删除整个 `describe("pruneMessages", () => { ... });` 块（原第 8–30 行，三个用例）。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run compaction-policy; cd ..`
预期：FAIL，「未设置开关时按压力裁」用例里 `first` 为 `undefined`（默认还不裁），`textAt` 报 TypeError。

- [ ] **步骤 3：编写实现**

`extensions/compaction-policy/prune.ts` 整个文件替换为：

```ts
// toolResult 正文长度与常开的超大结果熔断。按压力裁旧工具输出见 pressure-prune.ts。
type MessageLike = { role?: string; content?: unknown; toolName?: string };

export function textLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
    .reduce((n, c) => n + (c.text?.length ?? 0), 0);
}

/** Always-on fuse: clip toolResult bodies that already exceed maxBodyChars, even in the recent-turn window.
 *  Recency prune cannot save a short chat that already swallowed a megabyte-scale search hit. */
export function fuseOversizeToolResults<T extends MessageLike>(
  messages: T[],
  maxBodyChars: number,
): { messages: T[]; fusedCount: number } {
  if (!(maxBodyChars > 0)) return { messages, fusedCount: 0 };
  let fusedCount = 0;
  const out = messages.map((m) => {
    if (m?.role !== "toolResult") return m;
    const len = textLength(m.content);
    if (len < maxBodyChars) return m;
    fusedCount++;
    const rest = Array.isArray(m.content)
      ? m.content.filter((c) => !(c && typeof c === "object" && (c as { type?: string }).type === "text"))
      : [];
    return {
      ...m,
      content: [{ type: "text", text: `[truncated tool output: ${m.toolName ?? "tool"}, ${len} chars]` }, ...rest],
    } as T;
  });
  return { messages: fusedCount ? out : messages, fusedCount };
}
```

`extensions/compaction-policy/index.ts` 做下面六处替换：

第 3 行注释：

```ts
//   - ephemeral prune（`context` 钩子裁旧工具输出，默认关）
```

改为：

```ts
//   - 按压力裁旧工具输出（`context` 钩子，默认开；缓存冷时定案、热时沿用，见 pressure-prune.ts）
```

import：

```ts
import { classify } from "./pressure.js";
import { fuseOversizeToolResults, pruneMessages } from "./prune.js";
```

改为：

```ts
import { lastActivityMs, parsePruneTtlMs } from "./cache-warmth.js";
import { classify } from "./pressure.js";
import { emptyPruneState, runPressurePrune } from "./pressure-prune.js";
import { fuseOversizeToolResults } from "./prune.js";
```

开关：

```ts
const pruneEnabled = () => (getConfig("COMPACTION_POLICY_PRUNE") ?? "0") !== "0";
```

改为：

```ts
const pruneEnabled = () => (getConfig("COMPACTION_POLICY_PRUNE") ?? "1") !== "0";
const pruneTtlMs = () => parsePruneTtlMs(getConfig("COMPACTION_POLICY_PRUNE_TTL_MS"));
```

在 `let workspaceCwd: string | undefined;` 下一行插入：

```ts
  // 进程内的裁剪计划：冷时定案、热时沿用。换会话、压缩后清空。
  let pruneState = emptyPruneState();
```

在 `session_start` 处理器里 `workspaceCwd = ctx.cwd;` 下一行插入：

```ts
    pruneState = emptyPruneState();
```

`context` 处理器整段（从 `// context 钩子：排除集` 注释到该处理器的 `});`）替换为：

```ts
  // context 钩子：排除集 → 超大 toolResult 熔断 → 按压力裁旧工具输出。都只改发往模型的副本。
  pi.on("context", async (event, ctx) => {
    consumeDesktopPulse();
    let msgs = event.messages;
    if (excluded.size > 0) {
      msgs = filterExcludedByTs(msgs as Array<{ timestamp?: number }>, excluded) as typeof msgs;
    }
    const fused = fuseOversizeToolResults(msgs, fuseChars());
    if (fused.fusedCount > 0) msgs = fused.messages;
    if (pruneEnabled()) {
      const res = runPressurePrune(pruneState, {
        messages: msgs,
        now: Date.now(),
        lastActivity: lastActivityMs(event.messages, ctx.sessionManager?.getBranch?.() ?? []),
        ttlMs: pruneTtlMs(),
        usage: ctx.getContextUsage?.(),
        keepRecentTurns: keepTurns(),
        minBodyChars: minBody(),
      });
      pruneState = res.state;
      msgs = res.messages;
    }
    return msgs === event.messages ? undefined : { messages: msgs };
  });
```

`session_compact` 处理器：

```ts
  pi.on("session_compact", async () => {
    compactArmed = true;
  });
```

改为：

```ts
  pi.on("session_compact", async () => {
    compactArmed = true;
    pruneState = emptyPruneState();
  });
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run compaction-policy; cd ..`
预期：8 个文件、67 个用例全部 PASS。

- [ ] **步骤 5：确认 `pruneMessages` 没有别的引用**

运行：`rg -n "pruneMessages" extensions cli/src electron-agent/electron -g "!node_modules"`
预期：无输出。

---

### 任务 9：session-memory 接线（先不提交）

**文件：**
- 重写：`extensions/session-memory/index.ts`
- 重写：`extensions/session-memory/index.test.ts`

- [ ] **步骤 1：编写失败的测试**

`extensions/session-memory/index.test.ts` 整个文件替换为：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));
vi.mock("./llm.js", () => ({ askLlm: vi.fn(), resolveModel: vi.fn() }));
vi.mock("./serialize.js", () => ({
  serializeForSummary: (messages: unknown[]) => `SERIALIZED(${messages.length})`,
}));

import { getConfig } from "../_shared/runtime-config.js";
import factory from "./index.js";
import { askLlm, resolveModel } from "./llm.js";
import { readStateDoc, statePath, writeStateDoc } from "./store.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Entry = { type: string; id: string; message?: unknown; details?: unknown };

const model = { id: "m" };

beforeEach(() => {
  vi.mocked(getConfig).mockReset().mockImplementation(() => undefined);
  vi.mocked(askLlm).mockReset();
  vi.mocked(resolveModel).mockReset().mockImplementation(() => model as never);
});

function setup() {
  const handlers: Record<string, Handler> = {};
  const commands: string[] = [];
  factory({
    registerCommand: (name: string) => commands.push(name),
    on: (e: string, h: Handler) => {
      handlers[e] = h;
    },
  } as never);
  const cwd = mkdtempSync(join(tmpdir(), "sm-index-"));
  let branch: Entry[] = [];
  const ctx = {
    cwd,
    model,
    modelRegistry: { find: () => undefined },
    sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
    ui: { notify: vi.fn() },
  };
  return {
    handlers,
    commands,
    ctx,
    path: statePath(cwd, "s1"),
    setBranch: (next: Entry[]) => {
      branch = next;
    },
  };
}

const msgEntry = (id: string, content = id): Entry => ({ type: "message", id, message: { role: "user", content } });

const preparation = (over: Record<string, unknown> = {}) => ({
  firstKeptEntryId: "k1",
  tokensBefore: 1234,
  messagesToSummarize: [{ role: "user", content: "old" }],
  turnPrefixMessages: [],
  isSplitTurn: false,
  previousSummary: "PREV-SUMMARY",
  fileOps: { read: new Set(["a.ts"]), edited: new Set(["b.ts"]), written: new Set<string>() },
  settings: {},
  ...over,
});

const beforeCompact = (branchEntries: Entry[], over: Record<string, unknown> = {}) => ({
  type: "session_before_compact",
  preparation: preparation(),
  branchEntries,
  customInstructions: undefined,
  reason: "threshold",
  willRetry: false,
  signal: new AbortController().signal,
  ...over,
});

const userPromptOf = (call: number) => vi.mocked(askLlm).mock.calls[call][2] as string;

describe("session-memory factory", () => {
  it("registers state hooks and /session-state command", () => {
    const { handlers, commands } = setup();
    expect(commands).toContain("session-state");
    expect(Object.keys(handlers)).toEqual(
      expect.arrayContaining(["turn_end", "agent_end", "session_before_compact", "session_compact", "before_agent_start"]),
    );
  });
});

describe("session_before_compact 用状态当摘要", () => {
  it("抽取成功：返回压缩结果，状态文件写入同一正文并带锚点", async () => {
    const { handlers, ctx, path } = setup();
    const branch = [msgEntry("e1"), msgEntry("e2")];
    writeStateDoc(path, "## Intent\n- prev", "e1");
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    const event = beforeCompact(branch);

    const result = (await handlers.session_before_compact(event, ctx)) as {
      compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
    };

    expect(result.compaction.firstKeptEntryId).toBe("k1");
    expect(result.compaction.tokensBefore).toBe(1234);
    expect(result.compaction.details).toEqual({ source: "session-state", readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
    expect(result.compaction.summary).toBe(
      "## Intent\n- new\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>",
    );
    expect(readStateDoc(path)).toEqual({ body: "## Intent\n- new", anchor: "e2" });

    const prompt = userPromptOf(0);
    expect(prompt).toContain("<previous-state>\n## Intent\n- prev\n</previous-state>");
    expect(prompt).toContain("<previous-summary>\nPREV-SUMMARY\n</previous-summary>");
    expect(prompt).toContain("<conversation>\nSERIALIZED(1)\n</conversation>");
    expect(prompt).not.toContain("<current-turn-prefix>");
    expect(vi.mocked(askLlm).mock.calls[0][3]).toBe(event.signal);
  });

  it("锚点不在当前分支时不带上一份状态", async () => {
    const { handlers, ctx, path } = setup();
    writeStateDoc(path, "## Intent\n- other branch", "gone");
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx);
    expect(userPromptOf(0)).not.toContain("other branch");
  });

  it("切在一轮中间时带上切轮前缀", async () => {
    const { handlers, ctx } = setup();
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    const event = beforeCompact([msgEntry("e1")], {
      preparation: preparation({
        isSplitTurn: true,
        turnPrefixMessages: [{ role: "user", content: "p1" }, { role: "assistant", content: [] }],
      }),
    });
    await handlers.session_before_compact(event, ctx);
    expect(userPromptOf(0)).toContain("<current-turn-prefix>\nSERIALIZED(2)\n</current-turn-prefix>");
  });

  it("合并上一份 session-state 压缩条目的文件列表", async () => {
    const { handlers, ctx } = setup();
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    const branch: Entry[] = [
      msgEntry("e1"),
      { type: "compaction", id: "c1", details: { source: "session-state", readFiles: ["z.ts"], modifiedFiles: ["y.ts"] } },
      msgEntry("e2"),
    ];
    const result = (await handlers.session_before_compact(beforeCompact(branch), ctx)) as {
      compaction: { details: unknown };
    };
    expect(result.compaction.details).toEqual({
      source: "session-state",
      readFiles: ["a.ts", "z.ts"],
      modifiedFiles: ["b.ts", "y.ts"],
    });
  });

  it("抽取抛错或输出为空时交给 Pi，状态文件不变", async () => {
    const { handlers, ctx, path } = setup();
    writeStateDoc(path, "## Intent\n- prev", "e1");
    vi.mocked(askLlm).mockRejectedValueOnce(new Error("overflow")).mockResolvedValueOnce("   ");
    expect(await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx)).toBeUndefined();
    expect(await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx)).toBeUndefined();
    expect(readStateDoc(path)).toEqual({ body: "## Intent\n- prev", anchor: "e1" });
  });

  it("信号已中止时交给 Pi", async () => {
    const { handlers, ctx, path } = setup();
    const controller = new AbortController();
    controller.abort();
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    const result = await handlers.session_before_compact(
      beforeCompact([msgEntry("e1")], { signal: controller.signal }),
      ctx,
    );
    expect(result).toBeUndefined();
    expect(readStateDoc(path)).toBeUndefined();
  });

  it("解析不到模型或功能关闭时交给 Pi，不调模型", async () => {
    const { handlers, ctx } = setup();
    vi.mocked(resolveModel).mockImplementation(() => undefined);
    expect(await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx)).toBeUndefined();

    vi.mocked(resolveModel).mockImplementation(() => model as never);
    vi.mocked(getConfig).mockImplementation((name: string) => (name === "SESSION_STATE_ENABLED" ? "0" : undefined));
    expect(await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx)).toBeUndefined();
    expect(askLlm).not.toHaveBeenCalled();
  });

  it("customInstructions 非空时交给 Pi，但按旧方式刷新状态", async () => {
    const { handlers, ctx, path } = setup();
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- refreshed");
    const result = await handlers.session_before_compact(
      beforeCompact([msgEntry("e1", "hello"), msgEntry("e2", "world")], { customInstructions: "focus" }),
      ctx,
    );
    expect(result).toBeUndefined();
    expect(userPromptOf(0)).toContain("user: world");
    expect(readStateDoc(path)).toEqual({ body: "## Intent\n- refreshed", anchor: "e2" });
  });

  it("先开始的周期写入晚于压缩写入完成时，不覆盖压缩结果", async () => {
    const { handlers, ctx, path, setBranch } = setup();
    vi.mocked(getConfig).mockImplementation((name: string) => (name === "SESSION_STATE_EVERY_TURNS" ? "1" : undefined));
    setBranch([msgEntry("e1")]);
    let releaseStale: (v: string) => void = () => {};
    vi.mocked(askLlm)
      .mockImplementationOnce(() => new Promise<string>((resolve) => (releaseStale = resolve)))
      .mockResolvedValueOnce("## Intent\n- compaction");

    await handlers.turn_end({}, ctx);
    await handlers.agent_end({ messages: [{ role: "user", content: "x" }] }, ctx);
    await handlers.session_before_compact(beforeCompact([msgEntry("e1"), msgEntry("e2")]), ctx);
    releaseStale("## Intent\n- stale");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readStateDoc(path)?.body).toBe("## Intent\n- compaction");
  });
});

describe("压缩后是否注入", () => {
  it("摘要来自状态时不注入，Pi 写的摘要照旧注入，锚点不在分支上时不注入", async () => {
    const { handlers, ctx, path, setBranch } = setup();
    setBranch([msgEntry("e1"), msgEntry("e2")]);
    writeStateDoc(path, "## Intent\n- state", "e2");

    await handlers.session_compact(
      { fromExtension: true, compactionEntry: { details: { source: "session-state" } } },
      ctx,
    );
    expect(await handlers.before_agent_start({}, ctx)).toBeUndefined();

    await handlers.session_compact({ fromExtension: false, compactionEntry: { details: {} } }, ctx);
    const injected = (await handlers.before_agent_start({}, ctx)) as { message: { content: string } };
    expect(injected.message.content).toContain("## Intent\n- state");
    expect(injected.message.content).not.toContain("anchor=");

    setBranch([msgEntry("e1")]);
    await handlers.session_compact({ fromExtension: false, compactionEntry: { details: {} } }, ctx);
    expect(await handlers.before_agent_start({}, ctx)).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run session-memory/index.test.ts; cd ..`
预期：FAIL。「抽取成功」等用例拿到 `undefined`（旧实现不返回压缩结果）；注入用例里 `fromExtension: true` 之后仍然注入。

- [ ] **步骤 3：编写实现**

`extensions/session-memory/index.ts` 整个文件替换为：

```ts
// session-memory: maintain a structured working-state markdown for the session.
// 周期写入看对话末尾；压缩时读 Pi 准备好的待丢弃消息做唯一一次抽取，结果同时写状态文件、作压缩摘要。
// 状态文件第一行是分支锚点，不属于当前分支时不用。
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import {
  buildStateCompaction,
  canUseStateSummary,
  isStateCompaction,
  mergeFileLists,
  previousStateFileLists,
} from "./compaction.js";
import { buildInjection } from "./injector.js";
import { type AskFn, askLlm, resolveModel } from "./llm.js";
import { serializeForSummary } from "./serialize.js";
import { readStateDoc, stateOnBranch, statePath, writeStateDoc } from "./store.js";
import { flattenMessages } from "./transcript.js";
import { extractCompactionState, extractState } from "./writer.js";

const enabled = () => (getConfig("SESSION_STATE_ENABLED") ?? "1") !== "0";
const everyTurns = () => Number(getConfig("SESSION_STATE_EVERY_TURNS") ?? "8") || 8;
const maxChars = () => Number(getConfig("SESSION_STATE_MAX_CHARS") ?? "4000") || 4000;
const stateModel = () => getConfig("SESSION_STATE_MODEL");

type BranchEntry = { type?: string; id?: string; message?: unknown; details?: unknown };

export default function (pi: ExtensionAPI) {
  let turnsSinceWrite = 0;
  let needReanchor = false;
  /** 写入序号：只有最新开始的写入能落盘，先开始后完成的作废。 */
  let writeSeq = 0;

  const makeAsk = (ctx: ExtensionContext, signal: AbortSignal | undefined): AskFn | undefined => {
    const model = resolveModel(
      ctx.model,
      ctx.modelRegistry ?? { find: () => undefined },
      stateModel(),
    );
    if (!model) return undefined;
    return (system, user) => askLlm(model, system, user, signal);
  };

  const pathFor = (ctx: ExtensionContext) => statePath(ctx.cwd, ctx.sessionManager.getSessionId());
  const branchOf = (ctx: ExtensionContext) => (ctx.sessionManager.getBranch?.() ?? []) as BranchEntry[];

  /** 周期写入：对话末尾 12000 字符 + 属于当前分支的上一份状态。结果没变就不重写。 */
  const writeFrom = async (
    ctx: ExtensionContext,
    messages: unknown[],
    signal: AbortSignal | undefined,
    branch: BranchEntry[],
  ) => {
    const ask = makeAsk(ctx, signal);
    if (!ask) return;
    const seq = ++writeSeq;
    const path = pathFor(ctx);
    const anchor = branch.at(-1)?.id;
    const prev = stateOnBranch(readStateDoc(path), branch);
    const md = await extractState(ask, flattenMessages(messages), prev);
    if (md && md !== prev && seq === writeSeq) writeStateDoc(path, md, anchor);
    turnsSinceWrite = 0;
  };

  pi.on("turn_end", async () => {
    turnsSinceWrite += 1;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled()) return;
    if (turnsSinceWrite < everyTurns()) return;
    // 后台非阻塞：状态提炼是一次额外模型调用，不该拖住 agent_end / UI「运行中」。先同步重置计数，
    // 避免后台写入在途时下一轮 agent_end 重复触发（writeFrom 内部仍会再置 0，幂等无害）。
    turnsSinceWrite = 0;
    void writeFrom(ctx, event.messages as unknown[], ctx.signal, branchOf(ctx)).catch(() => {});
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!enabled()) return undefined;
    const e = event as SessionBeforeCompactEvent;
    const branch = (e.branchEntries ?? []) as BranchEntry[];
    if (!canUseStateSummary(e)) {
      // 调用方带了附言或准备数据不全：摘要交给 Pi，状态照旧按对话末尾刷新，供压缩后注入。
      const messages = branch.filter((x) => x.type === "message" && x.message).map((x) => x.message);
      if (messages.length) await writeFrom(ctx, messages, e.signal, branch);
      return undefined;
    }
    const ask = makeAsk(ctx, e.signal);
    if (!ask) return undefined;
    const seq = ++writeSeq;
    const path = pathFor(ctx);
    const anchor = branch.at(-1)?.id;
    const p = e.preparation;
    const body = await extractCompactionState(ask, {
      prevState: stateOnBranch(readStateDoc(path), branch),
      previousSummary: p.previousSummary,
      conversation: serializeForSummary(p.messagesToSummarize ?? []),
      turnPrefix:
        p.isSplitTurn && p.turnPrefixMessages?.length ? serializeForSummary(p.turnPrefixMessages) : undefined,
    });
    if (!body || e.signal?.aborted) return undefined;
    if (seq === writeSeq) writeStateDoc(path, body, anchor);
    turnsSinceWrite = 0;
    const lists = mergeFileLists(p.fileOps, previousStateFileLists(branch));
    return { compaction: buildStateCompaction(body, p, lists) };
  });

  pi.on("session_compact", async (event) => {
    // 摘要就是状态时，下一轮不再注入同一份。
    needReanchor = !isStateCompaction(event as SessionCompactEvent);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!enabled() || !needReanchor) return undefined;
    needReanchor = false;
    const body = stateOnBranch(readStateDoc(pathFor(ctx)), branchOf(ctx));
    if (!body) return undefined;
    return { message: buildInjection(body, maxChars()) };
  });

  pi.registerCommand("session-state", {
    description: "查看当前会话的结构化工作状态：/session-state show",
    handler: async (_args, ctx) => {
      ctx.ui.notify(readStateDoc(pathFor(ctx))?.body ?? "暂无会话状态。", "info");
    },
  });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run session-memory; cd ..`
预期：7 个文件、39 个用例全部 PASS。

---

### 任务 10：决策笔记、文档、整体验证与提交

**文件：**
- 创建：`docs/decisions/extensions/2026-10-04-session-state-as-compaction.md`
- 修改：`docs/architecture.md:58`、`docs/architecture.md:71`

- [ ] **步骤 1：写决策笔记**

创建 `docs/decisions/extensions/2026-10-04-session-state-as-compaction.md`：

```markdown
---
title: 旧工具结果默认按压力裁并冷时定案；压缩时一次状态抽取兼作摘要
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/compaction-policy/cache-warmth.ts
  - extensions/compaction-policy/pressure-prune.ts
  - extensions/compaction-policy/prune.ts
  - extensions/compaction-policy/index.ts
  - extensions/session-memory/compaction.ts
  - extensions/session-memory/serialize.ts
  - extensions/session-memory/store.ts
  - extensions/session-memory/writer.ts
  - extensions/session-memory/index.ts
supersedes:
superseded_by:
---

## 背景
旧工具结果的裁剪默认关闭，打开后按保留轮数整段替换，每次请求都重算。压缩时 `session-memory` 只看对话末尾 12000 字符抽一次状态，Pi 再读全部待丢弃消息写一次摘要，真正读过被丢内容的只有 Pi 那次。状态文件按 sessionId 存，回退或换分支后会带着不在当前分支上的工作。

## 决定
`COMPACTION_POLICY_PRUNE` 未设置时按压力裁。缓存冷时（最后一条助手消息和最后一次 `cache_warm` 保温都早于 `COMPACTION_POLICY_PRUNE_TTL_MS`，默认 5 分钟），按未裁占用定一份 `toolCallId → soft | replace` 的计划；热时原样重放这份计划，压缩或换会话后清空。读 `SKILL.md` 的结果不裁。

压缩时 `session-memory` 读 `messagesToSummarize`、上一份摘要、属于当前分支的上一份状态和切轮前缀，做唯一一次抽取。结果写入状态文件，并作为 `{ compaction }` 返回；文件列表按 Pi 的标签附在后面，存进 `details` 由本扩展自己接力。抽取失败、被取消、带附言或准备数据不全时交给 Pi。状态文件第一行写分支锚点，不在当前分支上就不用。`session_compact` 按 `fromExtension` 和 `details.source` 决定是否再注入。

## 放弃的方案
- 每次请求单独判断冷热并重算裁法：热请求会退回未裁前缀，刚写的缓存整段 miss，与 2026-09-29-strip-settled-thinking.md 放弃开关的理由相同。
- 冷热只看最后一条助手消息：Pi 1.0.2 的保温不产生助手消息，会把 Pi 刚保住的缓存裁掉。
- 直接拿周期状态文件当摘要：它只看过末尾 12000 字符，没读过待丢弃的消息。
- 摘要交回 Pi、压缩时不再抽取：同样一次调用，但压缩后注入的状态会偏旧。
- 搬 MiMo 的 checkpoint 写手和边界重建：要接管会话存储，扩展钩子够不到。
- 把触发百分比改成 90：与 2026-10-02-auto-compact-threshold.md 保留的默认 80 冲突，也不改善摘要内容。
- 指望 Pi 下一轮压缩继承 `details` 里的文件列表：`fromHook` 条目不会被继承，改为本扩展合并上一份。
- 按 sessionId 记「本次摘要来自状态」的进程内标记：`session_compact` 已带 `fromExtension` 和条目 `details`，标记还要额外处理失败清理。

## 后果
- 自动压缩的触发看实际发出请求的占用，裁剪会推迟压缩。
- 裁剪计划只在进程内，重启后第一次热请求不沿用旧裁法，可能 miss 一次。
- TTL 默认对应 5 分钟缓存档；用 1 小时档的提供方要调大 `COMPACTION_POLICY_PRUNE_TTL_MS`，否则会在缓存仍热时重新定案。
- codemode 嵌套调用里读的 `SKILL.md` 不受保护。
- `SESSION_STATE_MODEL` 指向小窗口模型时，压缩抽取可能溢出并回到 Pi 摘要，这次压缩仍是两次调用，状态文件不更新。
- 没有锚点的旧状态文件在下一次写入前不会被使用。
```

- [ ] **步骤 2：更新 architecture.md**

`docs/architecture.md` 第 58 行：

```markdown
| `compaction-policy` | 上下文修剪、压力指示、删任意段 | 无 slash；宿主 `agent_exclude_entry` / `agent_restore_entry` |
```

改为：

```markdown
| `compaction-policy` | 超大结果熔断、按压力裁旧工具输出（缓存冷时定案、热时沿用）、压力指示、删任意段、自动压缩 | 无 slash；宿主 `agent_exclude_entry` / `agent_restore_entry` |
```

第 71 行：

```markdown
| `session-memory` | 会话结构化工作状态，压缩后重锚 | 内部 `/session-state`（slash 菜单不列） |
```

改为：

```markdown
| `session-memory` | 带分支锚点的会话工作状态；压缩时一次抽取兼作压缩摘要，交给 Pi 摘要时压缩后重锚 | 内部 `/session-state`（slash 菜单不列） |
```

- [ ] **步骤 3：整体验证**

运行：`cd extensions; npx vitest run compaction-policy session-memory; cd ..`
预期：15 个文件、106 个用例全部 PASS。

运行：`cd extensions; npx vitest run index.test.ts prompt-metadata.test.ts; cd ..`
预期：32 个文件、319 个用例全部 PASS（基线 307，加上本计划新增的 12 个入口用例）。

运行：`cd cli; npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String "compaction-policy|session-memory"; cd ..`
预期：无输出。其他目录原本就有类型错误，与本计划无关，不在这里处理。

运行：`node scripts/check-notes.mjs`
预期：退出码 0，无报错。

- [ ] **步骤 4：Commit**

```powershell
git add extensions/compaction-policy/index.ts extensions/compaction-policy/index.test.ts extensions/compaction-policy/prune.ts extensions/compaction-policy/prune.test.ts extensions/session-memory/index.ts extensions/session-memory/index.test.ts docs/decisions/extensions/2026-10-04-session-state-as-compaction.md docs/architecture.md
git commit -m "feat: prune tool results by pressure with a warm-cache latch; use session state as the compaction summary"
```

提交前确认 `git diff --cached --stat` 只有上面这些文件，`docs/architecture.md` 的暂存内容只有第 58、71 行两处（该文件当前有别人的未提交改动，必要时用 `git add -p docs/architecture.md` 只暂存这两行）。

---

## 自检记录

规格覆盖：§4.1 开关 → 任务 8；§4.2 冷热与定案 → 任务 1、3、8；§4.3 未裁等级 → 任务 3；§4.4 保护范围、160000、`SKILL.md` → 任务 2；§4.5 软裁与代理对 → 任务 2；§4.6 整段替换 → 任务 2；§5.1 锚点 → 任务 4、9；§5.2 写入顺序 → 任务 9；§5.3 交给 Pi 的条件 → 任务 6、9；§5.4 抽取输入与 `event.signal` → 任务 5、7、9；§5.5 压缩结果与文件附录 → 任务 6、9；§5.6 注入 → 任务 9；§6 错误处理 → 任务 3、9 的用例；§8 决策笔记与 architecture → 任务 10。

计划中的代码已在临时目录完整跑过：compaction-policy 8 个文件 67 个用例、session-memory 7 个文件 39 个用例全部通过，`cli/tsconfig.json` 对两个目录无类型错误。
