---
title: 未登记的 MCP 工具名在别的服务器还在列工具时不能靠 setActiveTools 留住
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/index.ts
supersedes: 2026-10-04-mcp-log-rotate-deferred-names.md
superseded_by:
---

## 背景

Pi 1.0.2 把恢复出来、尚未注册的工具名放在 `_pendingToolNames`，`getActiveTools()` 看不到它们。`setActiveTools` 一旦少了任何一个当前激活名，就会清空整份 pending；只追加则保留。未注册的名字传进去也不会进入激活集，更不会写回 pending。工具稍后 `registerTool` 时，对得上的 pending 名会变成激活；这时若再按非 direct 把它们拿掉，其余还没列出的 `mcp__*` 一起丢。

日志轮转仍按上一篇：文件加上这一行会超过 5MB 时改名为 `.1`。

## 决定

`retainDeferredNames` 仍只是把缺失名字 push 进数组。`project()` 在保存列表里还有未登记、且服务器未失败的 `mcp__*` 时，`setActiveTools` 只追加 direct、`codemode`、`tool_search`，不删除当前激活名，也不把未登记名字传进去。这些名字留在 `project()` 的返回值里，下一次继续传入。服务器已连接（列出过工具）或已失败的名字离开保存列表。快照里没有的服务器，以及仍在 connecting 的服务器，名字留下。保存列表空了之后，原来的过滤才跑：非 direct 的 `mcp__*` 和三个资源工具离开激活集。

## 放弃的方案

- 继续把未登记名字塞进同一次 `setActiveTools`：Pi 会丢掉这些名字，而且这次调用只要同时拿掉一个已激活工具，其余 pending 就没了。
- 在还有未登记名字时就拿掉非 direct：这正是清 pending 的那次调用。
- 失败服务器的名字也一直留着：服务器已经失败，不再会列出这个工具。
- 按工具名从 Pi 的 pending 里只删掉失败服务器那一个：`setActiveTools` 要么整份保留，要么整份清空，做不到只删一个。

## 后果

还有别的服务器没列出工具时，已经登记的非 direct 工具会暂时留在激活集里，直到保存列表变空。失败服务器的名字会离开我们的保存列表，但只要还有别的名字要保，它仍会留在 Pi 的 pending 里，直到下一次可以收紧激活集的调用。
