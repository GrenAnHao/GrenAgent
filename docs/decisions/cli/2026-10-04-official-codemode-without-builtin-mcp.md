---
title: 会话挂官方 codemode，CLI 用 extensionFactories 换掉内置 MCP
status: active
date: 2026-10-04
scope: cli
files:
  - cli/src/gren-runtime.ts
  - cli/src/runtime.ts
  - cli/src/pi-worker.ts
supersedes:
superseded_by:
---

## 背景
1.0.2 的 CLI `main()` 会预置 `builtInExtensions`（含 `builtin:codemode`、`builtin:tool-search`、`builtin:mcp`）。SDK 的 `createAgentSessionServices` 不会预置它们。Electron 会话走 `makeGrenRuntimeFactory`，CLI 走 `main()`。官方 MCP 客户端不能和产品自己的 MCP 扩展一起加载。

## 决定
`makeGrenRuntimeFactory` 在 `PI_SYSTEM_WORKER !== "1"` 时，把 `extraFactories` 接在 `filterManagedExtensions` 之后。生产默认是 `createCodemodeExtension()` 和 `createToolSearchExtension()`。`PI_SYSTEM_WORKER === "1"` 时工厂列表仍是空的，不追加 extra。

CLI 的 `runtime.ts` 和 `pi-worker.ts` 继续把产品扩展传给 `main` 的 `extensionFactories`。argv 里还没有 `-builtin:mcp` 时，再追加 `{ name: "mcp", builtin: true, factory() {} }`。1.0.2 的 `MainOptions` 只有 `extensionFactories`。`main()` 把内置扩展放在前面，同名且 `builtin: true` 的后项覆盖 Map，空工厂替换 `createMcpExtension`。这两条路径不再追加 codemode 或 tool_search。

## 放弃的方案
- 按计划初稿追加 `--extensions -builtin:mcp`：1.0.2 没有 `--extensions`。`--extension` / `-e` 是加载路径，不是禁用。裸参数 `-builtin:mcp` 会被当成未知选项并退出。
- `--no-extensions`：会同时关掉官方 codemode 和 tool_search。
- 把 `-builtin:mcp` 写进 settings：`setExtensionPaths` 会落盘，改到用户配置。
- 在 CLI 的 `extensionFactories` 里再放 `createCodemodeExtension()`：`main()` 的内置扩展已经加载一次，会注册两遍。

## 后果
`builtin:mcp` 这条资源默认仍会进入加载，但执行的是空工厂，不会连接官方 MCP。用户 settings 里的 `-builtin:mcp` 仍然可以排除这条资源；argv 已经包含该字符串时不再追加空工厂。Electron 不经过 `main()` 的内置列表，官方 codemode 与 tool_search 只从 `extraFactories` 进入一次。
