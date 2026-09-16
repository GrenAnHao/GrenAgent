# 子项目 B：结构化会话状态 + 上下文重建（设计/规格）

- 日期：2026-06-16
- 状态：草案 — 已实地核验（npm 运行时 `@earendil-works/pi-coding-agent@0.79.x`），待用户审查
- 主题：维护结构化会话状态（意图/下一步/任务进度/关键文件/决策），在上下文被压缩后**重新锚定** agent，使其压缩后不丢「在干什么」
- 载体：纯新扩展 `extensions/session-memory/`，零核心改动
- 上游总览：`docs/superpowers/specs/2026-06-16-pi-enhancement-roadmap-design.md` §4.B

> 锚点约定：`types.d.ts` = `extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`；`session-manager.d.ts` = 同目录 `../session-manager.d.ts`。

> 命名澄清：与 `long-term-memory`（跨会话**事实/偏好**，SQLite+embedding）职责不同。本扩展是**单会话工作态**（当前任务的意图/进度/关键文件），生命周期随会话；也与 `checkpoint`（git 文件快照/回滚）不同。

## 1. 目标与范围

### 1.1 目标
- 周期性把对话抽取成固定小节的结构化状态（markdown），持久化到 `.pi/session-state/<sessionId>.md`。
- 上下文发生压缩后，下一轮自动把最新状态作为 custom message 注入，重新锚定 agent。
- `/session-state show` 查看当前状态。

### 1.2 成功标准（MVP）
1. 长对话中每 N 轮（或 token 增长达阈值）产出/更新一份结构化状态文件。
2. 触发一次压缩后，紧接的下一轮注入了最新状态（agent 能接着原任务而非「失忆」）。
3. LLM 抽取失败时保留上一份状态，不崩、不注入空内容。
4. 会话重开后能读回最近状态。

### 1.3 关键抉择 —— 怎么「重建」
MVP **不重写核心 compaction**，走 Pi 原生「注入」路线（与 `long-term-memory`/`plan-mode` 同款）：核心已有自动压缩；本扩展额外维护结构化状态，**在压缩后**经 `before_agent_start` 注入。压缩后的下一轮被结构化状态重新锚定 = 轻量版上下文重建。

> 实地核验带来的改进：总览 §4.B 设 MVP 用「`before_agent_start` 里轮询 `getEntries()` 看有没有新 compaction 条目」。运行时其实有**直达事件** `session_compact`（压缩后触发，`types.d.ts:433-437,815`），比轮询更准更省。本规格 MVP 改用事件驱动（见 §4）。

## 2. 背景与代码依据（实地核验）

| 能力 | 运行时 API（核验锚点） | 现有同款用例 |
|---|---|---|
| 压缩后注入 custom message | `before_agent_start` 返回 `BeforeAgentStartEventResult { message?; systemPrompt? }`（`types.d.ts:760-764`）；事件含 `prompt/systemPrompt/systemPromptOptions`（`:491-501`）；on（`:822`） | `long-term-memory/index.ts:142-179`、`plan-mode/index.ts:89-123` |
| 压缩后事件（检测压缩发生） | `SessionCompactEvent { compactionEntry: CompactionEntry; fromExtension }`（`types.d.ts:433-437`）；on（`:815`） | 新用法（现有扩展未用，但事件已暴露） |
| 压缩前事件（精准时机写状态/可定制） | `SessionBeforeCompactEvent { preparation; branchEntries; customInstructions?; signal }`（`types.d.ts:425-431`）；可返回 `SessionBeforeCompactResult { cancel?; compaction?: CompactionResult }`（`:772-775`）；on（`:814`） | 新用法 |
| 周期写状态触发点 + token 监测 | `agent_end`（`types.d.ts:824`）；`ctx.getContextUsage(): ContextUsage`（`:236`） | `long-term-memory/index.ts:184-198`（`agent_end` 抽取） |
| 进程内 LLM 抽取状态 | `ctx.model`/`ctx.modelRegistry`；pi-ai `completeSimple` | `long-term-memory/llm.ts:54-70`、`index.ts:107-115` |
| 会话标识 + 目录 + 条目 | `ctx.sessionManager`（`ReadonlySessionManager`，`types.d.ts:218`）暴露 `getSessionId()`/`getSessionDir()`/`getEntries()`/`getLeafId()`（`session-manager.d.ts:136,188-189`）；`getLatestCompactionEntry(entries)`（`:142`） | `plan-mode/index.ts:183-194`（`getEntries()`） |
| 持久化（轻量指针） | `appendEntry("session-memory", { path, updatedAt })`（`types.d.ts:871`） | `plan-mode/index.ts:38` |
| 命令 `/session-state` | `registerCommand`（`types.d.ts:842,793-799`） | `long-term-memory/index.ts:268-364` |

> 关键确认：状态文件名用 `ctx.sessionManager.getSessionId()`（`session-manager.d.ts:188`），稳定唯一；目录基于 `ctx.cwd`/`.pi`。

## 3. 架构与组件

独立扩展 `extensions/session-memory/`：

- `index.ts` —— 工厂。注册 `/session-state` 命令 + `agent_end`（周期写）+ `session_before_compact`（压缩前补写）+ `session_compact`（置 `needReanchor`）+ `before_agent_start`（按需注入）钩子；持有 `{ lastWriteTurn, tokensAtLastWrite, needReanchor }` 内存态。
- `writer.ts` —— `extractState(ask, transcript, prev?): Promise<string>`。小模型把对话抽取成固定小节（裁剪自 MiMo 的 11 段，YAGNI 取核心 5 段：当前意图 / 下一步 / 任务进度 / 关键文件 / 关键决策）；纯函数（注入 ask），可单测。
- `store.ts` —— `path(ctx)`=`join(ctx.cwd, ".pi", "session-state", getSessionId()+".md")`；`write(ctx, md)` 原子写；`read(ctx)`；`appendEntry` 存指针。
- `injector.ts` —— `buildInjection(md, budgetChars): { customType, content, display }`，带字符预算截断。
- `llm.ts` —— `makeAsk(ctx)`（镜像 `long-term-memory/llm.ts`，各扩展独立打包不跨 import）。

