---
title: 资源工具从激活集摘掉，列表调用传 cursor
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
`list_mcp_resources` 等三个名字不以 `mcp__` 开头。`project()` 原先只从激活集剔除非 direct 的 `mcp__*`，资源工具一旦进过激活集，服务器变 hidden、扩展卸载或 exposure 收窄后仍会留下。列表接口的 schema 有 `cursor`，管理器调用 SDK 时没传，也没把 `nextCursor` 放进 `shapeMcpResult` 保留的那份结果。

## 决定
这三个名字按与 `mcp__*` 相同的规则处理：本次 `project()` 没有把它们放进 `direct` 就从激活集去掉。SDK `pi` 没有 unregister / remove tool，不另造 API。调用 `listResources` / `listResourceTemplates` 时，调用方给了 `cursor` 就原样传给 SDK；单台服务器的 `nextCursor` 写进现有的 structured content 与 JSON 文本。

## 放弃的方案
- 给 `ProjectablePi` 加 `unregisterTool`：1.0.2 的 `ExtensionAPI` 没有这个方法，造出来会话侧接不住。
- 只在完全不注册时才摘掉、exposure 收窄仍留在激活集：和 `mcp__*` 的 direct 规则不一致，收窄后模型仍会直接看到资源工具。

## 后果
资源工具从 direct 变成 codemode / deferred 时也会离开激活集，只能走脚本或 `tool_search`。多台服务器一起列举时不附带顶层 `nextCursor`，翻页要带 `server`。
