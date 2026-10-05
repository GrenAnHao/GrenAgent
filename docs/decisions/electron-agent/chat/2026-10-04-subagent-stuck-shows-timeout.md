---
title: 子代理卡死时卡片显示超时
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/features/chat/SubAgentInline.tsx
  - electron-agent/src/features/chat/messagePrecompute.ts
  - electron-agent/src/features/panels/subagentUtils.ts
  - extensions/multi-agent/index.ts
supersedes:
superseded_by:
---

## 背景

卡死回收把子代理收成 `error`，原因是 `stuck: no activity for >300s`。`wait` / `status` 把这件事写进结果正文后正常返回，工具调用本身是成功的。卡片只看工具状态，就把这次卡死画成已完成。

## 决定

跟进结果盖回启动卡片时，子代理状态是 `error` 或 `cancelled` 就按失败画。结果或注册表错误里出现卡死、空闲超时、启动超时、硬超时，文案用「超时」。

## 放弃的方案

- 让 `wait` 在子代理失败时把工具调用标成 `isError`：调用本身已经取回了状态，失败的是子代理。旧会话里的结果也没有这个标记，卡片还是会显示已完成。
- 凡是 `error` 都写成「超时」：取消、普通失败和卡死不是同一件事。

## 后果

没有这些超时字样、详情里也没有 `status: error` 的旧结果，仍按原来的工具状态显示。
