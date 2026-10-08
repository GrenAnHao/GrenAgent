---
title: pi 接口自动重试期间这一轮保持进行中，报错进会话重试条
status: active
date: 2026-10-08
scope: electron-agent/chat
files:
  - electron-agent/src/stores/agentReducer.ts
  - electron-agent/src/features/chat/ChatView.tsx
supersedes:
superseded_by:
---

## 背景
供应商接口报错（502 / 限流等）时 pi 自己会退避重试，事件顺序是 `message_end`(带 errorMessage) → `agent_end(willRetry: true)` → `auto_retry_start` → 退避 → 新的 `agent_start`。渲染层把 `agent_end(willRetry)` 当成本轮结束、清 `isStreaming`，又不处理 `auto_retry_start`：界面先闪红条、输入栏变回「待发送」，退避结束又被硬拉回发送中；重试等待期间没有停止按钮，也就没法取消。

## 决定
- `agent_end(willRetry: true)` 不清 `isStreaming`，把这次报错挪进 `retrying.error`（`auto: true`），不写 `lastError`。`ChatView` 的发送等待（`awaitStreamingEnd`）因此跨重试一直挂着，停止按钮一直在。
- `auto_retry_start` 写入次数和原因；退避后的 `agent_start` 不清 `auto` 重试条；重试中再失败的 `message_end` 只更新 `retrying.error`。
- 收尾：`auto_retry_end(success)` 清条；`agent_end(!willRetry)` / `agent_settled` 时若重试条还在，把最后的报错落成 `lastError`（用户中断的除外）；`auto_retry_end` 的 `Retry cancelled` 不算失败。
- 重试条里的「取消」仍走 `pi.abort`，pi 的 `abort()` 会顺带 `abortRetry()`，退避等待中也能停。
- 界面自己的发送重试（`retrying` 无 `auto`）行为不变，仍由 `agent_start` 收掉。

## 放弃的方案
- `agent_end(willRetry)` 照旧清 `isStreaming`，靠 `retrying` 撑住输入栏：`awaitStreamingEnd` 会在第一次失败就放行，`runOnce` 按失败走回滚和红条，与后面 pi 的重发打架。
- 关掉 pi 的自动重试、统一用界面的 `MAX_SEND_RETRIES`：界面重试只覆盖「没进入回合」的发送失败，回合中途（工具调用之后）的接口错误重发必须由 pi 在同一轮里做，否则历史会重复。
- 主进程过滤掉 `agent_end(willRetry)`：`runningSessions`、`workspaceHandle` 等已按 willRetry 区分处理，事件本身要保留；问题只在渲染层的解释。

## 后果
- 第一次失败的 `message_end` 和 `agent_end(willRetry)` 是两条 IPC，中间可能有一帧红条，随后换成黄色重试条。
- 重试用完时先由 `agent_end` 落红条，`ChatView` 的 `runOnce` 再按「回合已开始的失败」处理，不会再触发界面自己的重发。
- pi 若改了重试事件顺序（比如 `auto_retry_start` 先于 `agent_end`）需要重新核对：当前实现两种顺序都能收敛，但 `attempt: 0` 的「准备重试」文案依赖现顺序。
