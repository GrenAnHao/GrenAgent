# Agent Note: 并行子代理冷启动开销

Status: implemented

## Problem

并行 10 个子代理、每个跑 5 秒的命令，每个从发起到开跑 24–27 秒，电脑发卡。和链式 / 并行调度无关：每个子会话在 agent-host 同一个事件循环里串行地 `ModelRuntime.create`、建 resource loader、加载约 40 个扩展；子代理的文字 / 思考 / 工具参数增量逐 token 转发两跳 IPC；三个扩展每个会话都 `watchConfig` 且不退订；fable 每个会话都重播模板；`WorkspaceBar` 对子代理每个工具结束都跑 git status。

## Decision

- 共享 ModelRuntime：`extensions/_shared/shared-model-runtime.ts`。agent-host 的 `ModelRuntimeHost.create`（`electron/agentProcess/runtimeGraph.ts`）登记；`embedded-runner.ts`、`activation.ts` 的 `createAgentSessionServices` 取到就传 `modelRuntime`。新增建子会话的地方 **must** 一样传。没登记的进程照旧自建。
- 子代理增量合并：`createDeltaCoalescer`（`electron/agent/toolcallDeltaCoalescer.ts`），`WorkspaceHandle` 按 sessionPath 一个、60ms、`STREAM_DELTA_TYPES`。子会话非重试 `agent_end` 后删除，`dispose` 全部 flush。主会话 **never** 合并文字增量。
- 扩展工厂里的全局订阅 **must** 在 `session_shutdown` 退订（approval / agent-mode / compaction-policy）。进程级一次性动作（fable 播种）用模块级标志。
- 父会话的 UI 刷新 **never** 由子代理事件驱动（`WorkspaceBar` 忽略 `source === 'subagent'`）。

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
