---
title: 只对含 direct 工具的 MCP 服务器等待最多 10 秒
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/wait.ts
  - extensions/mcp/index.ts
  - extensions/mcp/manager.ts
supersedes:
superseded_by:
---

## 背景
`session_start` 会同时拉起全部 MCP 服务器。direct 工具要在下一轮 prompt 里直接给模型，但连接耗时不该挡住没有 direct 工具的服务器，也不该无限挡住这一轮。调用进行中如果服务器还在连，或者已经失败，模型和脚本不该看到未捕获异常。长调用会发进度通知，固定的 60 秒截止会把仍在推进的调用掐掉。

## 决定
`before_agent_start` 只把「解析后的 exposure 含 direct 工具」且仍在连接的服务器交给 `waitForDirect`，预算 10 秒。超时后 prompt 照常继续，底层连接不取消。同一钩子把本轮服务器摘要（名字、exposure、一行 description）和会话里上一次 `mcp-servers` 自定义消息比较；变了就返回 `display: false` 的自定义消息，没变就不写。会话管理器若暴露 `appendMessage`，同时用它写入。`callTool` 在该服务器仍是 `connecting` 时等待本次连接；已经 `failed` 时立刻返回 `isError: true` 和服务器的 `error` 文本，不碰传输。工具调用的截止时间默认 60 秒，取服务器的 `timeout`（秒）。进度通知把这次调用的计时清掉并重设为现在加超时。

## 放弃的方案
- 每台服务器都等满 10 秒：没有 direct 工具的服务器不该挡住 prompt。
- 超时后 abort 连接：还没连上的应留在后台，面板继续显示 connecting 或随后的失败原因。
- 只靠 SDK 的 `resetTimeoutOnProgress`：单测注入的是假客户端，管理器自己的计时必须能被 `onProgress` 清掉。
- 失败服务器继续抛 `not connected`：调用方会变成未捕获异常，而不是带失败原因的工具结果。

## 后果
不含 direct 工具的服务器不进入这 10 秒等待。工具列表还没到、但服务器 exposure 或 `toolExposure` 已经是 direct 时仍会等。调用超时只拒绝这次 `callTool` 的返回，不取消已经发出的传输请求。摘要格式是一行一个服务器：`名字 exposure 一行描述`。
