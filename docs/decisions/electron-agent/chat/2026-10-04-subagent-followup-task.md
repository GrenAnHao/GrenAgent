---
title: 子代理跟进调用沿用启动时的任务文本
status: superseded
date: 2026-10-04
scope: electron-agent/chat
files:
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/features/chat/messagePrecompute.ts
  - electron-agent/src/features/dock/SubAgentBody.tsx
  - extensions/multi-agent/index.ts
supersedes:
superseded_by: electron-agent/chat/2026-10-04-fold-spawn-followup-card.md
---

> 已过时 → 见 ./2026-10-04-fold-spawn-followup-card.md

## 背景

后台 `spawn` 的参数里有任务原文，横条能抽出标题。随后的 `wait` / `status` / `cancel` 只有 `agentId`，同一套标题逻辑无任务可取，就落成「子代理任务」。任务其实在启动那次调用里，也在跟进结果的 `Task:` 行里。

## 决定

跟进卡片按 `agentId` 找回先前启动的任务全文。对不上时用结果里的 `details.task`，再不行才读状态头的 `Task:` 行。`wait` / `status` / `cancel` / `remove` 的工具详情带上登记任务，新会话不必靠拆正文。

## 放弃的方案

- 只解析结果正文：等待还没返回时标题仍是空的，多行任务也只剩第一行。
- 要求模型在 `wait` 里再写一遍任务：工具本来就只认 `agentId`，多写一份还会和登记任务分叉。

## 后果

启动记录不在当前消息里、结果也还没到时，跟进卡片仍暂时显示「子代理任务」。并行启动靠每条 `results[].agentId` 分别对应，不把整组收成一个标题。
