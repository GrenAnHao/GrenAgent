# 子项目 C：压缩精细化（设计/规格）

- 日期：2026-06-16
- 状态：草案 — 已实地核验（npm 运行时 `@earendil-works/pi-coding-agent@0.79.x` + 嵌套 `pi-agent-core`），待用户审查
- 主题：上下文管理从「一刀切整体摘要」升级为 prune（裁旧工具输出）+ 尾部保留调优 + 压力分级
- 载体：**纯新扩展 `extensions/compaction-policy/`，零核心改动**
- 上游总览：`docs/superpowers/specs/2026-06-16-pi-enhancement-roadmap-design.md` §4.C

> 锚点约定：`types.d.ts` = `extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`；`compaction.js/.d.ts` = `.../dist/core/compaction/`；`agent-session.js` = `.../dist/core/agent-session.js`；`agent-loop.js`/agent-core `types.d.ts` = `.../pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/`。

## 0. 重大修正（实地核验推翻总览 §4.C 的核心前提）

总览设 C「压缩在核心 agent-core，扩展钩子够不到，MVP 走核心改动（默认关闭以降 fork 维护成本）」。**实地核验后此前提不成立**：

| 能力 | 真实落点 | 结论 |
|---|---|---|
| prune（每次 LLM 前改写 `AgentMessage[]`） | `transformContext` 由 coding-agent 经扩展 hook **`context`** 供给（`sdk.js:217-222` → `runner.js:685-712`） | **纯扩展** |
| 尾部保留 + 只摘要 head（整体压缩时） | 核心已做（token 预算 `keepRecentTokens`）；如需定制可经 `session_before_compact` 返回自定义 `CompactionResult` | **纯扩展**（核心已有更优默认） |
| 压力分级 0–3 | 核心无此概念，但 `ctx.getContextUsage()` 暴露 tokens/percent，可在扩展侧分级 + `ctx.ui.setStatus` 展示 | **纯扩展**（派生指标） |

**因此本规格整体改为纯扩展实现，零核心改动、零 fork 维护成本。** 仅当未来要「把 prune 持久化进 session 文件」或「把整体压缩切点算法从 token 预算改为按 N 轮」时才需碰核心——本期均不需要（见 §6 边界）。

## 1. 目标与范围

### 1.1 目标
- **prune**：每次 LLM 请求前，把超出「保护窗口」的旧的、已完成的 `toolResult` 输出体替换为占位符（保留 `toolResult` 消息结构与 tool-call 关联），释放上下文且不触发整体摘要、不改 session 文件。
- **尾部保留调优**：让整体压缩的「保留多少最近上下文」可配（沿用核心 `keepRecentTokens` 语义）。
- **压力分级**：从 `getContextUsage()` 派生 0–3 压力级，经状态栏展示。

### 1.2 成功标准（MVP）
1. 开启后，长对话中旧的工具输出在发给 LLM 前被替换为 `[output pruned: N chars]` 占位符；最近 K 轮的工具输出与所有用户/assistant 消息原样保留。
2. prune 是 ephemeral 视图变换：session JSONL 文件内容不被修改（可重开复核原始输出仍在）。
3. 关闭（默认）时行为与上游完全一致。
4. 状态栏显示当前压力级（如 `ctx 62% · L1`）。

### 1.3 不在范围
- 把 prune 结果写回 session（破坏可回溯性，YAGNI）。
- 改写核心整体压缩的切点算法（核心 token 预算已够用）。
- 自定义压缩摘要基底（移交子项目 B 的 `session_before_compact` 增强，避免职责重叠）。

## 2. 背景与代码依据（实地核验）

### 2.1 主链路与 prune 落点
```172:179:agent-loop.js
async function streamAssistantResponse(context, config, signal, emit, streamFn) {
    let messages = context.messages;
    if (config.transformContext) {
        messages = await config.transformContext(messages, signal);   // 每次 LLM 前
    }
    const llmMessages = await config.convertToLlm(messages);
```
- `transformContext` 类型：`(messages: AgentMessage[], signal?) => Promise<AgentMessage[]>`（agent-core `types.d.ts:162`，文档明示用途含 “pruning old messages”）。
- coding-agent 把它接到扩展 runner：`sdk.js:217-222` 的 `transformContext` → `runner.emitContext(messages)`。
- `emitContext` 触发 **`context`** hook，并用返回的 `{messages}` 覆盖：`runner.js:685-712`。
- 扩展 API：`pi.on("context", handler)`（`types.d.ts:819`）；事件 `ContextEvent { messages: AgentMessage[] }`（`:475-477`）；结果 `ContextEventResult { messages? }`（`:735-737`）。

