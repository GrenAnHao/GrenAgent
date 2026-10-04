---
title: MCP 卡片显示登录，快速表单写回时保留 oauth 等未知字段
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/features/extensions/McpServerCard.tsx
  - electron-agent/src/features/extensions/mcpConfig.ts
  - electron-agent/src/stores/mcpStatusStore.ts
  - extensions/mcp/index.ts
supersedes:
superseded_by:
---

## 背景

服务器需要登录时，管理器快照上已有 `loginUrl`，但卡片只认识 connecting / connected / failed。快速表单保存时按已知键重写配置，`oauth` 和 `exposure` 会被丢掉。

## 决定

`runtimeStatus` 增加 `needs-login`。该状态下状态文案是「需要登录」，主按钮走现有的 `openUrl`。打开失败时 URL 留在卡片上，并出现「复制」。卡片显示 `exposure`；`auth` 为 `oauth` 或 `provider` 时显示「OAuth」或「供应商登录」。

`configToForm` 把表单不编辑的字段放进 `extra`。`serializeForm` 先合并 `extra`，再用表单改过的 `command`、`args`、`url`、`headers`、`env`、`cwd` 覆盖同名键。

`summary()` 在有 `loginUrl` 时把它放进 `mcp.state.publish` 的 server 对象。该对象本来就带 `exposure` 和 `auth`。

## 放弃的方案

- 给 oauth 和 exposure 各做表单控件：快速表单只改命令和连接字段，再加控件就变成另一套设置页。
- 打开外部链接失败就清掉 URL：卡片无法再复制登录地址。
- 登录状态单独做一页设置：登录动作就在这张服务器卡片上。

## 后果

快速表单不认识的字段会原样写回，包括以后新增的键。表单清空 `args`、`env`、`cwd` 或 `headers` 时，这些键不会从 `extra` 里复活。`loginUrl` 只在存在时出现在摘要里，没有登录地址的服务器对象不带这个键。
