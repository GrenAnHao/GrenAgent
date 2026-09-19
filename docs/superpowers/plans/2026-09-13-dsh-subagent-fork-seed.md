# DSH 子代理规格 4：fork 种子 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** `spawn_agent({ fork: true })` 把父会话已完成轮次写入新子 JSONL；产出与目录都不把种子当成子级自己的。

**架构：** `completedPrefix(parentMessages, toolCallId)` 切掉进行中的那条 assistant；`sessionManager.appendMessage(msg)` 原样拷贝内部 tool id；`extractAssistantOutput(..., { skipPrefix })` 切产出；`subagent_catalog_base`（`reason: "subagent-seed"`）切目录。空前缀当普通 spawn。

**技术栈：** TypeScript ESM、vitest。只改 sidecar `extensions/multi-agent` + 规格 3 已有的 `catalog.ts`。

**上游规格：** `docs/superpowers/specs/2026-09-13-dsh-subagent-fork-seed-design.md`

**依赖：** 规格 2（embedded create / Activation）与规格 3（`foldCatalog` / `subagent_catalog_base`）已落地。

**不要执行：** 新工具名 `subagent_fork`、子进程 fork、用 `AgentSession.fork`、实时同步父新消息、嵌套 spawn。

---

## 动工前必读

- `git add` 只加本任务文件。PowerShell here-string 提交。
- 父消息：**不能** `session.messages`。工具 `ctx.sessionManager` 是 `ReadonlySessionManager`，用 `buildContextEntries().filter(e => e.type === "message").map(e => e.message)`。
- 切刀用 `execute` 的第一个参数 `toolCallId`，不要按工具名扫（并行会误切）。
- `appendMessage(msg)` 自己发 entry id。**禁止**改 `msg` 里的 `toolCall.id` / `toolResult.toolCallId`。
- 空种子：成功、等同普通 spawn，**不写** `subagent_catalog_base`。有种子：**一律**写 base，再写一条完整 `subagent_meta`（不要写两次 meta）。
- 「在子级里」：`resolveToolOrigin() === "subagent"`，不要只看 `PI_IS_SUBAGENT`。
- `WorkspaceContext.origin` 在规格 2 任务 1 已扩成含 `subagent`。本计划不要再改类型，除非那次漏了。
- 提交前类型检查（**注意路径**）：

```powershell
cd "D:\OneDrive\Project Files\Pi\cli"; npx tsc --noEmit
```

`extensions/` 下没有 tsconfig；检查由 `cli/tsconfig.json`（`include: ["src", "../extensions"]`，**target `ES2022`**）承担。
- **ES2022 基线**：`Array.prototype.findLastIndex` / `findLast`（ES2023）与 `Promise.withResolvers`（ES2024）不在 lib 里。本计划任务 1 的实现示例用了 `findLastIndex`，改成倒序 `for` 循环。不要为此改 `cli/tsconfig.json` 的 target。
- 测试：

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run multi-agent/fork-seed.test.ts multi-agent/assistant-output.test.ts
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `extensions/multi-agent/fork-seed.ts` | `completedPrefix`、`writeSeed` |
| `extensions/multi-agent/fork-seed.test.ts` | 规格 §10 前缀与拷贝 |

修改：

| 文件 | 职责 |
| --- | --- |
| `extensions/multi-agent/assistant-output.ts` | `skipPrefix` |
| `extensions/multi-agent/assistant-output.test.ts` | 种子正文不是产出 |
| `extensions/multi-agent/embedded-runner.ts` | `fork: true` 先写种子 |
| `extensions/multi-agent/index.ts` | 参数校验；`details.forked` / `inheritedEventCount` |
| `extensions/multi-agent/index.test.ts` | 拒绝 worktree / tasks；空种子成功 |
| `extensions/multi-agent/catalog.test.ts` | fork 子级 fold 为空 |

---

### 任务 1：`completedPrefix`

**文件：** 新建 `fork-seed.ts` + `fork-seed.test.ts`

- [ ] **步骤 1：失败测试（规格 §10 全部前缀用例）**

