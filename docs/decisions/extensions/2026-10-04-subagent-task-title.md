---
title: 子代理任务名由主代理在 spawn_agent 参数里提交
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/multi-agent/index.ts
  - extensions/multi-agent/tasks.ts
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/stores/agentReducer.ts
supersedes:
superseded_by:
---

## 背景

auto-title 只给主会话起名。子进程子代理会跳过它；嵌入式子会话即便写了会话名，侧栏也把这些会话藏起来。卡片上看到的名字是从任务原文截出来的一句，不是单独的任务名。

## 决定

`spawn_agent` 增加可选 `title`。单任务写在顶层，并行项和链式步骤各自写在对象上。主代理派发时自己摘要成一句（不超过 24 字），和任务正文一起提交。界面优先显示这个参数；没有时仍从任务原文截一句。标题不进入子代理正文。

## 放弃的方案

- 派发时再用 auto-title 那套摘要模型生成任务名：多一次模型调用，而且标题不是和任务一起提交的。
- 继续只截任务原文：角色句和长提示词截出来的名字不稳定，主代理明明知道这次要做什么。

## 后果

模型可能漏写 `title`。漏写时卡片退回截句，工具调用不失败。菜单只在当前会话的 `spawn_agent` 参数里找得到标题；跨会话条目仍显示 registry 里的任务原文。
