# SP-6 上下文控制（回退/删段/压缩可控）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 让用户能手动把任意段移出 LLM 上下文（可恢复）、回退到更早对话点、并在压缩前预览/编辑/取消。

**架构：** 在现有 `compaction-policy` 扩展上叠加——`context` 钩子合并"排除集过滤 + 既有 prune"；排除集用 `appendEntry` 持久、`session_start` 回放；加 `session_before_compact` 接管压缩；回退基于既有 `agent_fork`。

**技术栈：** TypeScript 扩展（`context`/`session_before_compact` 钩子、`appendEntry`）、Rust（Tauri exclude/rewind 命令）、React 前端、vitest。

设计来源：`docs/superpowers/specs/2026-06-26-context-control-design.md`。

---

## 文件结构

- 创建：`extensions/compaction-policy/exclusion.ts` —— `buildExclusionSet()` + `filterExcluded()`（纯）。
- 创建：`extensions/compaction-policy/exclusion.test.ts`。
- 修改：`extensions/compaction-policy/index.ts` —— `context` 钩子合并排除集；加 `session_start` 回放 + `session_before_compact`。
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs` —— 加 `agent_exclude_entry`/`agent_restore_entry`（写控制通道）；回退复用既有 `agent_fork`（:507）。
- 修改：前端消息操作栏 —— 「移出上下文」/「恢复」/「回退到此」。

---

## 任务 1：`buildExclusionSet` + `filterExcluded` 纯逻辑

**文件：**
- 创建：`extensions/compaction-policy/exclusion.ts`
- 测试：`extensions/compaction-policy/exclusion.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/compaction-policy/exclusion.test.ts
import { describe, expect, it } from "vitest";
import { buildExclusionSet, filterExcluded, type ExclusionEntry } from "./exclusion.js";

describe("buildExclusionSet", () => {
  it("replays add/remove ops in order", () => {
    const entries: ExclusionEntry[] = [
      { op: "add", entryId: "a" },
      { op: "add", entryId: "b" },
      { op: "remove", entryId: "a" },
    ];
    expect([...buildExclusionSet(entries)].sort()).toEqual(["b"]);
  });
});