### 2.2 prune 产物能否通过 convertToLlm？
`convertToLlm`（`messages.js:75-122`）对 `toolResult` **原样保留**（未知 role 才丢弃）。故保留 `role:"toolResult"`、仅把 `content` 改成占位符的消息可正常发送。**确认 prune 安全。**

### 2.3 整体压缩（与 prune 互补，非本扩展 MVP 主体）
- 触发在 `AgentSession._checkCompaction`（`agent-session.js:685, 767, 1464`），用 coding-agent `compaction.js`（非 agent-core harness 版）。
- `CompactionSettings { enabled; reserveTokens; keepRecentTokens }`（`compaction.d.ts:24-28`）；默认 `{true, 16384, 20000}`（`compaction.js:66-70`）。
- `shouldCompact = enabled && contextTokens > contextWindow - reserveTokens`（`compaction.js:149-152`）。
- 尾保留：`findCutPoint(entries, start, end, keepRecentTokens)`（`compaction.js:298-347`）按 **token 预算** 从新到旧保留；`findTurnStartIndex`（`:266-280`）用于切点落在 turn 中间时定位 turn 起点（split-turn 摘要），**非**「保留 N 轮」。
- 压缩定制 hook：`session_before_compact` 可返回 `{ cancel?; compaction?: CompactionResult }`（`types.d.ts:425-431, 772-775`；处理 `agent-session.js:1290-1304`）。

### 2.4 压力分级数据源
- `ctx.getContextUsage(): ContextUsage`（`types.d.ts:236`，`ContextUsage` 含 tokens/percent，`:192-198`）。
- 展示：`ctx.ui.setStatus(key, text)`（`types.d.ts:79`）。
- 观测事件（只读）：AgentSessionEvent 流 `compaction_start`/`compaction_end`（`agent-session.d.ts:51-65`）——属事件流非扩展 hook，UI 层可订阅；扩展侧用 `session_compact` hook 感知压缩完成。

## 3. 架构与组件

独立扩展 `extensions/compaction-policy/`：

- `index.ts` —— 工厂。注册 `context` hook（prune）+ `turn_end`/`agent_end`（刷新压力状态）+ `/compaction` 命令（查看/切换）。
- `prune.ts` —— `pruneMessages(messages, opts): AgentMessage[]`。纯函数：保护窗口 = 最近 `keepRecentTurns` 轮的 toolResult + 全部非 toolResult；其余「已完成」toolResult 的输出体替换为占位符（保留 toolCallId 关联、记录原长度）。可独立单测。
- `pressure.ts` —— `classify(usage, settings): { level: 0|1|2|3; label: string }`。纯函数：按 `contextTokens / (contextWindow - reserveTokens)` 比例分级。

> 注：prune 在 `context` hook 内对 runner `structuredClone` 出的副本操作（`runner.js:686`），天然不污染原 `AgentMessage[]`；扩展只需返回新数组。

## 4. 数据流
```
context hook（每次 LLM 前）  → 若启用 prune：messages → pruneMessages(messages, {keepRecentTurns, minBodyChars}) → return { messages }
                             → 否则 return undefined（不改）
turn_end / agent_end         → usage=ctx.getContextUsage(); {level,label}=classify(usage,settings); ctx.ui.setStatus("ctx", label)
/compaction                  → 显示当前 usage + level + prune 开关状态；可 toggle
```

## 5. 错误处理与边界
- prune **只动**「超出保护窗口 + 已完成（有结果）」的 toolResult；**绝不动**最近 K 轮、用户消息、assistant 消息、未完成工具调用。
- 占位符保留可读信息：`[pruned tool output: <name>, <N> chars]`，避免 LLM 误判工具失败。
- prune 异常（任何抛错）→ 返回原始 `messages`（fail-safe，等价于未启用）。
- `minBodyChars` 阈值：小于该长度的 toolResult 不裁（裁了不省，反增噪声）。
- 配置非法（如 keepRecentTurns<1）→ 回退默认。
- 无 UI 模式：`setStatus` 安全降级，prune 逻辑不受影响。

