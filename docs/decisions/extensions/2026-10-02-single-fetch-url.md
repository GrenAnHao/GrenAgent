---
title: 网页抓收取成一个 fetch_url
status: active
date: 2026-10-02
scope: extensions
files:
  - extensions/web-fetch/index.ts
  - extensions/web-search/index.ts
  - extensions/_shared/tool-groups.ts
  - extensions/agent-mode/modes.ts
supersedes:
superseded_by:
---

## 背景
网页抓取拆成 13 个工具：格式各一个（`fetch_html` / `fetch_markdown` / `fetch_txt` / `fetch_json` / `fetch_url` / `fetch_llms`），再加上 `fetch_web_content` 和 CSDN、掘金、Linux.do、GitHub README 的站点抓取。模型面对的是同一件事的多扇门。`fetch_url` 的 schema 里已经有 `format`，执行时却忽略它。

## 决定
只注册 `fetch_url`。`format` 为 `markdown`（默认）时走多提供商爬虫；`text` / `html` / `json` 走直接 HTTP；`llms` 探测该 URL origin 的 `/llms.txt`，`full=true` 时优先 `llms-full.txt`。站点专用抓取、`fetch_web_content` 和其余 `fetch_*` 工具名删除，不留别名。搜索引擎里的 CSDN、掘金来源保留。

## 放弃的方案
- 保留站点抓取：这三个站点和 GitHub README 都能用通用 `fetch_url` 读页面，仓库 API 仍走 `github`。
- 每种格式继续各留一个工具：调用面不缩小，`format` 参数就是为了替代这些名字。
- 默认改成直接 HTTP：JS 渲染和反爬页面会退回，爬虫（naive、Jina，以及配了 key 的 Firecrawl / Exa / Search1API）仍是普通页面的默认路径。

## 后果
旧会话里的 `fetch_csdn_article` 等工具名不再可调用；界面卡片映射保留，历史记录仍能渲染。Ask / Plan 白名单和 `NET_TOOLS` 只认 `fetch_url`。文档站要先读索引时，模型需传 `format=llms`，不再有单独的 `fetch_llms`。
