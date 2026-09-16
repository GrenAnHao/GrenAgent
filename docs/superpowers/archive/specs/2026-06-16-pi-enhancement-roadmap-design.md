# Pi 增强路线图设计（总览）

> 日期：2026-06-16
> 状态：设计已批准，待拆分为各子项目规格
> 范围：本文是**总览参考设计**，覆盖全部缺失点（A/B/C/D）。每个子项目后续各自走 规格 → 计划 → 实现 周期。

## 0. 拆分进展与核验修正（2026-06-16）

本总览已拆为 6 份子项目规格（均在 `docs/superpowers/specs/2026-06-16-*-design.md`），每份含实地代码核验（带 `文件:行号` 锚点的「代码核对修订」段）：

- A `goal-stop-condition-design.md`、B `session-memory-design.md`、C `compaction-policy-design.md`
- D.1 `session-search-design.md`、D.2 `diagnostics-design.md`、D.3 `code-search-design.md`

> 运行时基准：扩展实际运行于 npm 包 `@earendil-works/pi-coding-agent@0.79.x`（`extensions/node_modules/`），仓库**无** `pi/` fork。本总览 §3 的若干「需改核心」结论据此被修正，**以各子规格为准**：

1. **C 不必改核心（推翻 §4.C「MVP 走核心改动」）**：运行时暴露 `context` 扩展钩子（`pi.on("context")` 返回 `{messages}` 改写发往 LLM 的 `AgentMessage[]`，即 `transformContext` 注入点）与 `session_before_compact`（返回自定义 `CompactionResult`）。prune / 尾部保留 / 压力分级均可**纯扩展**实现。
2. **会话文件真实路径（推翻 §4.D.1 的 `.pi/sessions/`）**：实为 `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl`（全局按 cwd 分区）；D.1 改用官方 `SessionManager.list/listAll` + `ctx.sessionManager.getSessionDir()` 枚举。
3. **embedding 复用粒度（细化 §4.D）**：HTTP/端点/配置（`_shared/provider-endpoint`+`runtime-config`）可直接复用，但**向量存取在 LTM/RAG 间重复**；D.3 前置抽 `_shared/embedding.ts` + `_shared/vector-store.ts`。
4. **B 上下文重建机制（优化 §4.B MVP）**：用 `session_compact` 事件驱动注入（替代「轮询 getEntries 看新 compaction 条目」）；B 的「摘要基底」增强亦为纯扩展（`session_before_compact`），非核心改动。
5. **D.2 exec/settings**：扩展跑 shell 用 `node:child_process`（现网惯例）或 `pi.exec`；`.pi/settings.json` 不经 `runtime-config`，需直读或 `SettingsManager`。

净结论：原 §2 决策表「实现载体：扩展优先，必要时改核心」在本轮核验后收紧为 **全部子项目（含 C）均可纯扩展落地，零核心改动、零 fork 维护成本**。

## 1. 背景与目标

Pi（`earendil-works/pi`）采用「极简核心 + 可插拔扩展」哲学：核心仅 7 个工具（read/write/edit/bash/grep/find/ls），能力靠 `extensions/` 钩子补齐。与 MiMo-Code（OpenCode 重型 fork，22 内置工具 + 深度集成的记忆/压缩/Goal/子代理）对比，Pi 在**语义记忆**（`long-term-memory` 的 embedding + LLM 整合）和**子代理进程隔离**（`multi-agent` 的 worktree/profile/registry）上反而领先，真正的缺口集中在长程自主与上下文韧性：

- **A. Goal 停止条件 + 独立裁判** —— 防长程任务「乐观早停」。
- **B. 结构化会话状态 + 上下文重建** —— 压缩后不丢「在干什么」。
- **C. 压缩精细化（prune / 尾轮保留 / 压力分级）** —— 长对话不被一刀切摘要丢上下文。
- **D. 编码工具补全（历史检索 / 诊断 / 语义代码搜索）** —— 补齐编码反馈闭环。

