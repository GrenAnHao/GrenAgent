# SP-6 上下文控制设计（回退 / 删任意段 / 压缩完全可控）

- 日期：2026-06-26
- 状态：设计草案（brainstorming 产出），待用户审查 → writing-plans
- 范围：在现有 `compaction-policy` 扩展之上，补齐**用户驱动**的三项上下文控制能力——删任意段、上下文回退、压缩完全可控。**纯扩展 + 薄 sidecar/前端接线，零 Pi fork。**
- 运行时基准：`@earendil-works/pi-coding-agent@0.79.10`（npm 包，仓库无 `pi/` fork）。
- 所属总盘：零 fork 改造 6 子项目中的 SP-6（与 SP-1 模型去进程化、SP-2 一次性 LLM、SP-3 真对话模式、SP-4 真控制面、SP-5 after-tool 回灌 正交）。

## 1. 背景与目标

用户诉求（原话归纳）：「上下文的回退、删除任意段的上下文内容、以及对压缩完全可控」。这三件本质都是**把"喂给 LLM 的上下文"从黑盒变成用户可控的对象**。

当初判定这些"够不到"是基于更早的 Pi 版本；经 0.79.10 实地核实，支撑这三件的扩展钩子均已开放且返回值被运行时应用（见 §9 代码核对）。因此本子项目**零 fork**。

目标：在不改 Pi 核心、不物理改写磁盘会话历史的前提下，让用户能（a）手动把任意段移出 LLM 上下文并可恢复，（b）回退到更早的对话点，（c）在压缩发生前预览/编辑/取消。

## 2. 现状核验（实地，带锚点）

现有 `compaction-policy` 扩展已落地两件，本子项目在其上叠加：

- `extensions/compaction-policy/index.ts:14` —— 已用 `pi.on("context")` 做 **ephemeral prune**：`extensions/compaction-policy/prune.ts:18` `pruneMessages` 把"保护窗口（最近 `keepRecentTurns` 个 user 轮）之外、已完成的大 `toolResult` body"替换为占位符，保留消息结构。默认**关**（`COMPACTION_POLICY_PRUNE=0`，`index.ts:8`）。
- `extensions/compaction-policy/index.ts:21` + `pressure.ts` —— 上下文**压力分级**指示，`ctx.ui.setStatus("ctx", ...)`，默认**开**。
- `extensions/compaction-policy/index.ts:29` —— `/compaction` 命令查看压力与 prune 状态。

缺口（本子项目要补）：

1. prune 是**自动、仅针对 `toolResult`**；用户**无法手动删任意段**（任意 message / 整轮）。
2. **无就地回退**：RPC 协议 `tauri-agent/src-tauri/src/pi/types.rs:7` 的 `PiOutbound` 仅有 `Fork`（:41）、`SwitchSession`（:35）、`Clone`、`GetForkMessages`（:51）、`Compact`（:100）；**无 `navigate_tree`**。上游 rpc 模式（`pi-coding-agent/dist/modes/rpc`）实际只 `case` 了 `prompt/steer/follow_up/abort/set_model/set_steering_mode/set_follow_up_mode/compact/set_auto_compaction/abort_retry/abort_bash/switch_session/fork/clone/get_fork_messages`，确认无就地树导航命令。
3. **压缩不可控**：扩展未挂 `session_before_compact`，压缩产物无法预览 / 编辑 / 取消。

可达性结论（源码核实，见 §9）：

- `context` 钩子返回 `{messages}` 被运行器应用（`runner.js`：`currentMessages = handlerResult.messages`）→ **删任意段可达**。
- `session_before_compact` 钩子返回 `{cancel?, compaction?}` 被应用 → **压缩接管可达**。
- `fork(entryId, position)` RPC 原生（`agent.rs:507` `agent_fork`）→ **回退-MVP 可达**；就地 `navigateTree` 非 RPC 原生 → **回退-增强**需上游 PR 加 `navigate_tree`（additive）或侧信道，列为后续。

## 3. 组件设计

三件能力共享一条主线：**会话级的"上下文意图"状态**（排除集 + 压缩偏好），由扩展持有、`context` / `session_before_compact` 钩子消费，桌面通过松耦合通道驱动。

### 3.1 删任意段（用户驱动的上下文排除）

