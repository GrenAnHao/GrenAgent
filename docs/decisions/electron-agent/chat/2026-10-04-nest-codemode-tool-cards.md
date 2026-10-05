---
title: 嵌套 MCP 调用挂在 codemode 工具卡片下面
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/lib/pi.ts
  - electron-agent/src/stores/agentReducer.ts
  - electron-agent/src/features/chat/groupMessages.ts
  - electron-agent/src/features/chat/turnRows.ts
  - electron-agent/src/features/chat/TurnTimeline.tsx
supersedes:
superseded_by:
---

## 背景
codemode 执行脚本时，里面的 MCP 调用会再发出 `tool_execution_*`，`toolCallId` 形如 `parent/1`，并带上 `parentToolCallId`。这些事件原先和父工具一样各自成行，时间线上分不清哪些调用属于同一次 codemode。

## 决定
三条 `tool_execution_*` 事件如果带了 `parentToolCallId`，就写到对应的工具消息上。`buildTurnRows` 把能找到父段的子工具从顶层摘掉，按出现顺序放进父段的 `children`。`TurnTimeline` 在父工具自己的 `ToolExecution` 下面按这个顺序再渲染子工具，子工具仍用原来的 `ToolExecution`。父段不在本轮里时，子工具留在顶层。

## 放弃的方案
- 为嵌套调用新做一种卡片：子工具的参数、结果和状态已经由 `ToolExecution` 覆盖，再做一种只会分叉展示。
- 父段缺失时丢掉子工具：这次调用会从时间线上消失，用户看不到失败或结果。
- 在上下文折叠里再分组：codemode 不是查找类工具，子调用要留在它自己的输出下面，而不是并进 read/list 折叠。

## 后果
重载会话时，工具消息是从 `toolResult` 重建的，上面没有 `parentToolCallId`，嵌套只在当次事件流里成立。以后如果要在重开会话后仍挂在父卡片下，得另从会话记录把这个 id 带回来。
