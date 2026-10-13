> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-13-subagent-activation-and-routing.md](../../../.agents/notes/implemented/architecture/2026-09-13-subagent-activation-and-routing.md) 维护；本文件冻结只读。

---
title: 单会话子代理上限只计仍占用的名额
status: active
date: 2026-10-03
scope: extensions
files:
  - extensions/multi-agent/index.ts
  - extensions/multi-agent/parallel-early.ts
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/stores/agentReducer.ts
supersedes:
superseded_by:
---

## 背景

单会话子代理上限按累计启动次数计算，一次性任务结束后名额不还。并行任务要等整段 `tasks` 写完才开工，完成态也要等整批工具返回。右坞加载运行中的子会话时，迟到的 `message_end` 会在工具后面再追加一份已经结束的思考和正文。

## 决定

名额在启动前预占，一次性任务结束或可继续会话收尾后释放。`tasks` 里已经闭合的任务在参数流还没写完时就启动，每个结束单独更新该行。横条用短任务名，模型写进工具结果，完成后仍显示。对得上最后一条已结束助手的 `message_end` 原地更新，不追加。

## 放弃的方案

- 继续按累计次数封顶：做完的审查子代理会把后面的并行批次挡住。
- 等 `execute` 收到完整参数再一起启动：界面上要等所有任务文本都吐完才开始，结束也挤在同一次工具返回里。
- 用流式 JSON 解析器判断任务是否写完：它会自动补上未闭合的引号，半句任务会被提前开工。

## 后果

上限看的是当前占用，不是本会话一共启动过多少。可继续的子代理在还能被接着发消息时占着名额。参数流里 `profile` 还没写完时，并行任务会等这个字段闭合再启动。
