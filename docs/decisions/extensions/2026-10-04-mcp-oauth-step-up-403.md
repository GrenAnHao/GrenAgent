---
title: MCP OAuth 在 403 insufficient_scope 时合并已授予的 scope
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/transport.ts
supersedes:
superseded_by:
---

## 背景

`createOAuthFetch` 原先只在 401 上改写 `WWW-Authenticate` 的 `scope`。安装的 `@modelcontextprotocol/sdk` 在 403 且 `error=insufficient_scope` 时也会从同一头读取 scope 再登录，原文会丢掉已经授予的 scope。

## 决定

401 和 403 都走 `rewriteInsufficientScope`，用 `mergeStepUpScope` 把已授予的 scope 和头里要求的 scope 并起来。SDK 只读这个头，不改 body、iss 核对和凭据键。

## 放弃的方案

- 继续只改 401：403 提升范围时登录只会带服务器新要的 scope。
- 同时改写 JSON body：SDK 的 `extractWWWAuthenticateParams` 不读 body。
- 在 `auth()` 外包一层再合并 scope：要改 SDK 调用点，而 fetch 包装已经挡在 SDK 读头之前。

## 后果

没有 `insufficient_scope` 的 403 头保持原样。若将来 SDK 改从 body 读提升范围，这里要跟着扩。