## 6. 与核心的边界（何时才需要改核心 / 本期为何不需要）
- prune：ephemeral 视图变换，`context` hook 足够，**不需核心**。
- 尾部保留：核心 `keepRecentTokens` 已实现 token 预算式尾保留；若用户坚持「按 N 轮」，可在子项目 B/本扩展用 `session_before_compact` 返回自定义 `CompactionResult`（用 `findTurnStartIndex` 反向数 N 个 turn 边界算 `firstKeptEntryId`），仍**不需核心**。
- 压力分级：派生自 `getContextUsage()`，**不需核心**。
- 唯一真需核心的场景（本期排除）：把 prune **持久化进 session JSONL**，或替换核心 `shouldCompact`/`findCutPoint` 默认算法本身。

## 7. 配置（`_shared/runtime-config.ts` 的 `getConfig`）
- `COMPACTION_POLICY_PRUNE`（默认 `0` 关）：prune 开关（保守默认，避免改上游行为）。
- `COMPACTION_POLICY_KEEP_TURNS`（默认 6）：保护窗口轮数。
- `COMPACTION_POLICY_MIN_BODY`（默认 1000）：触发裁剪的最小输出体字符数。
- `COMPACTION_POLICY_PRESSURE`（默认 `1` 开）：状态栏压力显示。

## 8. 测试
- `prune.test.ts`：保护窗口边界（最近 K 轮不动）、非 toolResult 不动、占位符格式与原长记录、minBodyChars 阈值、异常 fail-safe 返回原数组。
- `pressure.test.ts`：各 usage 比例 → 正确 level；边界值。
- 默认关闭：`COMPACTION_POLICY_PRUNE=0` 时 `context` hook 返回 undefined（行为与上游一致）。
- jiti smoke。

## 9. 实现文件清单
| 文件 | 职责 |
|---|---|
| `extensions/compaction-policy/index.ts` | 工厂 + `context`/`turn_end`/`agent_end` 钩子 + `/compaction` 命令 |
| `extensions/compaction-policy/prune.ts` | prune 纯函数 |
| `extensions/compaction-policy/pressure.ts` | 压力分级纯函数 |
| `*.test.ts` | 单测 |
| `extensions/package.json` | 追加 `./compaction-policy/index.ts` |

## 可选增强（YAGNI）
- 与子项目 B 联动：压缩前经 `session_before_compact` 用结构化状态作摘要基底（职责归 B，本扩展只读 usage）。
- prune 智能化：按 token 而非字符预算；对 read/grep/ls 等高冗余工具优先裁。
- 压力级驱动行为：L3 时自动提示 `/compact` 或自动触发 `ctx.compact()`（`types.d.ts:238`）。

## 规格自检（2026-06-16）
- [x] 无占位；§0 修正与 §6 边界一致、不矛盾
- [x] MVP（prune+压力，纯扩展）与可选增强（压缩基底，归 B）边界清晰
- [x] 范围可单一实现计划覆盖
- [x] 模糊点已定：保护窗口定义、占位符格式、fail-safe、默认关闭

## 代码核对修订（2026-06-16，实地核验 v1，来自 C 区只读审计）
- [x] prune 落点属实：`context` hook（`runner.js:685-712`、`sdk.js:217-222`、`agent-loop.js:172-179`、`types.d.ts:475-477/735-737/819`、agent-core `types.d.ts:162`）
- [x] prune 产物可过 convertToLlm：`toolResult` 原样保留（`messages.js:75-122`）
- [x] 压缩触发与参数属实：`agent-session.js:685/767/1464`；`compaction.d.ts:24-28`、`compaction.js:66-70/149-152/298-347/266-280`
- [x] 压缩定制纯扩展可行：`session_before_compact`→`{cancel?,compaction?}`（`types.d.ts:772-775`、`agent-session.js:1290-1304`）
- [x] 压力数据源属实：`ctx.getContextUsage()`（`types.d.ts:236`、`ContextUsage` `:192-198`）
- [x] 无内置 prune（仅摘要输入截断 `utils.js`），本扩展非重复造轮
- [x] 推翻总览「C 必须改核心」：MVP 全程零核心改动
