# Agent Note: 所有子代理改为非内嵌，统一在独立进程中运行

Status: rejected — 被 [2026-10-11-subagent-redesign.md](../../implemented/architecture/2026-10-11-subagent-redesign.md) 取代：默认进程内运行，worker 只用于崩溃 / OOM / 原生模块隔离和进程级环境，worktree 由显式工具创建。

## Problem

现在子代理有两种跑法：内嵌 Activation（可续聊）在宿主进程内运行，需要 worktree 隔离的子代理由 agent-host 子进程起 worker（见 `../../implemented/architecture/2026-09-13-subagent-activation-and-routing.md`）。用户说明：这种分工大概率是当时的技术债导致的。

## Proposal

方向（用户说明）：所有子代理都改为非内嵌，统一以独立进程运行。

待确认：
- 内嵌 Activation 的续聊能力在独立进程下怎么保留。
- 进程模型：每个子代理一个进程，还是共享 worker 池。
- 与 agent-host 子进程、现有 worker 入口（`PI_WORKER_ENTRY`）的关系。
- 名额上限、并行提前启动（`launchEarly`）、路由白名单在新模型下是否不变。
- 迁移顺序。

## Acceptance criteria

- 不再有在宿主进程内运行的内嵌子代理。
- 其余标准待确认。

## Risks

否决原因：两个参考系统（DSH、Codex）都没有全部进程外；续聊 / fork 要全部重做在 RPC 上，进程启动和内存成本高；worktree 不需要独立进程（显式 `create_worktree` 即可）。若重提，需先证明进程内崩溃隔离不够用。

原记录：
待确认：进程启动开销、内存占用、宿主与子代理之间的 IPC 设计。

## Alternatives considered

- **维持内嵌 + worker 双轨**：即现状；用户认为是技术债的产物。
