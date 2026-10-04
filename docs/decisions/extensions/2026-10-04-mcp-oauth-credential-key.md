---
title: MCP OAuth 凭据按服务器名和 URL 分键，登录交给 SDK 的 auth
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/mcp/oauthRules.ts
  - extensions/mcp/transport.ts
  - extensions/mcp/manager.ts
supersedes:
superseded_by:
---

## 背景

HTTP / SSE 的 MCP 服务器要走 OAuth。令牌必须按「服务器名 + URL」分开存，交换 code 之前要核对授权响应里的 `iss`，空的 `scope` 不能把登录打成失败。SDK 已经带了发现、PKCE、动态注册和 token 交换。

## 决定

纯规则放在 `oauthRules.ts`。连接时实现 SDK 的 `OAuthClientProvider`，由导出的 `auth` 完成登录。凭据写在 `~/.pi/agent/mcp-auth.json`，键是服务器名和 URL 的 JSON 数组。

交换 code 之前调用 `authorizationIssMatches`。不匹配则服务器状态为 `failed`，错误文本为 `授权服务器 iss 不匹配`，不把 authorization code 交给 `auth`。动态注册的客户端名缺省是 `GrenAgent`。

快照增加 `loginUrl`。系统浏览器打不开时把这个地址留在状态上，服务器不标成 `connected`。

## 放弃的方案

- 自己再写一套发现、PKCE、动态注册和 token HTTP：SDK 的 `auth` 已经串好这些步骤，平行实现会对不齐，也绕开它的 scope 选择。
- 凭据只按 URL 做键：同一 URL 的两台服务器会共用 token。规格要求各存各的。
- 浏览器打不开时仍标 `connected`，或丢掉登录地址：此时没有 access token，面板也没法把地址复制出去。
- 在扩展进程里调用 Electron `shell.openExternal`：MCP 管理器跑在 Pi worker，不是 Electron 主进程。打不开时改由操作系统打开 URL，失败则把地址留在状态上。

## 后果

`auth.provider` 和扩展面板这次都没做。面板要显示登录，读管理器状态上的 `loginUrl`。`iss` 为空时规则放行，这是为了兼容不回 `iss` 的授权服务器；两边都有且不同则拒绝。未配置回调端口时，实际端口会记在同一条凭据里，避免下次登录换掉 redirect URI。
