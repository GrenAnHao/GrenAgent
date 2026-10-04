---
title: auth.provider 用进程内 ModelRuntime 的当前登录态做 MCP Bearer
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/oauthRules.ts
  - extensions/mcp/merge.ts
  - extensions/mcp/manager.ts
  - extensions/mcp/index.ts
  - extensions/mcp/transport.ts
supersedes:
superseded_by:
---

## 背景

远程 MCP 可以用 `auth.provider` 借用某个模型供应商的登录态，请求头是 `Authorization: Bearer`。项目里的 `.pi/mcp.json` 不可信，不能自己指定供应商。登录态在进程内那一份 `ModelRuntime` 上，经 `getAuth(provider).auth.apiKey` 现读（与 `ModelRegistry.getApiKeyForProvider` 相同）。每个会话会 `new ModelRegistry(同一份 ModelRuntime)`，注册表对象每次都是新的。

## 决定

合并时给每台服务器标 `source`。`authProviderError` 非空的服务器写入 `errors`，不进入连接列表。`project` 一律拒绝。`global`、`desktop`、`extension` 只接受 https，或主机为 `localhost`、`127.0.0.1`、`[::1]` 的 http。

管理器只保存 `getProviderToken` 函数。`bind()` 在 `init()` 之前，从 `ctx.modelRegistry.runtime` 装上这个函数。后来的 `session_start` 若仍是同一运行时对象，不替换回调。传输层每次 HTTP 请求调用它；没有 token 时该服务器为 `failed`，错误文本 `没有供应商登录态`，请求不发出。

## 放弃的方案

- 把 `ModelRuntime` 或会话 ctx 留在管理器上：管理器约定不持有 pi 会话对象，token 过期或刷新也要靠调用时现读。
- 每次 `session_start` 都换成新 `ModelRegistry` 上的 `getApiKeyForProvider`：注册表是按会话新建的，换回调会把进程内那一份运行时指丢；同一运行时再装一次没有新信息。
- 连接时把 token 缓存进 headers：供应商重新登录后，已经连上的服务器仍会带着旧 Bearer。
- 直接读 `auth.json`：OAuth 刷新和运行时临时 key 都在 `ModelRuntime.getAuth` 里，绕开它会拿到过期或空的值。

## 后果

扩展登记要能使用 `auth.provider`，合并时来源必须是 `extension`。项目文件即使写了合法 https，这台服务器也不会连接。stdio 上的 `auth.provider` 不走 Bearer；远程服务器在回调尚未装上时会失败，所以 `bind()` 必须先装回调再 `init()`。
