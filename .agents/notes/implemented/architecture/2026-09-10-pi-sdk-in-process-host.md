# Agent Note: 桌面端内嵌 Pi SDK 宿主，取代 PiClient JSONL sidecar

Status: implemented

## Problem

桌面端原来通过 `PiClient` 以 JSONL RPC 驱动一个 Pi sidecar 进程（`runRpcMode`、`resources/pi`），oneshot / probe / 后台任务另走 `systemWorkerManager`。规格 `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design.md` 审查确认：Goal worker 与交互 worker「共享同一 jsonl」从未落地（`--session` 在 rpc 分支被丢弃），且 session 写入是无锁 `appendFileSync`，两个 runtime 持同一 jsonl 必然树分叉。

## Decision

（现状：交互运行时已再搬进 agent-host 子进程，见 [agent-host 子进程](./2026-10-09-agent-host-child-process.md)；本笔记记录其下仍有效的宿主边界。Goal 路由部分已被 [Goal 回到会话](./2026-09-13-goal-as-session-events.md) 取代。）

- 宿主内嵌 `@earendil-works/pi-coding-agent`：`AgentHost` 维护 `Map<workspace, WorkspaceHandle>`，`WorkspaceHandle` 用 ALS 包装、支持 rebind / downgrade（63103296、98e07cd3）。不同项目不共用主 Agent。
- 不变量：**每个会话 jsonl 同一时刻只有一个持有者**。
- 短调用（记忆提炼、知识库、增强提示词、测活）改为 `ModelRuntime.completeSimple` 串行队列（03a3e269）。
- 子代理仍是独立进程：`spawn(process.execPath, [pi-worker])` + `ELECTRON_RUN_AS_NODE=1`；不编 `pi.exe`。
- 渲染层 `agent_*` IPC、`pi://event` / `pi://ui-request` / `pi://exit` 信封、事件载荷、UI 请求字段名、读命令返回形状冻结。
- 无双栈：`PiClient` JSONL、`runRpcMode` 桌面路径、`resources/pi`、sidecar manager 一次删除（4bac5e75）。
- `PI_RUNTIME_CONFIG` 全局单份，在任何 ALS `run()` 之前初始化。

### 涉及文件

- `electron-agent/electron/agent/`
- `electron-agent/electron/pi/systemWorkerManager.ts`
- `cli/src/`

### 来源

- 54950528（规格与计划）
- 63103296
- 98e07cd3
- 03a3e269
- 4bac5e75
- a7da7d78
- `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design.md`

## Alternatives considered

- **`utilityProcess.fork` 拉子代理**：支持 env / cwd / execArgv / stdio pipe。不选（规格原文）：唯一实质差别是只能在 app ready 后的主进程调用、不是普通可执行文件；收益不足以换掉现有 spawn / killTree 代码（「丢 stdout」「不支持 cwd/env」都不是理由）。
- **保留 JSONL sidecar 与新宿主双栈过渡**：可灰度。不选：规格定为「无双栈，合入主线一次切完」。
- **同项目每会话真并发**：规格当时不做；后来由 [同项目运行中会话各占 handle](./2026-09-30-same-project-concurrent-handles.md) 部分放开。
- 另见规格审查 `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design-review.md`。

## Consequences

- 对渲染层的 IPC / 事件契约是冻结面，改它要新笔记。
- 任何让两个运行时同时写同一 jsonl 的设计都违反不变量。

## Verification

verify: n/a 回填的历史决定，规格与提交未记录验证结果
