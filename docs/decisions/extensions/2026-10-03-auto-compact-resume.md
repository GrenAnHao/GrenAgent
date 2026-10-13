> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-30-compaction-and-context-policy.md](../../../.agents/notes/implemented/architecture/2026-09-30-compaction-and-context-policy.md) 维护；本文件冻结只读。

---
title: 进行中的自动压缩结束后续跑
status: active
date: 2026-10-03
scope: extensions
files:
  - extensions/compaction-policy/index.ts
  - extensions/compaction-policy/resume.ts
  - electron-agent/src/stores/agentReducer.ts
supersedes:
superseded_by:
---

## 背景
占用到触发值时，扩展在 `turn_end` 调用 `ctx.compact()`。这是 Pi 的手动压缩入口：先 abort 当前回合，压完 `willRetry` 为 false，不会再跑。对话还在调用工具或输出被截断时，压缩一结束任务就停了。用户点的手动压缩本来就应该停住。

## 决定
自动压缩若打断的是还会继续的回合（已有工具结果、输出停在 length、或队列里还有消息），压缩成功或非取消失败后，用一条 `display: false` 的自定义消息再开一轮。模型已经正常说完，或这一轮是用户取消，则不续跑。手动压缩仍直接走 `AgentSession.compact()`，不挂这个回调。

## 放弃的方案
- 把触发百分比折进 Pi 的 `reserveTokens`，让循环里的自动压缩自己接上下一轮：同一字段还决定摘要输出上限，大窗口上会把摘要预算放大到几十万 token，而且按模型存，做不到按会话覆盖。
- 压完插入一条可见的用户消息「继续」：对话里会出现用户没发过的气泡。
- 只要是自动压缩就续跑，包括模型已经说完的回合：会在答完之后再多生成一轮。
- 调用 `agent.continue()`：扩展上下文没有这个方法；abort 还可能在末尾留下一条 assistant，`continue()` 会直接拒绝。

## 后果
续跑指令会进会话文件，界面不显示，模型看得到。安全扩展用 `terminate` 停掉的工具批，在 `turn_end` 上看不出来，若同一轮正好自动压缩，仍会续跑。压缩本身会先 abort，模型侧可能出现 “Request was aborted”；界面在 `compaction_start` 时清掉这类中断报错。
