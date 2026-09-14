# DSH 子代理第四期：fork 种子（父会话已完成轮次）

- 日期：2026-09-13
- 状态：已落地（2026-09-14 核实）
- 复核：2026-09-13 对照 `embedded-runner.ts` 与 pi SDK `SessionManager` 类型做过一轮修订（见 §11 附录）
- 主题：对齐 DSH fork 后端：子会话以父会话**已完成轮次**为一次性快照，之后各自记账；产出只从种子之后读；目录不继承父事实。
- 依赖：[规格 1](./2026-09-13-dsh-subagent-session-child-design.md)（embedded Session、`extractAssistantOutput`）、[规格 2](./2026-09-13-dsh-subagent-continuable-notice-design.md)（可续聊可带种子）、[规格 3](./2026-09-13-dsh-subagent-header-catalog-design.md)（`subagent_catalog_base`）
- 关联：`extensions/multi-agent/embedded-runner.ts`、`extensions/multi-agent/assistant-output.ts`、`extensions/multi-agent/catalog.ts`

---

## 1. 目标与范围

规格 1 的子会话是空的，任务文本必须自带全部上下文。DSH fork 后端只多一件事：把父日志里「到最后一次已完成轮次为止」的前缀写成子会话的初始内容。进行中的那一轮（正在跑的 `spawn_agent` / `fork` 工具调用）不进种子。之后父会话再写什么，子级都看不见。

本期只做这一种子，以及读结果 / 目录时把它切掉。

**成功标准：**

1. `spawn_agent({ task, fork: true })` 的子 JSONL 以父叶路径上已完成的 user / assistant / tool 消息开头，**不含**当前这条正在调用工具的 assistant 消息。
2. 父模型只收到子级**自己**的最后非空助手正文；种子里父曾经说过的话不能当产出。
3. 子级即使种子里带着父的 `subagent_catalog` 行，自己的目录折叠仍为空，直到它（未来）成功创建自己的孩子。
4. 父还没有任何已完成轮次时，`fork: true` 与普通 spawn 相同（空种子，不写 `subagent_catalog_base`）。
5. 种子是创建时的快照；父之后的消息不会同步过去。

**范围**：embedded 路径上的种子计算与读取切刀。子进程回退遇到 `fork: true` 直接失败，不把整段父对话塞进 CLI 参数。不新增第二个工具名。

---

## 2. 方案取舍（已锁定）

| 方案 | 做法 | 结论 |
|------|------|------|
| A. `spawn_agent` 增加 `fork: boolean`（**采用**） | 默认 `false`；true 时 embedded 写种子 | 模型不用换工具名；和规格 1/2 同一入口 |
| B. 新工具 `subagent_fork` | 对齐 DSH 工具名 | 两套 schema，本期不做；以后若要别名，只做转发 |
| C. 复用 `AgentSession.fork` / 用户 rewind | 现成 API | 那是**同一会话树**分叉，会换走父 leaf；DSH fork 是**新的子 Session** |
| D. 种子含当前未完成 assistant | 实现省事 | 子级会看到半截工具调用，JSONL 不配平 |

不搬 DSH 的 `turn/end` 事件。Pi 会话是 message 树，用 §4 的「已完成前缀」定义。

---

## 3. 工具面

`spawn_agent` 增加可选字段：

```
fork?: boolean   // 默认 false
```

与现有 `task` / `tasks` / `chain` / `action` / `profile` 兼容。

| 组合 | 行为 |
|------|------|
| `fork` 省略或 `false` | 规格 1 / 2，空会话 |
| `fork: true` + 单 `task` + embedded | 写种子再跑 |
| `fork: true` + `action: "spawn"` + embedded | 种子 + 规格 2 可续聊；种子只在创建时拍一次，冷恢复重放子自己的 JSONL，不再向父要新前缀 |
| `fork: true` + `tasks` / `chain` | 拒绝：`fork 仅支持单任务` |
| `fork: true` + worktree / 非 Electron / **在子级里** | 拒绝：`fork 需要 Electron 进程内子会话` |
| `fork: true` 且父没有已完成轮次 | 成功，等同普通 spawn，不写 `subagent_catalog_base` |

