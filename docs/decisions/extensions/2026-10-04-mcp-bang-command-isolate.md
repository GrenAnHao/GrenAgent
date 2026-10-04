---
title: 单台 MCP 的 !command 失败时跳过该服务器，不中断整表展开
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/config.ts
supersedes:
superseded_by:
---

## 背景
`expandConfigValues` 对整段 `!command` 调用 `execSync` 且不接失败。`expandServerVars` 用 `map` 展开整表，一台服务器的非零退出或缺失可执行文件会抛出 `defaultReadServers`，其余服务器不再连接。规格要求单台配置错误不得阻止其他服务器。

## 决定
在 `expandServerVars` 里按服务器 `try/catch`。展开失败的服务器不进入将要连接的列表；其余服务器继续展开。错误用 `console.error` 写出，内容含服务器名和失败信息。函数仍返回 `McpServerConfig[]`。

## 放弃的方案
- 把返回值改成 `{ servers, errors }`：生产调用方只有 `defaultReadServers`，但它把返回值直接当数组交给连接循环，改签名还要动管理器；管理器目前也没有配置错误槽位。
- 在 `expandConfigValues` 里吞掉 `execSync` 错误并保留原始 `!command`：会带着无效 header/env 去连。
- 把失败服务器放进管理器 catalog 标 `failed`：本步只保证展开列表不被一笔错误打断，连接状态留给已有的 connect 失败路径。

## 后果
展开失败的服务器不会出现在面板里，只能在控制台看到原因。若以后管理器收配置错误，应把这段日志改成写入同一槽位。
