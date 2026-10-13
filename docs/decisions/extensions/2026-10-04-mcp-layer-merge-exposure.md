> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-04-mcp-config-layers-and-oauth.md](../../../.agents/notes/implemented/architecture/2026-10-04-mcp-config-layers-and-oauth.md) 维护；本文件冻结只读。

---
title: MCP 配置按桌面、全局、项目三层合并，并带上 exposure
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/merge.ts
  - extensions/mcp/config.ts
  - extensions/mcp/manager.ts
supersedes:
superseded_by:
---

## 背景
MCP 服务器同时来自回合快照 `PI_MCP_CONFIG`、桌面 `MCP_SERVERS`、`~/.pi/agent/mcp.json` 和项目 `.pi/mcp.json`。原先在读文件时就把同名项盖掉，并只认 command/url，项目里只写 `exposure` 或 `enabled: false` 的条目到不了连接列表。

## 决定
管理器读配置时先 `mergeMcpLayers`（桌面覆盖回合快照里的同名项，然后全局，然后项目），再走原来的 `injectDefaultServers` 和 `expandServerVars`。没有 command/url 的项目条目只补已有服务器的 `enabled`、`exposure`、`toolExposure`、`description`。`disabledMcpServers` 和 `enabled: false` 不连接。非法 exposure 跳过该服务器。`expandServerVars` 展开 `${ENV}`、整段 `!command`，以及 cwd 的 `~/` 和相对路径。

## 放弃的方案
- 只合并三个文件层、丢掉 `PI_MCP_CONFIG`：回合中途 `setLiveWorkspaceMcpConfig` 和冻住的 ALS 快照会失效。
- 合并之后仍用旧的 overlay 把快照盖回去：文件里的禁用名单删不掉快照里的同名服务器。
- 让 `parseMcpServers` 直接返回没有 command/url 的条目：现有调用方会把它们当成可连接服务器。

## 后果
`open-websearch` 的注入条件不变。`autoEnableCodemode` 已算出来，但本步不改变工具激活。项目配置出现在全局禁用名单里的名字仍然不连接。
