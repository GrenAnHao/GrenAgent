---
title: 正在处理从本轮开始计时，子代理同样显示
status: superseded
date: 2026-10-04
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/PendingResponseStatus.tsx
  - electron-agent/src/features/chat/ChatListView.tsx
  - electron-agent/src/features/chat/SubAgentInline.tsx
  - electron-agent/src/features/panels/SubAgentConversation.tsx
  - electron-agent/src/stores/agentReducer.ts
supersedes:
superseded_by: electron-agent/chat/2026-10-04-pending-clock-spans-follow-on-runs.md
---

> 已过时 → 见 [2026-10-04-pending-clock-spans-follow-on-runs.md](2026-10-04-pending-clock-spans-follow-on-runs.md)

## 背景

主会话底部的「正在处理…」从状态条挂上才开始计时，而且不满 15 秒不显示。组件一重挂，时间就归零。子代理卡片和右坞对话没有这一行。

## 决定

时钟从这一轮开始就显示。主会话记在 `runStartedAt`：发送或 `agent_start` 写入，同一轮里的重试沿用，`agent_settled` 清掉。子代理用注册表的 `createdAt`。子代理横条、并行行、右坞和子会话底部都用同一行「正在处理…」。

## 放弃的方案

- 继续满 15 秒才显示：短回合看不出已经跑了多久，和「从运行开始就计时」相反。
- 只用组件挂载时间：打开一个已经跑了一阵的子代理，会从 0 秒重新数。

## 后果

没有 `createdAt` 的子代理（注册表还没轮询到）先从这一行出现时计时，拿到启动时间后再对齐。恢复一个重启前就在跑的主会话时，如果当时没写入 `runStartedAt`，时钟从恢复后看到这一轮算起。
