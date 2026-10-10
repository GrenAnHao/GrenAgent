---
title: bash 真正执行结束后自动收起，手动查看历史结果保持展开
status: active
date: 2026-10-06
scope: electron-agent
files:
  - electron-agent/src/features/tools/ToolExecution.tsx
  - electron-agent/src/features/tools/ToolExecution.test.tsx
  - electron-agent/src/features/tools/BashJobTerminal.test.tsx
  - electron-agent/ui-harness/scenarios/bash-job-card.tsx
  - electron-agent/ui-harness/probes/bash-job-card.mjs
supersedes: electron-agent/tools/2026-10-05-bash-jobs-follow-session-and-foreground-pipe.md
superseded_by:
---

## 背景

bash 卡片只在首次挂载时按运行状态初始化展开，完成后没有收起动作，多条命令结束后仍占着对话空间。后台 bash 的工具调用先返回 `done`，任务可能还在运行，不能直接把调用完成当作命令完成。

## 决定

替换旧笔记中的「命令结束后展开状态保持」这一条，其余会话承载和匿名 job 管道决定继续有效。bash / shell / run_terminal_cmd 在本卡片观察到运行状态后，转为终态时收起；前台看工具状态，后台看现有 `jobLiveStore` 的任务状态，正在停止仍算运行。

后台快照尚未返回、或任务记录已经不在时视为未知，不触发完成收起。前台转后台等待快照期间保持当前展开状态。已完成历史卡片首次收到终态快照，以及完成后用户再次展开并收到结果更新，都保持用户选择。

## 放弃的方案

- 每次 `status !== running` 都收起：后台调用回包时任务仍在跑，也会关掉用户正在查看的历史结果。
- 用折叠行的回退状态当作后台终态：快照在路上时行暂时显示工具调用的 `done`，会在前台转后台时误收起。
- 把结束状态写回 reducer：任务已有独立 store，且工具调用状态必须和 pi 一致；展示层监听状态边沿即可。

## 后果

成功、失败和被停止的命令结束后都收起，仍可手动展开查看最终输出。收起只发生在观察到运行后的结束边沿，不额外请求快照、不改变消息数据或任务生命周期。
