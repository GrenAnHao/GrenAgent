# 子项目 A：Goal 停止条件 + 独立裁判（设计/规格）

- 日期：2026-06-16
- 状态：草案 — 已实地核验（npm 运行时 `@earendil-works/pi-coding-agent@0.79.x`），待用户审查
- 主题：给会话设「完成条件」，agent 想停时由独立裁判 LLM 判定是否真达成；未达成则自动重入继续，防长程任务「乐观早停」
- 载体：纯新扩展 `extensions/goal/`，零核心改动
- 上游总览：`docs/superpowers/specs/2026-06-16-pi-enhancement-roadmap-design.md` §4.A

> 锚点约定：下文 `types.d.ts` = `extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`（扩展运行时的真实类型定义）。所有「核验」结论来自该 npm 包 dist 与现有扩展源码，非本地 fork（仓库无 `pi/` 目录）。

## 1. 目标与范围

### 1.1 目标
- `/goal <条件>` 设定会话完成条件；agent 自然结束（`agent_end`）时，独立裁判读完整 transcript 判定是否达成。
- 未达成 → 自动 `sendMessage(理由, { triggerTurn: true })` 重入，附带未达成原因引导下一轮。
- 达成 / 超过重入上限 / 用户中止 → 清除目标并通知，绝不困住用户。

### 1.2 成功标准（MVP）
1. `/goal 写完并通过 X 测试` 后，agent 若在条件未满足时停下，会被裁判判为 not-ok 并自动重入继续。
2. 条件满足时裁判判 ok，目标清除，不再重入。
3. 裁判 LLM 调用失败时 fail-open（放行结束），不阻断。
4. 重入次数达上限（默认 12）强制终止并通知。
5. 会话重开后目标状态可从 session entry 恢复。

### 1.3 不在范围（移至可选增强）
- `impossible`（真不可达）判定、结构化 verdict schema、状态栏每轮裁决标记、裁判使用 native model messages（含图片/工具调用）。

## 2. 背景与代码依据（实地核验）

本扩展所需的全部能力在现有扩展中均有**已上线的同款用例**，无需任何核心改动：

| 能力 | 运行时 API（核验锚点） | 现有同款用例 |
|---|---|---|
| `agent_end` 异步钩子，拿完整 transcript | `AgentEndEvent { type; messages: AgentMessage[] }`（`types.d.ts:507-510`）；`on("agent_end", ExtensionHandler<AgentEndEvent>)`（`types.d.ts:824`）；`ExtensionHandler` 返回 `Promise<R\|void>` 即可 `await`（`types.d.ts:804`） | `plan-mode/index.ts:134-181` 在 `agent_end` 里 `await ctx.ui.select(...)` 后 `sendMessage(triggerTurn:true)` |
| 重入下一轮 | `sendMessage(msg, { triggerTurn?: boolean; deliverAs? })`（`types.d.ts:859-862`） | `plan-mode/index.ts:172-179`（`triggerTurn: true`） |
| 进程内调 LLM（裁判），复用当前 agent 模型 | `ctx.model`（`types.d.ts:222`）+ `ctx.modelRegistry`（`types.d.ts:220`）；pi-ai `completeSimple` | `long-term-memory/llm.ts:54-70`（`askMemoryLlm`）+ `index.ts:107-115`（`makeAsk`） |
| 解析裁判输出（容错 JSON） | — | `long-term-memory/llm.ts:12-36`（`parseJsonLoose`） |
| 持久化 + 恢复目标态 | `appendEntry(customType, data)`（`types.d.ts:871`）；`ctx.sessionManager.getEntries()` 读回 | `plan-mode/index.ts:38, 183-194`（写 `plan-mode` custom entry，`session_start` 恢复） |
| 注册命令 `/goal` | `registerCommand(name, { description, handler })`，handler 签名 `(args: string, ctx: ExtensionCommandContext)=>Promise<void>`（`types.d.ts:842, 793-799`） | `plan-mode/index.ts:56-69`、`long-term-memory/index.ts:268-364` |
| 中止判定 / 状态 / 通知 | `ctx.signal`（`types.d.ts:228`）、`ctx.isIdle()`（`:224`）、`ctx.hasUI`/`ctx.mode`（`:212-214`）、`ctx.ui.notify`/`setStatus`（`:74-79`） | `plan-mode/index.ts:26-35, 149` |

