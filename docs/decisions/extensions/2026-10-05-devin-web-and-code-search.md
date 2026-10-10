---
title: Devin 网页搜索并进 web_search，代码搜索单独成 devin_code_search
status: active
date: 2026-10-05
scope: extensions
files:
  - extensions/devin-client
  - extensions/web-search/index.ts
  - extensions/web-search/devin.ts
  - electron-agent/electron/app/devinAccount.ts
  - electron-agent/src/features/settings/DevinAccountCard.tsx
supersedes:
superseded_by:
---

## 背景

网页搜索默认抓 Bing、搜狗、百度。下载的 devin-search 客户端用一次 Devin 浏览器登录换 Windsurf / Codeium 的网页搜索，另外还有一套会把命中片段发到云端的代码搜索。本地精确检索已经是 `search`，符号检索已经占用工具名 `code_search`。

## 决定

把客户端（不含 CLI）收进 `extensions/devin-client`，运行时只多一个 `ignore@7.0.5`。登录在主进程做本机回调，session 文件与扩展进程共用；扩展只读 session，不在模型调用里发起 OAuth。没有 refresh。

`web_search` 增加引擎 `devin`。没写引擎链、也没配 Tavily / Brave、会话有效时，链是 Devin 然后 Bing、搜狗、百度。`WEB_SEARCH_PROVIDER=devin` 同样先试 Devin 再回退 Bing 链。显式引擎链照用户填写的来。Devin 这一跳失败会被链吞掉。

云端代码搜索注册为 `devin_code_search`，不并进 `search`。路径必须留在工作区内。查询和选中片段会发往 Windsurf。

## 放弃的方案

- 调 Downloads 里的 CLI：应用不能依赖那份目录，登录和搜索也不该再套一层进程。
- 把未发布的包当 npm 依赖：协议客户端要跟仓库一起改，收进 `extensions/devin-client` 更直接。
- 用 Devin 换掉抓取引擎：没登录或协议变更时网页搜索会整个不可用。
- 并进本地 `search`：契约不同，而且会把代码发出去。
- 工具名用 `code_search`：CodeGraph 已经注册了这个名字。

## 后果

Devin / Windsurf 的非公开协议可能变更，账号额度和过期以对方为准。opaque token 大约 24 小时，JWT 按 `exp` 提前 60 秒失效，都要在设置里重新登录。`devin_code_search` 同一进程同时只能跑一次，并且不要对含密钥的工作区使用。