「在子级里」的判定**不能只看 `PI_IS_SUBAGENT`**：那个 env 只有 `spawnPiAgent` 子进程路径会设（`runner.ts:286`），embedded 子级不设。用 `_shared/workspace-context.ts` 的 `resolveToolOrigin() === "subagent"`——embedded 子级整段跑在 `runInWorkspace({ origin: "subagent" })` 里，ALS 拿得到。判定条件写成：

```ts
const inChild = resolveToolOrigin() === "subagent";   // 覆盖 embedded + 子进程两条路
if (opts.fork && (!canUseEmbeddedSubagent(profile) || inChild)) throw new Error("fork 需要 Electron 进程内子会话");
```

（注意：`_shared/workspace-context.ts` 里 `WorkspaceContext.origin` 现在声明成 `"main" | "goal"`，但 `embedded-runner.ts` 已经在传 `origin: "subagent"`——类型与实现不符的现状。本期顺手把类型扩成 `"main" | "goal" | "subagent"`，否则 `resolveToolOrigin()` 的返回值在类型层面永远到不了 `"subagent"`。）

模型选择与规格 1 相同（显式 → named agent → profile → `SUBAGENT_MODEL` → 父模型）。DSH 为了 KV cache 常锁死父路由；GrenAgent 不另加这道禁令——父前缀已经按 Pi 消息对象拷贝，不是逐字节复用同一条 provider 请求。

`promptGuidelines` 加一句：子任务要接着当前对话往下做时用 `fork: true`；要隔离探索时不要开。

不在本期改名为 `subagent_fork`。

---

## 4. 已完成前缀（Pi 语义）

DSH：`snapshotEvents()` 切到最后一个 `turn/end`（含）。进行中的工具轮次没有 `turn/end`，自动排除。

Pi：JSONL 是树，`buildSessionContext().messages` 是当前 leaf 回溯到 root 的线性上下文。`spawn_agent` 被调用时，父模型正在产生一条带 tool call 的 assistant 消息，这条消息通常还没成为稳定 leaf，或已经以「进行中」形式存在。

**前缀算法（锁死）：**

0. 工具 `ctx` 拿不到 `session.messages`；`ctx.sessionManager` 是 `ReadonlySessionManager`，只暴露 `buildContextEntries()`。所以父消息 = `ctx.sessionManager.buildContextEntries().filter(e => e.type === "message").map(e => e.message)`。`buildContextEntries()` 走 leaf→root 且已消化 compaction，不需要自己处理摘要；`compaction` / `branch_summary` / `custom` 条目不是 `type: "message"`，自动被这一步滤掉，正好满足第 5 步。
1. 从尾往前找 content 里带 `toolCallId` 的那条 `assistant` 消息——`execute(toolCallId, params, ...)` 的第一个参数就是它，比「按工具名匹配」可靠得多（并行 `spawn_agent` 时工具名会有多个候选）。
2. 找到则丢掉该消息及其之后的全部。
3. 找不到（该 assistant 还没落盘）时：若最后一条是 `assistant`，丢掉它（当作未完成轮次）；若最后一条是 `user` 或列表为空，前缀 = 当前全部消息。
4. 前缀只保留 `role` 为 `user` | `assistant` | `toolResult` 的项。`custom` / `custom_message`（Goal Round、notice）已在第 0 步被滤掉。
5. 得到空数组则不写种子。

第 3 步的回退避免「找不到 tool call 就误把半截 assistant 拷走」。实现必须带单测覆盖「messages 末尾就是那条 spawn_agent assistant」与「末尾 assistant 尚未落盘」两种形态。

拷进子 JSONL 时：

