---
title: 并行子代理先显示启动中，并带上已选模型
status: active
date: 2026-10-03
scope: electron-agent/chat
files:
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/features/chat/SubAgentGroupInline.tsx
  - extensions/multi-agent/index.ts
supersedes:
superseded_by:
---

## 背景

任务引号一闭合，并行行就出现了。这时子进程往往还没写出会话，界面却已经写「运行中」，模型芯片是空的，要等进程跑起来才填上。

## 决定

没有 `sessionPath` 时状态是启动中，会话文件出现后才是运行中。模型在选定的那一刻就放上行：任务对象里的模型、工具结果里的模型，以及注册表里 `launch` 时写入的模型，三者谁先到用谁。

## 放弃的方案

- 行一出现就标运行中：进程还没起来，和后面的真运行分不开。
- 等运行中再显示模型：启动阶段芯片会空一块。

## 后果

注册表列表多返回 `sessionPath`，用来区分启动中和运行中。旧库没有这一列时当作还没启动。