> 关键确认：`agent_end` 处理器可为 async 且可 `await` 一次裁判 LLM 调用，再决定是否 `triggerTurn` 重入 —— 这正是 `plan-mode` 已验证的模式。Goal 与 `plan-mode` 的差异仅在「重入前先 await 裁判」。

## 3. 架构与组件

独立扩展 `extensions/goal/`，四个文件：

- `index.ts` —— 默认导出 `ExtensionFactory`。注册 `/goal` 命令 + `session_start`（恢复）+ `agent_end`（裁判→重入）钩子；持有内存态。
- `judge.ts` —— `judge(ask, transcript, condition): Promise<Verdict>`。把 `AgentMessage[]` 拍平成文本 transcript，拼裁判 system+user prompt，调 `ask`，用 `parseJsonLoose` 解析 `{ verdict: "ok"|"not_ok", reason }`；解析失败回退按文本含 `ok` 粗判，再失败 fail-open。
- `state.ts` —— `GoalState { condition: string; react: number }` 内存态；`persist(pi)` 用 `appendEntry("goal", state)`；`restore(ctx)` 从 `getEntries()` 取最后一条 `type==="custom" && customType==="goal"` 的 `data`。
- `llm.ts`（或直接复用思路）—— `makeAsk(ctx)`：`resolveModel(ctx.model, ctx.modelRegistry, GOAL_MODEL)` → 绑定 `askLlm(model, system, user, ctx.signal)`。镜像 `long-term-memory/llm.ts`，避免跨扩展 import（各扩展独立打包）。

职责边界：`judge.ts` 纯函数（输入 transcript+condition+ask，输出 verdict），可独立单测；`index.ts` 只管钩子编排与状态；`state.ts` 只管持久化。

## 4. 数据流

```
/goal <条件>                → state.condition=<条件>, state.react=0, persist, ui.setStatus("goal", 条件摘要)
agent 跑完一轮 → agent_end  → 若无 condition：return
                            → 若 ctx.signal?.aborted（用户中止）：return（不重入）
                            → ask = makeAsk(ctx); 若无模型：fail-open（清状态/通知）
                            → verdict = await judge(ask, event.messages, condition)
                            → ok        ：clear + ui.notify("目标达成")
                            → not_ok    ：若 react<上限：react++, persist,
                                          sendMessage({customType:"goal-reentry", content:`目标未达成：${reason}\n继续完成：${condition}`, display:true}, {triggerTurn:true})
                                          若 react>=上限：clear + ui.notify("已达重入上限，停止")
/goal clear                 → clear state + persist + ui.setStatus("goal", undefined)
session_start               → restore(ctx)；有 condition 则 ui.setStatus
```

## 5. 错误处理与边界

- **fail-open 总原则**：裁判调用/解析任何异常 → 视为放行（结束），`ui.notify` 提示「裁判不可用，已放行」。绝不因裁判故障把用户困在重入循环。
- **重入上限**：`GOAL_MAX_REACT` 默认 12，到顶强制清除并通知。
- **用户中止**：`agent_end` 时检查 `ctx.signal?.aborted`；中止不触发裁判、不重入。
- **无模型**：`makeAsk` 返回 undefined（无 `ctx.model` 且 `GOAL_MODEL` 未配）→ fail-open。
- **无 UI 模式**（`!ctx.hasUI`，如 print/json）：仍可裁判+重入（重入是 `sendMessage` 不依赖 UI）；`notify`/`setStatus` 在无 UI 时本就降级，无需特判，但日志可经 `ctx.ui.notify` 安全调用（注：核验 `notify` 在所有 mode 可调，非 TUI 专属，参 `ExtensionUIContext` `types.d.ts:74`）。
- **并发**：`agent_end` 串行触发；裁判 await 期间不会有新 `agent_end`。