目标：把以上缺口设计成可独立拆分、可独立落地的单元，作为后续规格拆分的参考。

## 2. 全局设计决策（贯穿全部子项目）

| 决策 | 选择 | 说明 |
|---|---|---|
| 实现载体 | **扩展优先，必要时改核心** | 能用扩展钩子就用；`Pi/pi/` 是 fork，C/D 中钩子够不到时允许有节制地改核心。 |
| 完成度 | **分层：MVP 核心 + 可选增强** | 每项 MVP 先落地，增强按需取舍。 |
| 与现有扩展关系 | **混合复用** | 职责相同则增强现有扩展，不同则新建并定义松耦合协作接口（读对方 `.pi/` 数据）。 |
| 整体架构 | **方案 1：独立扩展 + `_shared` 协作** | 每缺口一个自包含扩展，贴合 Pi 扩展包哲学，利于逐个拆规格、故障隔离。核心改动仅限 C/D 钩子够不到的最小点。 |

### 命名冲突处理
现有 `checkpoint` 扩展是 **git 文件快照/回滚**（职责 = 文件树版本）。本路线图的「会话状态」职责不同，**改名 `session-memory`**，避免与 `checkpoint` 混淆。

## 3. Pi 核心关键事实（设计依据，来自 `docs/pi/architecture.md`）

- 主链路第 5 步：`AgentMessage[]` 先过可选 `transformContext()`，再由 `convertToLlm()` 转成 provider message —— **prune / 尾轮保留的天然落点**。
- 事件：`agent_start/end`、`turn_start/end`、`compaction_start/end`、`tool_execution_*`、`message_*`、`extension_error`。
- 扩展钩子：`before_agent_start`、`agent_end`、`turn_start/end`、`tool_call`、`session_start/shutdown` 等；可 `registerTool/registerCommand`、`sendMessage({triggerTurn})`、`setActiveTools/getActiveTools`、`appendEntry`、`ctx.ui.{notify,select,confirm,input,setStatus}`。
- 会话：JSONL v3 树结构，entry 含 `message/compaction/branch_summary/custom/...`；`buildSessionContext()` 从 leaf 回溯 root。
- 压缩在核心 `@earendil-works/pi-agent-core`，产出 `compactionSummary {summary, tokensBefore}`，有 `compact` 命令 + `set_auto_compaction`。
- LLM 调用范式：扩展可经 `ctx.model` + `ctx.modelRegistry` 取模型并调用（见 `long-term-memory` 的 `makeAsk`）。
- 安全：核心默认无权限隔离，由 `safety`/`mcp-policy` 扩展补。

## 4. 子项目设计

### A. Goal 停止条件 + 独立裁判（新扩展 `extensions/goal/`）

**职责**：给会话设「完成条件」，agent 想停时由独立裁判判定是否真达成；未达成则重入继续。

**为什么纯扩展可行**：`agent_end` 钩子异步，可 `await` 一次裁判 LLM 调用，再 `sendMessage(reason, { triggerTurn: true })` 重入 —— 即 `plan-mode` 已验证的「agent_end 里 triggerTurn 重入」模式。LLM 调用复用 `long-term-memory` 的 `makeAsk(ctx.model, ctx.modelRegistry)`。

**组件**
- `index.ts` —— 注册 `/goal` 命令 + `agent_end`/`session_start` 钩子。
- `judge.ts` —— transcript（`event.messages` → 文本）+ 条件 → 裁判模型 → 解析 verdict。
- `state.ts` —— 内存态 `{condition, react}`，`appendEntry("goal", ...)` 持久化，`session_start` 恢复。

**数据流**：`/goal <条件>` 设定 → agent 跑 → `agent_end` → 裁判读 transcript → 未达成且 `react<上限`：`sendMessage(理由, triggerTurn:true)` 且 `react++`；达成或超上限：清除 + `ui.notify`。

**错误处理**：裁判失败 → **fail-open 放行**（绝不困住用户）；`react` 上限（默认 12）兜底；用户 abort 时不重入。