**职责**：用户在聊天里选中任意 message / 整轮，将其移出"喂给 LLM 的上下文"，且可恢复；不物理删除磁盘历史。

**机制**：

- 每会话维护一个**排除集** `Set<entryId>`（内存态 + 持久化）。
- `context` 钩子在喂 LLM 前，按 entry id 过滤掉被排除的 message（与现有 prune 在同一钩子内**合并应用**：先排除集过滤，再 prune toolResult body）。
- 排除是"对 LLM 不可见"，**不动磁盘**（append-only 安全）。

**持久化**：用 `pi.appendEntry("context_exclusion", { ids, op: "add"|"remove", entryId })` 落会话树。理由：树感知，分支切换 / reload 后状态正确恢复（避免只存桌面全局态导致 `/tree` 分支错乱——见 Pi 扩展能力矩阵的明确告诫）。`session_start` 时回放这些 custom entry 重建排除集。

**桌面 → 扩展通道**（松耦合）：桌面选中 message → 写 `.pi/context-control/<sessionId>.json`（桌面写、扩展在 `context` 钩子读）并 bump `PI_RELOAD_REV` 触发轻量通知；扩展读取后更新内存集 + `appendEntry` 固化。备选：经一个隐藏的 `/ctx-exclude <entryId>` 命令（但那会回到伪对话路径，**不采用**）。

**UI**：消息气泡操作栏加「移出上下文」/「恢复」；被排除的 message 灰显 + 角标；`/compaction`（或新 `/context`）命令列出当前排除项数量。

### 3.2 上下文回退

**职责**：回退到更早的对话点，从那里重新开始。

**MVP（RPC 原生，基于 fork）**：

- 聊天里选某条更早 message → 「从这里重来」→ `agent_fork(entryId, position:"before")`（`agent.rs:507` 已有）创建分支 → 桌面切到新分支继续。
- 已有 `agent_get_fork_messages`（`agent.rs:524`）可预览将保留的消息；前端补交互即可。
- 语义：新分支（保留原路径，符合树模型），而非物理截断。

**增强（就地 navigateTree，后续）**：

- 真正"移 leaf、丢弃其后、同一文件"。需上游 RPC 增 `navigate_tree` 命令（additive，低风险，建议提 PR）或侧信道驱动 `ExtensionCommandContext.navigateTree`。
- 在 MVP 验证体验后再决定是否推。

**UI**：消息操作栏「回退到此」；回退前提示将分叉 / 丢弃的轮次数。

### 3.3 压缩完全可控

**职责**：压缩发生前可预览、编辑摘要、取消；触发时机可控。

**机制**：compaction-policy 增挂 `pi.on("session_before_compact")`：

- 读 `preparation`（`messagesToSummarize` / `turnPrefixMessages` / `tokensBefore` / `fileOps` / `settings`）。
- 经 `ctx.ui.confirm` + `ctx.ui.editor`（RPC 模式经 `extension_ui` 子协议透到桌面 UI）让用户**预览/编辑摘要 / 取消**。
- 返回 `{ cancel: true }` 取消本次压缩，或 `{ compaction: 用户编辑后的 CompactionResult }` 用自定义摘要。

**触发控制**：保留 `agent_compact`（手动，`agent.rs:400`）+ `agent_set_auto_compaction`（`agent.rs:417`）；阈值经 `CompactionSettings`（reserveTokens / keepRecentTokens）暴露为配置。

**默认**：预览开关默认**关**（不打断现有自动压缩）；开启后才弹预览。

**与 session-memory 协同**：现有 `session-memory` 在压缩后经 `before_agent_start` 重锚状态（`extensions/session-memory/injector.ts`）。本扩展只接管"压缩产物"，不干预 session-memory 的重锚，二者正交。

## 4. 数据流

```
删段：  桌面选中 message ──写 .pi/context-control/<sid>.json + bump rev──▶ 扩展读取
        → appendEntry("context_exclusion") 固化 + 更新内存集
        → 下一次 LLM 调用：context 钩子 = 排除集过滤 ∘ prune ──▶ 喂给 LLM 的 messages

回退：  桌面选 entryId ──agent_fork(before)──▶ 新分支 ──切换──▶ 从该点继续

压缩：  阈值/手动触发 ──session_before_compact 钩子──▶ ctx.ui 预览/编辑/取消
        → 返回 {cancel} 或 {compaction: 编辑后结果} ──▶ 应用
```

