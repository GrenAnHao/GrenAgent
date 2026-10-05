---
title: 重启打断的后台子代理不要显示已完成
status: active
date: 2026-10-04
scope: electron-agent/chat
files:
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/features/chat/SubAgentInline.tsx
supersedes:
superseded_by:
---

## 背景

可续聊子代理在软件退出时进程没了。注册表把它收成 `done`，只为了不通知父模型、会话还能续。聊天卡片把这个 `done` 画成绿色的「已完成」，展开却只有「Background sub-agent started」。

## 决定

注册表状态保持 `done` + `sidecar restarted`。卡片单独认这个错误：显示「已中断」。列表里已经没有这一行时同样不算成功。只有启动回执、详情里没有终态时，仍按后台任务去对注册表。

## 放弃的方案

- 重启后改成 `cancelled` 或 `error`：父模型会把它当成失败，可续聊会话的收尾约定也被改掉。
- 重开后继续显示运行中：进程已经退出，转圈是假的。

## 后果

父模型看到的注册表状态仍是 `done`。只有界面把「软件退出时还在跑」和「任务做完」分开。