describe("filterExcluded", () => {
  it("drops items whose id is excluded", () => {
    const items = [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }];
    const out = filterExcluded(items, new Set(["b"]), (x) => x.id);
    expect(out.map((x) => x.v)).toEqual([1, 3]);
  });
  it("returns same array reference-equal content when nothing excluded", () => {
    const items = [{ id: "a", v: 1 }];
    expect(filterExcluded(items, new Set(), (x) => x.id)).toEqual(items);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run compaction-policy/exclusion.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：编写实现**

```ts
// extensions/compaction-policy/exclusion.ts
// 用户驱动的上下文排除集：按 entryId 把消息移出"喂给 LLM 的上下文"（不删盘）。
export interface ExclusionEntry {
  op: "add" | "remove";
  entryId: string;
}

export function buildExclusionSet(entries: ExclusionEntry[]): Set<string> {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.op === "add") set.add(e.entryId);
    else set.delete(e.entryId);
  }
  return set;
}

export function filterExcluded<T>(items: T[], excluded: Set<string>, idOf: (item: T) => string | undefined): T[] {
  if (excluded.size === 0) return items;
  return items.filter((it) => {
    const id = idOf(it);
    return !id || !excluded.has(id);
  });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run compaction-policy/exclusion.test.ts`
预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/compaction-policy/exclusion.ts extensions/compaction-policy/exclusion.test.ts
git commit -m "feat(sp6): exclusion set build + filter"
```

## 任务 2：context 钩子合并排除集 + 持久/回放

**文件：**
- 修改：`extensions/compaction-policy/index.ts:14`（现有 `context` 钩子）

- [ ] **步骤 1：内存排除集 + session_start 回放**

在 `compaction-policy` 工厂内加内存态与回放：

```ts
import { buildExclusionSet, filterExcluded, type ExclusionEntry } from "./exclusion.js";

let excluded = new Set<string>();

pi.on("session_start", async (_event, ctx) => {
  const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
  const ops = entries
    .filter((e) => e.type === "custom" && e.customType === "context_exclusion")
    .map((e) => e.data as ExclusionEntry);
  excluded = buildExclusionSet(ops);
});
```

- [ ] **步骤 2：context 钩子先排除后 prune**

把现有 `context` 钩子（:14）改为先按排除集过滤、再跑既有 prune：

```ts
pi.on("context", async (event) => {
  // 关联 entryId：用 sessionManager 当前分支的有序条目对齐 messages（同序）。
  let msgs = event.messages;
  if (excluded.size > 0) {
    msgs = filterExcluded(
      msgs.map((m, i) => ({ m, id: (m as { id?: string }).id })),
      excluded,
      (x) => x.id,
    ).map((x) => x.m);
  }
  if (!pruneEnabled()) {
    return msgs === event.messages ? undefined : { messages: msgs };
  }
  const res = pruneMessages(msgs, { keepRecentTurns: keepTurns(), minBodyChars: minBody() });
  if (res.prunedCount === 0 && msgs === event.messages) return undefined;
  return { messages: res.messages };
});
```

> 关联风险（实现前必做）：确认 `AgentMessage` 是否带稳定 `id`（`grep -n "id" agent-core/dist/types.d.ts` 查 AgentMessage）。若不带 id，则排除改为基于 `ctx.sessionManager` 的有序 `MessageEntry`（有 `id` + `message`）重建对齐：取当前分支 message 条目按序映射到 `event.messages`（同序假设），用条目 id 过滤。把这步实现成一个小函数 `correlateIds(entries, messages)` 并补一个单测。

- [ ] **步骤 3：typecheck + 既有测试不回归**

运行：`cd cli && npm run typecheck` 与 `cd extensions && npx vitest run compaction-policy`
预期：通过；现有 `prune.test.ts`/`index.test.ts` 仍 PASS。

- [ ] **步骤 4：Commit**

```bash
git add extensions/compaction-policy/index.ts
git commit -m "feat(sp6): merge exclusion filter into context hook + replay on session_start"
```

## 任务 3：压缩接管（session_before_compact 预览/取消）

**文件：**
- 修改：`extensions/compaction-policy/index.ts`

- [ ] **步骤 1：加 session_before_compact 钩子**

```ts
const compactPreview = () => (getConfig("COMPACTION_PREVIEW") ?? "0") !== "0";

pi.on("session_before_compact", async (event, ctx) => {
  if (!compactPreview() || !ctx.hasUI) return undefined; // 默认关 / 无 UI → 放行默认压缩
  try {
    const ok = await ctx.ui.confirm("压缩上下文", `将摘要 ${event.preparation.messagesToSummarize.length} 条消息。继续？`);
    if (!ok) return { cancel: true };
    // 可选：让用户编辑默认摘要——此处用默认；编辑流见增强。
    return undefined;
  } catch {
    return undefined; // fail-open：UI 失败放行默认
  }
});
```

- [ ] **步骤 2：typecheck + Commit**

运行：`cd cli && npm run typecheck`

```bash
git add extensions/compaction-policy/index.ts
git commit -m "feat(sp6): session_before_compact preview/cancel (default off, fail-open)"
```

## 任务 4：Tauri 删段/恢复 + 回退（fork）

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs`
- 修改：`tauri-agent/src/lib/pi.ts` + 前端消息操作栏

- [ ] **步骤 1：exclude/restore 命令（写控制通道）**

加 `agent_exclude_entry(workspace, entry_id)` / `agent_restore_entry(workspace, entry_id)`：把 `{op, entryId}` 经控制通道送给该 workspace 的扩展。最简实现：写入该进程 runtime config 的一个递增 `CONTEXT_EXCLUSION_OP=<json>` 并触发 watch；扩展在 `watchConfig` 回调里 `appendEntry("context_exclusion", op)` + 更新内存 `excluded`。

> 复用 SP-4 的控制通道写入 helper（同一 `PI_RUNTIME_CONFIG` 文件）。扩展侧在任务2 的工厂里加：`watchConfig(next => { const raw = next.CONTEXT_EXCLUSION_OP; if (raw) { const op = JSON.parse(raw); pi.appendEntry("context_exclusion", op); if (op.op==="add") excluded.add(op.entryId); else excluded.delete(op.entryId); } })`。

- [ ] **步骤 2：回退复用 fork**

回退不新增 RPC：前端「回退到此」调既有 `agent_fork(workspace, entryId)`（`agent.rs:507`，position 用 "before"），再切到新分支。`agent_get_fork_messages`（:524）预览保留消息。

- [ ] **步骤 3：前端封装 + 操作栏**

`tauri-agent/src/lib/pi.ts` 加：

```ts
  excludeEntry: (workspace: string, entryId: string) => invoke('agent_exclude_entry', { workspace, entryId }),
  restoreEntry: (workspace: string, entryId: string) => invoke('agent_restore_entry', { workspace, entryId }),
```

消息气泡操作栏加「移出上下文」(excludeEntry) /「恢复」(restoreEntry) /「回退到此」(fork)；被排除的消息灰显标记。

- [ ] **步骤 4：编译 + 测试 + Commit**

运行：`cd tauri-agent/src-tauri && cargo build` 与 `cd tauri-agent && npx tsc --noEmit && npm run test`
预期：通过。

```bash
git add tauri-agent/src-tauri/src/commands/agent.rs tauri-agent/src/lib/pi.ts tauri-agent/src/features/chat extensions/compaction-policy/index.ts
git commit -m "feat(sp6): exclude/restore commands + fork-based rewind + message action bar"
```

---

## 自检

- 规格覆盖：删段过滤（任务1-2）✓、持久/回放（任务2步1 + 任务4步1 appendEntry）✓、压缩接管（任务3）✓、回退（任务4步2 fork）✓、fail-soft（任务3 catch + context 钩子返回 undefined）✓、不删盘（仅排除）✓。
- 占位符：无；`AgentMessage.id` 关联风险在任务2步2 显式标注 + 给补救（correlateIds + 单测）。
- 类型一致：`ExclusionEntry{op,entryId}`（任务1）↔ `appendEntry("context_exclusion", op)`（任务4）↔ Tauri `CONTEXT_EXCLUSION_OP` JSON 字段一致；`filterExcluded` 的 `idOf` 与 context 钩子里的 `(x)=>x.id` 一致。
- 非目标守住：未做物理删盘、未加 navigate_tree RPC（回退用 fork）。
