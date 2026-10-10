---
title: Cursor 原生供应商从 cursor-credentials.json 取令牌，登录后刷新可用模型
status: superseded
date: 2026-10-06
scope: cli
files:
  - cli/src/cursor/install.ts
  - cli/src/cursor/oauth.ts
  - cli/src/runtime.ts
  - electron-agent/electron/main.ts
  - electron-agent/electron/ipc/register.ts
  - electron-agent/src/features/settings/SettingsPanel.tsx
supersedes:
superseded_by: cli/2026-10-07-remove-cursor-provider.md
---

> 已过时 → 见 [2026-10-07-remove-cursor-provider.md](2026-10-07-remove-cursor-provider.md)

## 背景
设置页「登录 Cursor」把令牌写进 `agentDir/cursor-credentials.json`，原生供应商的 `auth.apiKey.resolve` 却只认 auth.json 里的 `credential.key`。`ModelRuntime.checkAuth("cursor")` 恒为 undefined，`getAvailableSnapshot()` 里一个 Cursor 模型都没有。登录成功之后界面上也看不到 Cursor 模型。登录接口还缺一步：登录完没有重算可用模型快照，也没有让渲染层的模型缓存失效。

## 决定
`createCursorNativeProvider(agentDir)` 的 `apiKey` 认两处来源，auth.json 里手填的 key 优先，没有再用登录文件。`check` 只读文件，可用性刷新不发网络请求。`resolve` 在请求时调用 `storedCursorAccessToken`：令牌有效就直接用，快过期就用 refresh token 换新的并写回，同一文件的并发请求只刷新一次。刷新失败时抛固定文案，让用户重新登录，不在请求路径上打开登录页，也不带出上游错误文本。sidecar 用 `getAgentDir()`，Electron 用主进程的 `agentDir`。`cursor_login` 登录成功后调用 `service.refresh()`，设置页再失效供应商列表和可用模型缓存。

## 放弃的方案
- 改成 pi 原生 `auth.oauth`，凭据以 `type: "oauth"` 存进 auth.json：设置页保存供应商时 `serializeState` 整份重写 auth.json，只保留 `api_key` 项，保存任意供应商都会把 Cursor 登出。要走这条路得先改序列化，并且推翻设计文档里「令牌存在 cursor-credentials.json」的约定。
- 登录时把 access token 当 `api_key` 写进 auth.json：令牌按小时过期，pi 不会刷新 `api_key` 凭据，过期后只能重新登录。auth.json 里的 refresh token 也没有地方存。
- `resolve` 直接复用 `resolveCursorAccessToken`：它在刷新失败时会走交互登录、打开浏览器。请求路径上不该弹登录页，没有登录文件时也应该返回「未配置」，不该报错。

## 后果
供应商要拿到 `agentDir` 才能读登录文件，不传就只认 auth.json。没有传 `agentDir` 的调用只有单测。`check` 判断的是「文件可读且带 refresh token」，不验证令牌在服务端是否仍然有效；令牌被吊销时，模型照样显示为可用，要等到发请求才报错。以后如果改成 pi 原生 OAuth，需要同时改 `serializeState`，让它保留非 `api_key` 的凭据。