**MVP 核心**
- `/goal <条件>` / `/goal clear`。
- 裁判 ok / not-ok（纯文本 transcript）。
- 未达成重入 + react 上限 + fail-open。
- appendEntry 持久化 + session_start 恢复。

**可选增强**
- `impossible`（真不可达）判定。
- 结构化 verdict（typebox/JSON schema 约束输出）。
- `ctx.ui.setStatus("goal", ...)` 状态指示 + 每轮裁决标记。
- 裁判用 native model messages（含工具调用/图片）而非纯文本。
- `GOAL_MODEL` / `GOAL_MAX_REACT` 可配置。

**测试**：裁判解析兜底、超上限终止、fail-open、set/clear、jiti smoke。

---

### B. 结构化会话状态 + 上下文重建（新扩展 `extensions/session-memory/`）

**职责**：维护结构化会话状态（意图/下一步/任务进度/关键文件/决策），在上下文被压缩后**重新锚定** agent。

**关键抉择 —— 怎么「重建」**：MVP **不重写核心 compaction**，走 Pi 原生「注入」路线。核心已有自动压缩；本扩展额外维护结构化状态，在 `before_agent_start` 把它作为 custom message 注入（`long-term-memory`/`plan-mode` 同款）。压缩后的下一轮被结构化状态重新锚定 = 轻量版上下文重建。

**组件**
- `writer.ts` —— 周期性用小模型把对话抽取成固定小节（裁剪自 MiMo 的 11 段，YAGNI）。
- `store.ts` —— 落 `.pi/session-state/<id>.md` + `appendEntry`。
- `injector.ts` —— `before_agent_start` 检测「上次状态之后发生过 compaction」则注入（避免每轮浪费 token）。

**数据流**：`agent_end`（每 N 轮或 token 增长达阈值）→ 写状态。`before_agent_start` → 若 `getEntries()` 出现新的 `compaction` 条目 → 注入最新状态（带 char 预算）。

**协作**：可选读 `todo` 扩展的任务列表、`long-term-memory` 召回来丰富状态（只读对方 `.pi/` 数据，松耦合）。

**MVP 核心**
- 周期性 LLM 抽取结构化状态 → markdown 持久化。
- 压缩后注入状态重新锚定。
- `/session-state show`。

**可选增强（含核心改动）**
- 核心钩子：让 compaction 直接用结构化状态作摘要基底（省双重摘要）；监听 `compaction_start` 在压缩**触发前**先写状态（比轮询更准）。
- 预算注入 + 重要性排序。
- 深度整合 `todo` 任务树进度。

**错误处理**：LLM 失败保留上一份状态；无状态则不注入（优雅降级）。

**测试**：状态抽取解析、「压缩后注入」触发条件、持久化/恢复。

---

### C. 压缩精细化（核心改动 + `compaction-policy` 扩展）

**职责**：上下文管理从「一刀切整体摘要」升级为 prune（裁旧工具输出）+ 尾轮保留 + 压力分级。

**载体**：压缩在核心 `@earendil-works/pi-agent-core`，扩展钩子够不到，**MVP 走核心改动**（默认关闭以降低 fork 维护成本），配置/可观测层用扩展。

**核心落点**：主链路第 5 步 `transformContext()`（prune/尾轮保留挂此）；`compaction_start/end` 事件供观测。

**MVP 核心（改 agent-core）**
- **prune**：`transformContext()` 阶段，把超出「保护窗口」的**旧的、已完成的 toolResult** 内容替换为占位符（保留 tool call 结构，丢输出体），释放上下文且不触发整体摘要。
- **尾轮保留**：compaction 时最近 N 轮原样保留，只摘要 head。
- 全部 **behind config 默认关闭**，不改上游默认行为。

**可选增强**
- 把 `transformContext` 暴露成扩展钩子 `pi.on("transform_context")`，使 prune 回归可插拔扩展（对齐「扩展优先」）。
- **压力分级 0–3**：经 `compaction_start`/`get_session_stats` 暴露，`ctx.ui.setStatus` 显示。
- 与 B 联动：`compaction_start` 时通知 `session-memory` 先写状态再压缩。

