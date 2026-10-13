# Agent Note: 并行子代理冷启动开销

Status: implemented

## Problem

并行 10 个子代理、每个跑 5 秒的命令，每个从发起到开跑 24–27 秒，电脑发卡。和链式 / 并行调度无关：每个子会话在 agent-host 同一个事件循环里串行地 `ModelRuntime.create`、建 resource loader、加载约 40 个扩展；子代理的文字 / 思考 / 工具参数增量逐 token 转发两跳 IPC；三个扩展每个会话都 `watchConfig` 且不退订；fable 每个会话都重播模板；`WorkspaceBar` 对子代理每个工具结束都跑 git status。

## Decision

- 共享 ModelRuntime：`extensions/_shared/shared-model-runtime.ts`。agent-host 的 `ModelRuntimeHost.create`（`electron/agentProcess/runtimeGraph.ts`）登记；`embedded-runner.ts`、`activation.ts` 的 `createAgentSessionServices` 取到就传 `modelRuntime`。新增建子会话的地方 **must** 一样传。没登记的进程照旧自建。
- 子代理增量合并：`createDeltaCoalescer`（`electron/agent/toolcallDeltaCoalescer.ts`），`WorkspaceHandle` 按 sessionPath 一个、60ms、`STREAM_DELTA_TYPES`。子会话非重试 `agent_end` 后删除，`dispose` 全部 flush。主会话 **never** 合并文字增量。
- 扩展工厂里的全局订阅 **must** 在 `session_shutdown` 退订（approval / agent-mode / compaction-policy）。进程级一次性动作（fable 播种）用模块级标志。
- 父会话的 UI 刷新 **never** 由子代理事件驱动（`WorkspaceBar` 忽略 `source === 'subagent'`）。

## 原始记录（合并自 docs/decisions）

以下为 `docs/decisions/electron-agent/2026-10-10-subagent-parallel-startup-cost.md` 的原文（标题降一级），保留本笔记未写到的细节；与上文冲突时以上文为准。

### 背景

一次并行 10 个子代理、每个只跑 5 秒的命令，每个子代理从发起到真正开跑要 24–27 秒，期间电脑明显发卡。和链式 / 并行的调度无关，开销在三处：

1. **建子会话在 agent-host 里串行排队。** 每个嵌入式子代理都 `createAgentSessionServices`，里面各自 `ModelRuntime.create`（读 auth.json / models.json、建内置供应商目录、两次全量重建），再建 resource loader、加载约 40 个扩展。十个子代理同时启动，这些同步段在同一个事件循环里一个接一个跑。
2. **子代理事件逐 token 转发。** 主会话的工具参数增量早有合并（`createToolcallDeltaCoalescer`），子会话的文字 / 思考 / 工具参数增量却原样一条条走 agent-host → 主进程 → 渲染层。十个并行时每秒几百条，渲染层每条都要过 reducer。
3. **每个会话都做一遍的副作用。** `approval` / `agent-mode` / `compaction-policy` 在扩展工厂里 `watchConfig`，从不退订，每启动一个子代理多一份订阅，之后每次配置变化都给已销毁的会话跑回调；`fable-behavior` 每个 `session_start` 都读模板清单、逐个算 sha256；`WorkspaceBar` 对子代理的每个 `tool_execution_end` 都跑一遍 git status / branch。

### 决定

