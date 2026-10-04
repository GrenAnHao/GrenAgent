---
title: MCP 资源工具与扩展登记的服务器共用同一个管理器
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/index.ts
  - extensions/mcp/manager.ts
  - extensions/mcp/config.ts
supersedes:
superseded_by:
---

## 背景
已连接的 MCP 服务器除了工具，还可能提供 resources 和 resource templates。扩展也能在运行时用 `pi.registerMcpServer()` 登记服务器。这两类入口如果各走一套连接，激活集、供应商 token 和 direct 等待会对不上。

## 决定
`listTools` 成功后探测 `listResources` / `listResourceTemplates`。有至少一项资源或模板则快照 `hasResources` 为 true。探测失败只当没有资源，服务器仍保持 connected。有资源的服务器里只要有一台不是 `hidden`，就注册 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`，exposure 取 direct、codemode、deferred 里最宽的一档；全是 hidden 不注册。`execute` 按工具名调用对应的 SDK 方法，结果交给 `shapeMcpResult`。

`session_start` 读取 `pi.getMcpServers()`，并订阅 `mcp_servers_change`。这些配置 `source` 为 `extension`，和文件合并结果放进同一个管理器。同名时保留文件那条，并记下「扩展登记的服务器被配置文件盖住」。只差 `-` / `_` 的名字用 `serverNamesConflict` 拒绝，不进入连接列表。扩展服务器从名单消失时断开连接，快照订阅会再次 `project()`。

## 放弃的方案
- 按服务器把资源登记成 `mcp__<server>__...`：模型和现有调用约定认的是这三个固定名字。
- 资源列举失败就把整台服务器标 failed：工具列表已经成功，模板或资源接口缺失不应该拆掉工具。
- 扩展登记覆盖同名的 mcp.json：文件是操作者显式写的配置，扩展插进来会改掉它。
- 把 `dev-radius` 和 `dev_radius` 当成两台服务器：sanitize 之后工具名会撞车。

## 后果
三个资源工具共用一个 exposure，不能按服务器各设一档。注入的 `readServers` 不会自动带上扩展登记，测试要走 `applyExtensionServers`。文件配置变化时仍会保留尚未被盖住、也没有名字冲突的扩展服务器。