```ts
import { describe, expect, it } from "vitest";
import { completedPrefix } from "./fork-seed.js";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string, toolCallId?: string) => ({
  role: "assistant",
  content: toolCallId
    ? [{ type: "toolCall", id: toolCallId, name: "spawn_agent", arguments: {} }, { type: "text", text }]
    : [{ type: "text", text }],
});
const toolResult = (toolCallId: string, text: string) => ({
  role: "toolResult",
  toolCallId,
  content: [{ type: "text", text }],
});

describe("completedPrefix", () => {
  it("drops the in-flight spawn assistant matching toolCallId", () => {
    const prefix = completedPrefix(
      [user("hi"), assistant("thinking", "tc-1")],
      "tc-1",
    );
    expect(prefix).toEqual([user("hi")]);
  });

  it("keeps a sibling spawn toolResult when cutting another toolCallId", () => {
    const other = assistant("other", "tc-a");
    const tr = toolResult("tc-a", "done");
    const mine = assistant("mine", "tc-b");
    const prefix = completedPrefix([user("u"), other, tr, mine], "tc-b");
    expect(prefix).toEqual([user("u"), other, tr]);
  });

  it("drops last assistant when toolCallId not yet persisted", () => {
    const prefix = completedPrefix([user("u"), assistant("half")], "tc-missing");
    expect(prefix).toEqual([user("u")]);
  });

  it("keeps sole user when no assistant", () => {
    expect(completedPrefix([user("only")], "tc")).toEqual([user("only")]);
  });

  it("empty input is empty prefix", () => {
    expect(completedPrefix([], "tc")).toEqual([]);
  });

  it("ignores custom messages even if passed in", () => {
    const prefix = completedPrefix(
      [{ role: "custom", customType: "subagent_catalog", content: "x" }, user("u")],
      "tc",
    );
    expect(prefix).toEqual([user("u")]);
  });
});
```

`toolCallId` 匹配：**字段形状已核实**，不用再打印探测。pi-ai 的 `ToolCall` 是 `{ type: "toolCall"; id: string; name: string; arguments: Record<string, any> }`（`pi-ai/dist/types.d.ts:256`），assistant 的 `content` 是这些内容块组成的数组。匹配函数就一条：

```ts
const blocks = Array.isArray(m.content) ? m.content : [];
const hit = blocks.some((b) => b && b.type === "toolCall" && b.id === toolCallId);
```

上面测试夹具的 `{ type: "toolCall", id, name: "spawn_agent", arguments: {} }` 与 SDK 一致，可以直接用。别去兼容不存在的第二形状，也别改 message。

- [ ] **步骤 3：实现**

```ts
export function completedPrefix(messages: unknown[], toolCallId: string): unknown[] {
  const list = messages.filter((m) => {
    const role = (m as { role?: string }).role;
    return role === "user" || role === "assistant" || role === "toolResult";
  });
  // 倒序 for：findLastIndex 是 ES2023，不在 target ES2022 的 lib 里
  for (let i = list.length - 1; i >= 0; i--) {
    if (roleOf(list[i]) === "assistant" && hasToolCall(list[i], toolCallId)) return list.slice(0, i);
  }
  if (list.length && roleOf(list[list.length - 1]) === "assistant") return list.slice(0, -1);
  return list;
}
```

- [ ] **步骤 5：Commit** `feat(multi-agent): fork 已完成前缀算法`

---

### 任务 2：`writeSeed` + 不改内部 id

**文件：** `fork-seed.ts` / `fork-seed.test.ts`

- [ ] **步骤 1：** mock `sessionManager.appendMessage` 收集写入。断言：

- 调用次数 = 前缀条数
- 每条 `===` 或结构等于输入（`toolCall.id` / `toolResult.toolCallId` 与父相同）
- **没有**手工改 parentId
- 空前缀：`writeSeed` 返回 `0` 且不调用 `appendMessage`

```ts
export function writeSeed(
  sessionManager: { appendMessage: (m: unknown) => void },
  messages: unknown[],
): number {
  for (const m of messages) sessionManager.appendMessage(m);
  return messages.length;
}
```

- [ ] **步骤 5：Commit** `feat(multi-agent): fork 种子按 appendMessage 写入`

---

### 任务 3：`extractAssistantOutput` 的 `skipPrefix`

**文件：** `assistant-output.ts` + 现有测试

- [ ] **步骤 1：** 现有用例全部不传 `skipPrefix`，必须仍绿。新增：

```ts
it("skipPrefix ignores seeded parent assistant", () => {
  const r = extractAssistantOutput(
    [
      { role: "assistant", content: [{ type: "text", text: "parent said" }] },
      { role: "user", content: "child task" },
    ],
    { skipPrefix: 1 },
  );
  expect(r.output).toBe("");
  expect(r.stopReason).toBe("error");
});

it("skipPrefix still finds child assistant", () => {
  const r = extractAssistantOutput(
    [
      { role: "assistant", content: [{ type: "text", text: "parent said" }] },
      { role: "assistant", content: [{ type: "text", text: "child said" }] },
    ],
    { skipPrefix: 1 },
  );
  expect(r.output).toBe("child said");
});
```

- [ ] **步骤 3：**

```ts
export function extractAssistantOutput(
  messages: AssistantLike[],
  options: { streamingDelta?: string; aborted?: boolean; skipPrefix?: number } = {},
): AssistantOutputResult {
  const start = Math.max(0, options.skipPrefix ?? 0);
  return extractFrom(messages.slice(start), options);
}
```

把现有循环抽到 `extractFrom`，避免复制。`skipPrefix === 0` 与规格 1 金样例逐条对照。

- [ ] **步骤 5：Commit** `feat(multi-agent): 产出抽取跳过 fork 种子`

---