## 4. 数据流

```
agent_end（每轮）          → 距上次写 >= N 轮 或 getContextUsage() token 增量达阈值
                            → ask=makeAsk(ctx); 有模型 → md=extractState(ask, transcript, prev); store.write; 记 lastWriteTurn/tokens
session_before_compact      → 压缩即将发生：若距上次写较远，先 store.write 一份最新状态（确保压缩点有快照）
session_compact             → needReanchor = true
before_agent_start          → 若 needReanchor 且 store.read 有内容：
                              return { message: buildInjection(md, 预算) }; needReanchor=false
                            → 否则 return undefined（不每轮注入，省 token）
/session-state show         → ui.notify(store.read(ctx) ?? "暂无状态")
session_start               → 读 appendEntry 指针/或按 sessionId 探测已有 .md（恢复）
```

## 5. 协作（松耦合，只读对方 `.pi/` 数据）
- 可选读 `todo` 扩展的任务列表、`long-term-memory` 召回，丰富状态小节。
- 只读对方数据文件，不互相 import、不依赖对方在场（缺失则跳过该小节）。

## 6. 错误处理与边界
- LLM 抽取失败 → 保留上一份状态文件，不覆盖、不注入空内容。
- 无状态文件 → `before_agent_start` 不注入（优雅降级）。
- 无模型/无 key → 不写状态（功能静默关闭）。
- 注入带字符预算（`SESSION_STATE_MAX_CHARS` 默认 4000，对齐 `long-term-memory` 的 `AUTO_INJECT_MAX_CHARS`，`index.ts:25`），避免注入挤爆刚压缩出的空间。
- `getSessionId()` 在新会话即可用；`session_compact.fromExtension` 可用于避免对自己触发的压缩重复响应。

## 7. 配置（`_shared/runtime-config.ts` 的 `getConfig`）
- `SESSION_STATE_ENABLED`（默认开）、`SESSION_STATE_MODEL`（抽取模型，缺省 `ctx.model`）。
- `SESSION_STATE_EVERY_TURNS`（默认 N=8）、`SESSION_STATE_TOKEN_DELTA`（token 增量阈值）。
- `SESSION_STATE_MAX_CHARS`（默认 4000）。

## 8. 测试
- `writer.test.ts`：状态抽取解析（小节齐全 / LLM 空输出回退保留 prev），假 ask。
- `injector.test.ts`：预算截断、空状态不注入。
- 触发条件：`session_compact`→`needReanchor`→下一次 `before_agent_start` 注入一次后清标志（不重复注入）。
- `store.test.ts`：write/read round-trip、sessionId 路径。
- jiti smoke。

## 9. 实现文件清单
| 文件 | 职责 |
|---|---|
| `extensions/session-memory/index.ts` | 工厂 + 钩子编排 + 内存态 |
| `extensions/session-memory/writer.ts` | LLM 状态抽取（纯函数） |
| `extensions/session-memory/store.ts` | markdown 读写 + sessionId 路径 + 指针 |
| `extensions/session-memory/injector.ts` | 注入构造 + 预算截断 |
| `extensions/session-memory/llm.ts` | makeAsk（镜像 long-term-memory） |
| `*.test.ts` | 单测 |
| `extensions/package.json` | 追加 `./session-memory/index.ts` |

## 可选增强（YAGNI；实地核验后**均无需核心改动**）
- **压缩摘要基底**：`session_before_compact` 返回 `{ compaction: CompactionResult }`，用结构化状态作为压缩摘要基底，省「双重摘要」（总览原标注「含核心改动」，核验后纠正为**纯扩展**，靠 `SessionBeforeCompactResult.compaction`，`types.d.ts:772-775`）。
- 预算注入 + 重要性排序；深度整合 `todo` 任务树进度。
- 与子项目 A 联动：把裁判「未达成原因」并入「下一步」小节。

## 规格自检（2026-06-16）
- [x] 无占位；MVP（事件驱动注入）与可选增强（压缩基底）边界清晰
- [x] 与 §1.3 改进点一致（用 `session_compact` 取代轮询）
- [x] 范围可单一实现计划覆盖
- [x] 模糊点已定：写触发条件、注入时机与去重、预算、降级

## 代码核对修订（2026-06-16，实地核验 v1）
- [x] 注入机制属实：`BeforeAgentStartEventResult.message`（`types.d.ts:760-764`），现网用例 `long-term-memory/index.ts:172-178`
- [x] 压缩事件属实：`session_compact`（`types.d.ts:433-437,815`）、`session_before_compact`（`:425-431,814`）
- [x] 压缩定制纯扩展可行：`SessionBeforeCompactResult { cancel?; compaction? }`（`types.d.ts:772-775`）→ 推翻总览「摘要基底需核心改动」
- [x] 会话标识/目录可得：`getSessionId/getSessionDir/getEntries`（`session-manager.d.ts:136,188-189`）、`getLatestCompactionEntry`（`:142`）
- [x] token 监测可得：`ctx.getContextUsage()`（`types.d.ts:236`）
- [x] 零核心改动