## 6. 配置（经 `_shared/runtime-config.ts` 的 `getConfig`）

- `GOAL_MODEL`（可选）：裁判模型 `provider/id`，缺省用 `ctx.model`。
- `GOAL_MAX_REACT`（可选，默认 12）：重入上限。
- `GOAL_ENABLED`（可选，默认开）：总开关。

> 说明：`getConfig` 的取值来源（env / runtime-settings.json）由 `_shared/runtime-config.ts` 统一提供，spec D 同款复用；本扩展不直接读文件。

## 7. 测试

- `judge.test.ts`：verdict 解析（标准 JSON / fenced / 噪声 / 纯文本回退 / 全失败 fail-open），用假 `ask`，不打真实 LLM。
- `state.test.ts`：persist→restore round-trip；多条 goal entry 取最后一条。
- 重入上限：模拟连续 not_ok 到上限后停止。
- 用户中止：`signal.aborted` 时不重入。
- jiti smoke：扩展能被 `jiti` 加载、默认导出为函数（与现有扩展一致的冒烟）。

## 8. 实现文件清单

| 文件 | 职责 |
|---|---|
| `extensions/goal/index.ts` | 工厂：命令 + `session_start`/`agent_end` 钩子 + 编排 |
| `extensions/goal/judge.ts` | transcript 拍平 + 裁判 prompt + verdict 解析（纯函数） |
| `extensions/goal/state.ts` | GoalState 持久化/恢复 |
| `extensions/goal/llm.ts` | makeAsk / resolveModel / askLlm（镜像 long-term-memory/llm.ts） |
| `extensions/goal/judge.test.ts`、`state.test.ts` | 单测 |
| `extensions/package.json` | `pi.extensions[]` 追加 `./goal/index.ts` |

## 可选增强（YAGNI，MVP 后按需）
- 结构化 verdict（typebox/JSON schema 约束输出）。
- `impossible` 判定（真不可达时停止并说明）。
- `ctx.ui.setStatus("goal", "▶ react n/上限")` 每轮裁决可视化。
- 裁判用 native model messages（保留工具调用/图片）而非纯文本 transcript。
- 与子项目 B 联动：把裁判「未达成原因」写入 session-memory 状态。

## 规格自检（2026-06-16）
- [x] 无「待定/TODO」占位
- [x] 架构（4 文件）与成功标准对齐；MVP 与可选增强边界清晰
- [x] 范围可用单一实现计划覆盖
- [x] 模糊点已定：fail-open、重入上限、中止不重入均明确

## 代码核对修订（2026-06-16，实地核验 v1）
- [x] `agent_end` 异步 + 完整 `messages` 属实：`AgentEndEvent`（`types.d.ts:507-510`）、handler（`:824`）、`ExtensionHandler` 可返回 Promise（`:804`）
- [x] 重入 `sendMessage(triggerTurn:true)` 属实：`types.d.ts:859-862`；现网用例 `plan-mode/index.ts:172-179`
- [x] 进程内裁判 LLM 属实：`long-term-memory/llm.ts:54-70`（`completeSimple`）+ `index.ts:107-115`（`makeAsk` 用 `ctx.model`/`ctx.modelRegistry`）
- [x] verdict 容错解析有现成实现：`parseJsonLoose`（`long-term-memory/llm.ts:12-36`）
- [x] 持久化/恢复属实：`appendEntry`（`types.d.ts:871`）、`getEntries()` 恢复模式（`plan-mode/index.ts:183-194`）
- [x] 零核心改动：以上全部为扩展运行时公开 API，无需 fork/改 agent-core