### 任务 4：embedded 写入顺序 + 路由拒绝

**文件：** `embedded-runner.ts`、`index.ts`、对应测试、`catalog.test.ts`

- [ ] **步骤 1：测试**

index：

- `fork: true` + `tasks` → 工具 error 文本 `fork 仅支持单任务`，不 `spawnPiAgent`
- `fork: true` + worktree profile → `fork 需要 Electron 进程内子会话`
- `fork: true` 且 `resolveToolOrigin()==="subagent"`（`runInWorkspace({ origin: "subagent" })` 包一层 execute）→ 同上拒绝
- `fork: true` + 空前缀 → 成功，`details.forked === true`，`inheritedEventCount === 0`，子文件**没有** `subagent_catalog_base`
- `fork: true` + 有前缀 + `action: "spawn"` → `inheritedEventCount > 0`，`details.forked === true`

catalog：

- 父叶路径有两条 `subagent_catalog`；`writeSeed` 后按规格顺序写 base + meta；`foldCatalog(childPath).entries` 为空
- 文件里能找到 `subagent_catalog_base` `reason: "subagent-seed"`

write 顺序锁死（有种子时）：

1. `appendMessage` × N
2. `appendCustomEntry("subagent_catalog_base", { version: 0, reason: "subagent-seed" })`
3. `appendCustomEntry("subagent_meta", { ..., inheritedEventCount: N, mode, parentSession, parentSessionId, label })` **一条写全**
4. `appendModelChange`
5. 初始任务（continuable 加返回指引）

种子写入中途失败：删已 create 的子 JSONL（`fs.rmSync(sessionPath)`），不 `establishCatalogChild`，工具 `isError`。

`index.ts` `execute` 第一个参数改名为 `toolCallId`，传给 `completedPrefix`。现在是 `_toolCallId`，本任务启用它。

**拒绝条件的位置**：`list`（`normalizeTasks`）与 `hasChain` 在 `index.ts` 里要到 338–339 行才算出来，fork 校验必须放在**那之后**、`executeSubagent` 调用之前。放到 `execute` 开头会因为 `list` 还未定义而编译不过。

```ts
const inChild = resolveToolOrigin() === "subagent";
if (params.fork) {
  if (hasChain || list.length !== 1) throw new Error("fork 仅支持单任务");
  if (!canUseEmbeddedSubagent(profile) || inChild) {
    throw new Error("fork 需要 Electron 进程内子会话");
  }
}
```

`resolveToolOrigin` 要从 `../_shared/workspace-context.js` 引入（`index.ts` 目前还没引）。

测试「`resolveToolOrigin()==="subagent"` 时拒绝」：用 `runInWorkspace({ origin: "subagent", workspace, cwd, config: {} }, () => execute(...))` 包一层。这里是唯一一处可以直接传 `origin: "subagent"` 的地方——规格 2 任务 1 已经把类型扩开了。

`promptGuidelines` 加一句：接着当前对话用 `fork: true`。

- [ ] **步骤 5：Commit** `feat(multi-agent): spawn_agent fork 写入种子并拒绝子进程`

---

### 任务 5：冷恢复不重拍父前缀

**文件：** `activation.ts` 冷恢复路径（规格 2 已有）+ 测试

- [ ] **步骤 1：** 创建带种子的子 JSONL 夹具 → `coldResumeAndDeliver`（规格 2 任务 4 导出）→ 再给父 session 追加一条新 user → 断言子 `messages` 前缀仍是旧种子（不含新 user）。冷恢复只 `SessionManager.open(childPath)`，禁止再读父 `buildContextEntries`。

若规格 2 的冷恢复已经只 open 子文件，本任务加一条回归测试即可，不改实现。**但要先确认 `coldResumeAndDeliver` 真的导出了**——规格 2 任务 4 的导出清单原本漏了它，本计划任务 5 与规格 2 任务 6 都依赖。若落地时还没补，在规格 2 任务 4 里补上再继续。

- [ ] **步骤 5：Commit** `test(multi-agent): fork 冷恢复不重拍父前缀`

---

## 规格覆盖

| 规格 | 任务 |
| --- | --- |
| §3 工具面 / 拒绝 | 4 |
| §4 前缀算法 | 1 |
| §4 写入顺序 / 内部 id | 2、4 |
| §5 skipPrefix | 3 |
| §7 可续聊 + fork / notice 切产出 | 3、4 |
| §7 目录隔离 | 4 |
| §8 空种子 | 4 |
| §10 冷恢复 | 5 |
| `subagent_fork` 工具名 | 不做 |

---

## 完成定义

- 有完成轮次时子 JSONL 以父前缀开头，不含当前 `toolCallId` 那条 assistant
- 子不说话时父模型看到 `(no output)` / error，不是父旧回复
- 子目录 fold 为空
- `fork: true` + worktree / tasks / 子级内 → 明确失败
- 空前缀与普通 spawn 金样例一致
