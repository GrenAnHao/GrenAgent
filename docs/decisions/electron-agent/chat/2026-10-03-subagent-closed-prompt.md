---
title: 子代理提示词等闭合后再上屏，收起 350px
status: superseded
date: 2026-10-03
scope: electron-agent/chat
files:
  - electron-agent/src/stores/agentReducer.ts
  - electron-agent/src/features/chat/TaskPromptFrame.tsx
  - electron-agent/src/features/chat/SubAgentGroupInline.tsx
  - electron-agent/src/features/panels/SubAgentConversation.tsx
supersedes:
superseded_by: electron-agent/chat/2026-10-03-subagent-prompt-expand.md
---

> 已过时 → 见 [2026-10-03-subagent-prompt-expand.md](./2026-10-03-subagent-prompt-expand.md)

## 背景

`toolcall_delta` 的流式 JSON 解析会把还没闭合的任务字符串补成完整值，写进卡片的 `args`。并行组标题和右坞任务提示词都读这个值，于是句子逐字变长。完整提示词以前用 240px 滚动盒，并行行上的模型是一段没有边框的省略文字。

## 决定

参数未完成时，`spawn_agent` 只把原始参数里已经闭合的 `tasks` / `task` 写进卡片。一条闭合就出现一行，并沿用已有的早启动。完整提示词收起固定 350px，底部 `ScrollShadow`，悬停底部箭头展开到 550px 并打开滚动条。并行行模型用和单卡相同的芯片（等宽 11px、描边、浅底），文案仍走 `displayModel`。

## 放弃的方案

- 继续把解析器自动补全的半句画出来：进程要等引号闭合才启动，画面会先于进程逐字长。
- 收起态用 max-height 加常驻滚动条：和「先看一截、悬停再展开」不是同一种操作。
- 并行行单独截断原始模型 id：和单卡运行时的名称、样式对不齐。

## 后果

引号闭合前组里没有这一行，组头可以先出现、下面是空的。右坞和单卡展开后的提示词至少占 350px。