- 新 `SessionManager.create(cwd, undefined, { id: agentId, parentSession: 父路径 })`
- 按顺序 `sessionManager.appendMessage(msg)`——它会自己生成 entry `id` 并挂到当前 leaf，**不要**手工重发 id / 重建 parentId 链
- 绝不改写 `msg` 内部字段：`assistant` 的 tool call id 与 `toolResult.toolCallId` 必须原样保留，否则 provider 侧「tool_result 找不到对应 tool_use」直接报错。entry id 换了不影响配对，message 内部 id 换了才致命
- **不要**拷贝父的 `compaction` / `branch_summary` / `goal` / `subagent_catalog` entry（第 0 步已保证）
- 写完种子，按此顺序落盘（全部是子文件自己的写入）：
  1. `appendCustomEntry("subagent_catalog_base", { version: 0, reason: "subagent-seed" })`——即使种子里没有目录事实也写，防实现失误拷进 custom
  2. `appendCustomEntry("subagent_meta", { ..., inheritedEventCount: 种子消息条数 })`——**只写这一条**，不要先写一条再补一条；`mode` / `parentSession` / `parentSessionId` / `label` 一并写全
  3. `appendModelChange(provider, id)`
  4. 初始任务（可续聊则再追加返回指引）

初始任务是种子**之后**的新 user 消息，不是改写种子最后一条。

`inheritedEventCount` 是「子 `session.messages` 里属于种子的条数」，不是 JSONL 物理行号。只给 `extractAssistantOutput` 切产出。目录隔离走规格 3 的 `subagent_catalog_base`，两把刀各切一类数据。

---

## 5. 读结果切刀

规格 1 的 `extractAssistantOutput(messages)` 改为：

```ts
extractAssistantOutput(messages, {
  streamingDelta?,
  aborted?,
  skipPrefix?: number, // 默认 0
})
```

只在 `messages.slice(skipPrefix)` 里从后往前找最后一条非空 assistant。流式 delta 只来自子级自己的 `text_delta`（规格 1 已经只订当前 `AgentSession`）。

embedded runner：`skipPrefix = subagent_meta.inheritedEventCount`。

没有种子时 `skipPrefix === 0`，行为与规格 1 相同。

子级若全程不说话：产出为空 + `error` / `(no output)`，即使种子里父说过很长的话。

---

## 6. 模块

| 文件 | 职责 |
|------|------|
| `extensions/multi-agent/fork-seed.ts` | `completedPrefix(parentMessages, opts)`、`writeSeed(sessionManager, messages)` |
| `extensions/multi-agent/assistant-output.ts` | `skipPrefix` |
| `extensions/multi-agent/embedded-runner.ts` | `fork: true` 时先写种子再 `prompt` |
| `extensions/multi-agent/index.ts` | 参数校验；`details.forked: true`、`details.inheritedEventCount` |
| `extensions/multi-agent/catalog.ts` | 种子后写 `subagent_catalog_base`（规格 3 已定） |

不要用 `commandContextActions.fork`（那是用户 rewind）。embedded runner 里这条继续返回 `{ cancelled: true }`。

---

## 7. 与规格 2 / 3 的交接

- **可续聊 + fork：** 允许。`prepare` 只在创建时拍前缀；冷恢复打开子 JSONL，里面已含种子，不再读父。
- **settle notice：** closing message 仍走切过后的 `extractAssistantOutput`。
- **目录：** 父目录照常在子级首次接受后加一行（fork 子级也是直接孩子）。子级自己的折叠看不到父的孩子。
- **用户 rewind 父会话：** 规格 3 的 `user-fork` base 已经切断拷贝行；本期不改。
- **覆层：** 打开 fork 子级时，种子里的父对话会显示出来——这是要的（人类也要看到子级继承了什么）。只读 / 可续聊仍按 `mode`，与是不是 fork 无关。

---

## 8. 错误

