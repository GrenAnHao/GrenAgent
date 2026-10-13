> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-04-mcp-config-layers-and-oauth.md](../../../.agents/notes/implemented/architecture/2026-10-04-mcp-config-layers-and-oauth.md) 维护；本文件冻结只读。

---
title: codemode 的 MCP 工具不进入激活集
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/index.ts
  - extensions/mcp/manager.ts
supersedes:
superseded_by:
---

## 背景
合并后的 `autoEnableCodemode` 只存在于 `mergeMcpLayers` 的返回值里，管理器快照只留下服务器列表。工具注册则把每个已连接的 `mcp__*` 都放进激活集，模型和 codemode 脚本看到的是同一份名单。

## 决定
`project()` 用 `registerToolName` 登记工具，并带上解析后的 `exposure`、服务器 namespace 和 CallToolResult 形状的 `outputSchema`。激活集只加入 `direct` 工具；已不在本次连接里的 `mcp__*` 会去掉。快照里有 codemode 服务器且 `autoEnableCodemode !== false` 时保证 `codemode` 在列；服务器 exposure 或某个工具解析为 deferred 时保证 `tool_search` 在列。`callTool` 返回 SDK 原始结果，`execute` 再交给 `shapeMcpResult`。权限拒绝带 `isError: true`，不调用服务器。`autoEnableCodemode` 写在管理器快照上，默认读取路径在 `mergeMcpLayers` 之后保留该字段。

## 放弃的方案
- 继续把全部 `mcp__*` 放进激活集，只在描述里区分 exposure：模型仍会直接看到 codemode 工具。
- 在 `execute` 里把结果拼成 `{ text }` 再塑形：`isError` 和 `structuredContent` 到不了 `shapeMcpResult`。
- 让 direct 工具也顺带激活 `codemode`：没有 codemode 服务器时不需要这把钥匙。

## 后果
注入的 `readServers` 不经过合并，快照上的 `autoEnableCodemode` 保持默认 true。未连接的服务器不参与这次激活判断。资源工具、登录和连接等待不在这一步。