- **共享 ModelRuntime。** agent-host 的 `ModelRuntimeHost.create` 建好运行时后 `setSharedModelRuntime(runtime)`（`globalThis` 上的 Symbol，跨模块实例也能取到），重建时随之替换。嵌入式子代理和冷恢复建子会话时把它传给 `createAgentSessionServices({ modelRuntime })`。没有宿主登记的进程（pi-worker、测试）取不到，子会话照旧自建。
- **子代理增量按会话合并。** `createDeltaCoalescer(emit, { windowMs, types })` 从原来的工具参数合并器里抽出来，合并条件是同类型、同 `contentIndex` 的连续增量，遇到别的事件先冲掉。`WorkspaceHandle` 给每个子会话（按 sessionPath）一个 60ms 窗口的合并器，类型是 `STREAM_DELTA_TYPES`（toolcall / text / thinking 增量）；子会话非重试的 `agent_end` 后丢掉它，handle 拆掉时全部冲掉。主会话那份照旧只合并工具参数，不改它的手感。
- **订阅随会话退订、一次性动作只做一次。** 三处 `watchConfig` 的返回值在 `session_shutdown` 调用。fable 模板播种改成进程内一次（模板目录是全局的）。`WorkspaceBar` 忽略 `source === 'subagent'` 的事件，子代理改的文件在父会话这一轮 `agent_end` 时一起刷新。

### 放弃的方案

- **按 cwd 缓存子会话的资源快照（技能、提示词、上下文文件）。** 约 110 个技能每个子代理都扫一遍，这是剩下的大头之一，缓存收益最直接。但技能 / 规则文件在会话中途会被改（resource-reload 就是为此存在的），缓存要接上同一套失效通知，否则子代理拿到旧技能；先看这一轮修完的复测数据，确实还慢再做。
- **子代理改到独立进程（pi-worker）里跑。** 能真正并行、彻底不占 agent-host 的事件循环，但每个子代理多一个 Node 进程和一份模块加载（冷启动本身就要 1–2 秒、上百 MB），父子会话的 ALS 上下文、审批继承、事件桥都要改成跨进程。十个并行时内存和启动成本反而更高。
- **只在渲染层节流。** 能减轻渲染压力，但 agent-host → 主进程 → 渲染层两跳 IPC 的序列化开销不变，主进程照样被事件刷屏。
- **子代理增量也用主会话的工具参数合并器。** 那只合并 toolcall 增量，子代理刷屏的主力是文字和思考增量；主会话的文字增量也不想加 60ms 延迟（主对话流式的手感优先）。

### 后果

- 子会话和交互会话共用一份 ModelRuntime：供应商配置、登录态改了以后子代理立即看到（和交互会话一致）。子会话不再是独立快照；若以后 ModelRuntime 带上会话级可变状态，要重新评估。
- 子代理事件最多晚 60ms 到渲染层；`agent_end`、`tool_execution_*`、`message_end` 这类非增量事件会先冲掉积压的增量再发，顺序不变。
- 扩展工厂里新加的全局订阅都要配 `session_shutdown` 退订，`extensions/_shared/watch-config-unsubscribe.test.ts` 只盖住了现有三处。

## Alternatives considered

- **按 cwd 缓存子会话资源快照（约 110 个技能）**——剩下的大头，但要接 resource-reload 的失效通知，否则子代理拿到旧技能。先看复测数据。
- **子代理放进独立 pi-worker 进程**——真并行，但每个多一个 Node 进程和模块加载，ALS 上下文、审批继承、事件桥要全改成跨进程，十个并行时成本更高。
- **只在渲染层节流**——两跳 IPC 的序列化开销不变。

## Consequences

- **收益**：每个子会话少一次 ModelRuntime 重建；子代理事件量按 60ms 窗口压缩；配置订阅不再随子代理累积。待用户用同样的 10 并行复测拿数字。
- **代价**：子会话与交互会话共享 ModelRuntime，不再是独立快照；子代理事件最多晚 60ms。
- **重访信号**：复测仍有十几秒冷启动 → 做资源快照缓存；ModelRuntime 带上会话级可变状态 → 重新评估共享。

## Verification

- `cd electron-agent && npx vitest run electron/agent/toolcallDeltaCoalescer.test.ts electron/agent/workspaceHandle.test.ts src/features/chat/input/workspace/WorkspaceBar.test.tsx`
- `cd extensions && npx vitest run _shared/watch-config-unsubscribe.test.ts multi-agent`
- 决策记录：[docs/decisions/electron-agent/2026-10-10-subagent-parallel-startup-cost.md](../../../../docs/decisions/electron-agent/2026-10-10-subagent-parallel-startup-cost.md)。