| 情况 | 结果 |
|------|------|
| `fork: true` 但走子进程 | 工具 `isError`，不启动 |
| `fork: true` + `tasks` / `chain` | 同上 |
| 父 `buildContextEntries()` 读失败 / 抛错 | 同上，不写半截 JSONL |
| 种子写入中途失败 | 删子 JSONL（若已 create），不写父目录，工具失败 |
| 空种子 | 成功，当普通 spawn |

不把「空种子」当错误。DSH 同样在没有 `turn/end` 时当 fresh spawn。

---

## 9. 明确不做

- 新工具名 `subagent_fork`
- 实时把父新消息同步给子级
- 继承父工具权限 / 审批 / Goal / compaction 摘要
- 为 KV cache 禁止子级改模型
- 种子包含 `custom_message`（Goal Round、notice 等）
- 用 `AgentSession.fork` 顶替子 Session
- 子进程 fork
- ACP / 远程 fork
- 嵌套 spawn（子级仍无 `spawn_agent`）

---

## 10. 测试

**completedPrefix**

- 末尾是带 `spawn_agent` 的 assistant（`toolCallId` 命中）→ 该消息不在前缀
- 并行两次 `spawn_agent`：只切掉 `toolCallId` 对应的那条，另一条的 toolResult 留在前缀
- 末尾 assistant 尚未落盘（找不到 `toolCallId`）→ 丢掉最后一条 assistant
- 前缀含更早的完整 user / assistant / toolResult
- 拷贝后 `assistant.toolCall.id` 与 `toolResult.toolCallId` 与父侧完全一致（锁死「不改写 message 内部 id」）
- 只有一条用户消息、还没有 assistant → 前缀 = 那条 user
- 空 messages → 空前缀
- `custom` / `custom_message` / `compaction` 不进前缀

**writeSeed + output**

- 子 `session.messages.length === inheritedEventCount + 子自己的条数`
- 子级不说话 → `extractAssistantOutput` 为空，不返回种子里的父助手正文
- 子级说话 → 只返回子级正文
- `inheritedEventCount === 0` 与规格 1 金样例一致

**目录**

- 父有两条目录事实；fork 子级折叠 `entries` 为空
- 文件里能看到 `subagent_catalog_base` `reason: "subagent-seed"`

**路由**

- `fork: true` + worktree → 抛错，不调用 `spawnPiAgent`
- `fork: true` + `tasks` → 抛错
- `fork: true` + `action: "spawn"` → Activation `inheritedEventCount > 0`（在有完成轮次的夹具上）
- `details.forked === true`

**冷恢复**

- 创建后再改父会话；冷恢复的子 `messages` 前缀仍是旧种子，不含父新消息

---

## 11. 附录：本次复核已确认的现状（2026-09-13）

| 项 | 结论 |
|----|------|
| 父消息取法 | 工具 `ctx.sessionManager` 是 `ReadonlySessionManager`，只有 `buildContextEntries()` / `getEntries()` / `getBranch()`；**没有** `session.messages`，也没有 `buildSessionContext()` |
| 工具调用 id | `execute(toolCallId, params, signal, onUpdate, ctx)` 第一个参数现已被 `_toolCallId` 丢弃，fork 前缀直接用它 |
| 写消息 API | `sessionManager.appendMessage(msg)` 自动分配 entry id 并挂到当前 leaf；禁止直写 CompactionSummary / BranchSummary（会抛错） |
| 子进程才设 `PI_IS_SUBAGENT` | `runner.ts:286`；embedded 子级身份在 ALS `origin`，用 `resolveToolOrigin()` |
| 现有子会话创建 | `embedded-runner.ts:188-197`：`SessionManager.create` + `appendCustomEntry("subagent_meta", ...)`；fork 种子要在它之前插入 |
| 产出抽取 | `assistant-output.ts::extractAssistantOutput(messages, { streamingDelta?, aborted? })`，加 `skipPrefix` 是纯增量 |
| 目录隔离 | 规格 3 的 `subagent_catalog_base` 已在 §3.3 定好，fork 只需按 §4 的顺序写一条 |
