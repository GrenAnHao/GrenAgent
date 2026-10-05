---
title: 子代理的等待调用并回启动那张卡片
status: active
date: 2026-10-04
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/messagePrecompute.ts
  - electron-agent/src/features/chat/ChatMessageItems.tsx
  - electron-agent/src/features/panels/subagentUtils.ts
supersedes: electron-agent/chat/2026-10-04-subagent-followup-task.md
superseded_by:
---

## 背景

后台启动返回后，模型按提示再调一次 `spawn_agent({ action: "wait", agentId })`。两次调用都会画成子代理横条。任务名对齐之后，两张卡片标题、指令、运行状态都一样。

## 决定

跟进调用指向的是已经出现过的单个子代理时，不再占新序号、不再另开一行。等待还在跑时，只留启动那张卡（它本来就按注册表显示运行中）。等待结束后，把跟进正文贴回这张卡，并保留原来的 `sessionPath`。

## 放弃的方案

- 继续两张卡，只把第二张标题改成「等待中」：同一段任务仍占两行，停止键也分属两张卡。
- 删掉启动卡、只留等待卡：启动卡上有子会话路径，右坞要靠它绑定实时对话。

## 后果

并行组里的某一个子代理若再被单独 wait，仍会多一张卡。这种调用没有一张独占的启动卡可以贴结果。启动记录不在当前消息里时，跟进调用仍单独成卡。
