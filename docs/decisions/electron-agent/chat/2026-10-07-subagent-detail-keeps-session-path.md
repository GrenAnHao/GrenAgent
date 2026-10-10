---
title: 子代理详情记住登记表里的子会话路径，终态挂载缺路径时只补查一次
status: active
date: 2026-10-07
scope: electron-agent
files:
  - electron-agent/src/features/dock/SubAgentBody.tsx
  - electron-agent/src/features/panels/SubAgentConversation.tsx
  - electron-agent/ui-harness/scenarios/subagent-conversation.tsx
  - electron-agent/ui-harness/probes/subagent-conversation.mjs
supersedes:
superseded_by:
---

## 背景

真实的后台 spawn 回执在子会话建立前就返回，`details` 里没有 `sessionPath`，详情只能从共享登记表轮询（`subagentLiveStore`）现读路径。最后一个消费者释放轮询时，store 会把整个项目的行删掉。子代理一完成，详情的状态变成 done，轮询停止，路径随之变回 null：详情从完整子会话退回 registry transcript 回放，`resetKey` 改变，列表整个重新挂载，完成时那次补读也丢了。切走标签再切回、或者从任务托盘打开已完成的子代理时，挂载时已经是终态，不会起轮询，路径根本拿不到。现有场景没测出来，是因为测试数据的回执里预带了路径。

## 决定

两层各记一份，用途不同：

- `SubAgentBody` 常驻挂载（标签隐藏时只返回 null），在已有的 `seenRegistry` 里按 agentId 一并记下登记表行的路径，通过新的 `sessionPath` prop 交给详情。标签来回切换不需要任何 IPC，也不会先闪一下回放。
- `SubAgentConversation` 优先用回执和 prop 里的路径；都没有时，按 agentId 记住在共享轮询里见过的路径。挂载时已经是终态、又没有路径，就借共享轮询拿一次首包（和 `SubAgentInline` 补历史字段的做法一样），首包到了就释放，不常驻轮询。这一条覆盖 `SubAgentLogBody` 这种不经过 Body 的入口。

场景新增两种模式：「结果不带会话路径」（真实 `SubAgentBody`，完成后多等一个轮询周期，正文和思考仍在）和「终态挂载缺路径」（补查后显示完整子会话，之后 `subagent_list` 不再增加）。修复前这 6 条断言里有 5 条失败。

## 放弃的方案

- 只在详情组件里记住路径：详情在标签隐藏时会卸载，切回来又丢；从托盘打开已完成的子代理仍然拿不到路径。
- 让 store 停止轮询时保留行：改动最小，但改的是全局共享 store 的语义，所有订阅者都会读到可能过期的状态（运行态、模型），影响面最大。
- 新增按 agentId 查单行的 IPC：一次补查就够，共享轮询的首包已经满足，不值得多一个主进程入口。
- 只在 Body 层记：`SubAgentLogBody` 入口仍然拿不到路径。

## 后果

`subagent_list` 只返回最近 50 行，超出范围的旧子代理补查不到路径，仍然走 registry transcript 回放，和改动前一样。补查只发生在「终态、没有路径、这个 agentId 还没查过」时，同一个详情不会重复查询。