## 5. 持久化

| 状态 | 位置 | 恢复时机 |
| --- | --- | --- |
| 排除集 | `appendEntry("context_exclusion")`（会话树内） | `session_start` 回放 |
| 桌面意图传递 | `.pi/context-control/<sessionId>.json`（瞬时通道） | 扩展读后即固化到树 |
| 压缩偏好 | runtime-config（`COMPACTION_PREVIEW` 等） | 热重载 |

## 6. 错误处理 / 降级（全部 fail-soft）

- `context` 钩子内任何异常 → 返回 `undefined`（不改上下文），**绝不阻断**主流程。
- 排除集引用了已不存在的 entry id → 静默跳过。
- `session_before_compact` 的 UI 失败 / 超时 / 不可用 → **fail-open 放行**默认压缩（绝不卡住压缩链路）。
- `fork` 失败 → 提示用户，**不动当前会话**。
- 删段只影响"喂 LLM"，永不物理删盘 → append-only 安全，最坏情况是少喂/多喂几条，可逆。

## 7. 模式适配

- `ctx.ui.*`（预览/编辑）在 RPC 模式经 `extension_ui` 子协议到桌面；`print`/`json` 模式 `hasUI=false` → 压缩预览降级为静默放行默认压缩。
- 删段 / prune 是纯数据变换，与模式无关，三模式一致生效。

## 8. 非目标（明确不做）

- **物理抹除磁盘会话历史**（真删 entry）：违背 Pi append-only 树模型，属第三层"改核心数据模型"，不做；删段以"对 LLM 不可见"达成等效目标。
- **就地 navigateTree 的 RPC 原生命令**：本期 MVP 用 `fork` 顶；增强需上游 PR，单列。
- 改压缩**触发算法本身**（阈值/overflow 检测在核心）：本期只接管"产物"与"预览"，触发用既有 settings + 手动 `compact()`。

## 9. 代码核对修订（实地锚点）

- 现有 prune/pressure：`extensions/compaction-policy/index.ts:8,14,21,29`、`extensions/compaction-policy/prune.ts:18`。
- 钩子可达性（上游 d.ts）：`pi-coding-agent/dist/core/extensions/types.d.ts` —— `on("context", …ContextEventResult{messages?})` :827、`on("tool_result", …)` :844、`on("session_before_compact", …SessionBeforeCompactResult{cancel?,compaction?})` :822。
- 钩子结果被应用（上游编译实现）：`pi-coding-agent/dist/core/extensions/runner.js` —— context：`currentMessages = handlerResult.messages`；tool_result：`currentEvent.content/details/isError = handlerResult.*`。
- RPC 会话操作现状：`tauri-agent/src-tauri/src/pi/types.rs:7`（`PiOutbound`，Fork:41 / SwitchSession:35 / Compact:100 / GetForkMessages:51，**无 navigate_tree**）。
- Tauri 既有命令：`agent.rs:400` `agent_compact`、`:417` `agent_set_auto_compaction`、`:485` `agent_switch_session`、`:507` `agent_fork`、`:524` `agent_get_fork_messages`。
- 上游 rpc 模式命令集：`pi-coding-agent/dist/modes/rpc/*`（无 navigate_tree，确认就地回退须增强）。

## 10. 测试策略

- prune ∘ 排除集**合并过滤**正确性（顺序、互不破坏结构）。
- 排除集 `appendEntry` 持久化 + `session_start` 回放恢复；分支切换后排除集随分支正确。
- `context` 钩子 fail-soft（抛错 → 返回 undefined，上下文不变）。
- `session_before_compact`：cancel 生效、custom compaction 生效、UI 超时 fail-open 放行。
- 回退：`fork(before)` 分支正确、`get_fork_messages` 预览一致。
- jiti smoke（扩展加载不崩）。

## 11. MVP 与增强分层

**MVP**：删任意段（context 钩子 + appendEntry 持久 + 桌面操作栏）、回退（基于 fork）、压缩预览/编辑/取消（session_before_compact + ctx.ui，默认关）。

**增强**：就地 navigateTree 回退（上游 PR）、排除集的批量/按规则排除、压缩摘要的结构化模板编辑、与 session-memory 的更深协同。