**错误处理**：prune 只动「已完成且超出保护窗口」的 toolResult，**绝不动最近轮/用户消息**；配置非法回退默认。

**测试**：保护窗口边界、尾轮保留正确性、默认关闭时行为与上游完全一致。

---

### D. 编码工具补全（一组独立小扩展）

**职责**：补齐编码反馈闭环缺的三个工具。各自独立，其中两个复用 `long-term-memory`/`_shared` 的 SQLite + embedding 基础设施。

#### D.1 跨会话历史检索（`session-search/`）
- **MVP**：把 `.pi/sessions/*.jsonl` 消息文本索引进 SQLite **FTS**（关键词，中英文分词，复用 `_shared`）；工具 `history_search({query, topK})` 返回命中会话 + 片段；`/history` 命令。
- **增强**：embedding 语义检索；按时间/项目过滤；命中后跳转/恢复会话。

#### D.2 诊断反馈（`diagnostics/`）
- **MVP**：工具 `diagnostics({paths?})` 运行项目配置的 check 命令（`tsc --noEmit`/eslint，从 `.pi/settings.json` 读或自动探测），解析成 `{file,line,severity,message}` 结构化返回。轻量，不需 LSP。
- **增强**：真正的 **LSP 客户端**（启动 language server，文件级实时诊断，对齐 MiMo `lsp` 工具）；`afterToolCall` 在 edit/write 后自动诊断回灌。

#### D.3 语义代码搜索（`code-search/`）
- **MVP**：复用 embedding 基础设施对代码文件建索引；工具 `code_search({query, topK})` 返回相关文件/片段。**优先级最低**（grep 已覆盖关键词，YAGNI）。
- **增强**：符号级（函数/类）索引；文件变更增量更新；与 grep 融合排序。

**错误处理**：统一 fail-soft —— 无索引返回空 + 提示；check 命令缺失给明确错误；不阻断主流程。

**测试**：FTS 命中/分词、诊断输出解析、各工具空索引降级；jiti smoke。

## 5. 拆分与依赖关系

每个子项目（含 D 的三个子工具）各自一份规格 → 计划 → 实现。依赖与建议顺序：

```
A Goal ───────────────┐ (无依赖，ROI 最高，先做)
                       │
B session-memory ──────┤ (可选复用 A 的判定；可独立)
                       │
C 压缩精细化 ──────────┘ (B 增强层依赖 C 的 compaction_start 联动；C 可独立先做 MVP)

D.1 history / D.2 诊断 / D.3 代码搜索 (各自完全独立，任意顺序)
```

**建议落地顺序**：A（独立、高 ROI）→ C-MVP（prune/尾轮，长对话韧性）→ B（依赖 C 的事件做增强）→ D.1/D.2（编码闭环）→ D.3（最低优先）。

**耦合约定**：B 读 `session-memory` 自有数据 + 可选读 `todo`/`long-term-memory` 的 `.pi/` 数据；C 增强层通过 `compaction_start` 事件通知 B；其余互不依赖。

## 6. 横切关注点

- **持久化**：统一落 `.pi/` 下（`goal` 用 appendEntry；`session-memory` 用 markdown + appendEntry；`session-search`/`code-search` 用 SQLite，复用 `_shared`）。
- **模型与成本**：Goal 裁判、session-memory 抽取、语义检索均为额外 LLM/embedding 调用，应可配置开关与模型（默认用小模型或主模型），避免每轮固定开销。
- **降级**：所有 LLM/embedding 依赖在无 key/调用失败时 fail-soft，不阻断主流程。
- **模式适配**：涉及 `ctx.ui.*` 的功能用 `ctx.hasUI`/`ctx.mode` 判断，RPC/print 模式下降级为静默或通知。
- **安全**：新增工具继承 Pi 默认权限模型；写类工具（无）/命令执行（D.2 的 check 命令）应受 `safety`/`mcp-policy` 约束。
