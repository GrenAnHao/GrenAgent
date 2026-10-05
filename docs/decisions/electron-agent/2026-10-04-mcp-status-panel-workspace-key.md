---
title: MCP 运行时状态按面板 workspace key 落库
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/electron/main.ts
  - electron-agent/electron/agent/agentHost.ts
  - electron-agent/electron/agent/workspaceHandle.ts
supersedes:
superseded_by:
---

## 背景

扩展用 `ctx.cwd` 发 `mcp.state.publish`。ExtensionsPanel 用 AgentStore 的 `workspace` 读 `serversByWorkspace`。`createWorkspaceHandle` 里这两键可以不同；按 cwd 落库时卡片拿不到 `exposure`、`auth`、`loginUrl`，「登录」不出现。

## 决定

`mcp.state.publish` 在 main 里找 `cwd` 等于发布路径的活 handle，广播 `handle.workspace`。对不上就原样用发布路径，不丢状态。只写面板那把 key。

## 放弃的方案

- 扩展里猜面板 key：扩展只看见 cwd，猜会猜错。
- cwd 和 workspace 各写一份：面板只读 workspace，双写多一份过期状态。
- 面板同时查两把 key：状态仍落在 cwd 下，其它读方还要对齐。

## 后果

没有活 handle 时状态仍按发布路径存。handle 拆掉之后再推一次，会回到 cwd key，直到下次打开项目。
