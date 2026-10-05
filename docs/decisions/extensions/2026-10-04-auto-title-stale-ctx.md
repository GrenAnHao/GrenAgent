---
title: 自动标题在会话替换后写回原会话，不再使用失效的扩展 ctx
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/auto-title/index.ts
  - extensions/auto-title/notify.ts
  - electron-agent/electron/main.ts
supersedes:
superseded_by:
---

## 背景

auto-title 在 `agent_end` 后后台生成标题，完成时调用捕获的 `pi.setSessionName`。官方在 `newSession` / `switchSession` / `fork` / `reload` 时先 `session_shutdown`，再作废旧扩展运行时。标题请求还在飞时用户换了会话，写回就会抛 `This extension ctx is stale`，标题也没落到开头那个会话上。

## 决定

标题任务按会话文件记在 `globalThis` 上，不把旧 `pi` 留到替换之后。

- 会话还是当前这个：照旧 `pi.setSessionName`，侧栏靠原来的 `session_info_changed` 刷新。
- `reload`：旧 pi 作废，但会话文件不变。新扩展实例的 `session_start` 用自己的 `pi.setSessionName` 写标题。
- 新开、切换、fork、退出：用替换前抓住的 `SessionManager.appendSessionInfo` 写回原文件。主进程收到通知后广播一次 `session_info_changed`（`workspace` 为空，不进当前画面的事件归约），侧栏重读列表。

模型调用本身撞上 stale ctx、或已经有名字时，静默跳过，不打 `[auto-title] error`。

## 放弃的方案

- 只 catch 掉 stale 并忽略：错误日志没了，标题也丢了，要等下一次 `agent_end` 才会再试。
- 替换之后仍调用旧 `pi.setSessionName`：这就是这次抛错的路径。
- 自己拼一行 `session_info` 追加到 jsonl：绕过 SessionManager 的 id、parent 和未落盘缓冲，可能把 leaf 写坏，或和尚未 flush 的正文打架。
- reload 也直接 `appendSessionInfo`：内存里的会话管理器不会发出 `session_info_changed`，当前画面的侧栏不更新。

## 后果

扩展模块即使被重新求值，进行中的标题任务仍在 `globalThis` 上，新实例才能接上。宿主必须订阅 `subscribeSessionTitleWritten`，否则换走之后的标题只在文件里，侧栏要等到下一次列表刷新才看得到。同一会话文件上同时只保留一个进行中的标题任务。
