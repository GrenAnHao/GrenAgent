---
title: MCP 日志轮转，并在重载时留住还没登记的工具名
status: superseded
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/logRotate.ts
  - extensions/mcp/manager.ts
  - extensions/mcp/index.ts
supersedes:
superseded_by: 2026-10-04-mcp-pending-loadout-keeps-names.md
---

> 已过时 → 见 2026-10-04-mcp-pending-loadout-keeps-names.md

## 背景

连接、登录和失败没有落盘。会话恢复和 `/reload` 时，Pi 会先按转录恢复激活工具名，再跑 `session_start`。此时服务器往往还没列出工具。`project()` 会拿掉每一个不在本次 direct 列表里的 `mcp__*`，还没 `registerTool` 的 deferred 名字就丢了。已经登记成非 direct 的名字仍然必须离开激活集。

## 决定

`appendCappedLog` 在文件已存在且当前大小加上这一行的字节数超过 5MB 时，把原文件改名为 `path.1`（已有 `.1` 先删掉再改名），再把这一行写成新文件；否则追加。管理器的 connect、login、failed 都写到 `~/.pi/agent/mcp.log`，写失败不影响连接。

`retainDeferredNames` 只把还不在激活集里的名字补回去。`bind` 在 `startup`、`reload`、`resume`、`fork` 时，从当前激活集和 `buildSessionProjection` 的 system `toolsAdded` 收集 `mcp__*`，丢掉当时已经 `getAllTools` 的名字。每次 `project()` 用本次 `registerTool` 的名字再滤一遍，剩下的在同一次 `setActiveTools` 里放回。登记之后按原规则处理：direct 留下，非 direct 去掉。

## 放弃的方案

- 在 `project()` 里无条件留住所有未登记的 `mcp__*`：普通投射会把已经失效的 `mcp__old__gone` 也留住。
- 工具列表到达后仍把 deferred 名字留在激活集：这会推翻「已知非 direct 离开激活集」。
- 日志按「当前大小已超过 5MB」再轮转：正好 5MB 时下一次写入不会改名，和「加上这一行就超过」不一致。
- 在 Windows 上直接 `rename` 覆盖 `.1`：目标已存在时会失败。先删除再改名。

## 后果

`new` 会话不保留上一份激活集里的 `mcp__*`。服务器一直列不出某个名字时，这个名字会留在激活集里。日志写到用户主目录，单测里的连接也会追加几行。
