---
title: 会话标题直接返回文本，并用 maxTokens 限制输出
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/auto-title/index.ts
  - extensions/auto-title/title.ts
  - extensions/_shared/summarize.ts
supersedes: 2026-10-04-auto-title-lobe-prompt.md
superseded_by:
---

## 背景

标题只要一行名字。让模型交 JSON、再从字段里取出 title，多一次解析，也多占输出 token。提示词已经要求短标题，输出长度应该由补全请求自己卡住。

## 决定

系统提示仍用 LobeHub `chainSummaryTitle` 的结构，只把「返回 JSON」改成「只回标题」。用户消息只包最初那条用户指令。请求不带工具，`reasoning` 关闭，`maxTokens` 设为 64。模型原文的第一行就是会话名。

## 放弃的方案

- 继续要求 `{"title":"..."}` 再解析：输出更长，解析失败时这一轮标题直接丢掉。
- 用拒绝句规则或文件名拼标题：标题不再是模型概括。
- 把整段对话和工具列表发给标题模型：模型会去处理路径，而不是起名。

## 后果

模型若仍写出解释，第一行会被截进会话名，但请求在 64 token 处停止，不会按默认输出上限计费。图像、语音标题走原来的短摘要提示，只有 auto-title 传这个 maxTokens。
