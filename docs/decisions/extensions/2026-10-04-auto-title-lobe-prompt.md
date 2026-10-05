---
title: 会话标题沿用 LobeHub chainSummaryTitle，请求里不带工具
status: superseded
superseded_by: 2026-10-04-auto-title-plain-output.md
date: 2026-10-04
scope: extensions
files:
  - extensions/auto-title/index.ts
  - extensions/auto-title/title.ts
  - extensions/_shared/summarize.ts
supersedes: 2026-10-04-auto-title-reject-refusal.md
---

> 已过时 → 见 [2026-10-04-auto-title-plain-output.md](2026-10-04-auto-title-plain-output.md)


## 背景

标题模型收到本地路径后，会回「当前环境无法直接读取本地路径。请运行：」，这句话被写成会话名。根因是这次调用没有把任务收成「只概括最初那条指令」：模型仍按代理来回答，而不是交一个标题。

## 决定

auto-title 使用 LobeHub `chainSummaryTitle` 的原文。系统提示原样搬过来，locale 用运行环境的语言码。用户消息只包最初那条用户指令，放在 `<user>` 里，不放助手回复和工具结果。补全请求显式 `tools: []`。模型必须返回 `{"title":"..."}`，只把这个字段写入会话名；解析不到就当这次没生成。

## 放弃的方案

- 用拒绝句规则滤掉坏输出，再用文件名和用户原话拼标题：标题不再是模型概括，路径和中文会被硬拼在一起。
- 把整段对话（含工具调用）喂进标题模型：模型会去处理路径和工具，而不是起名。
- 改写提示词，额外写上「不要读文件」：文档里的提示词已经规定只返回 JSON 标题，不在正文外再加纪律。

## 后果

模型不遵守 JSON 时，这一轮不写标题，侧栏保持「新对话」，直到下一次首轮结束再试。输出语言跟着运行环境 locale，不跟着用户原话猜。图像、语音标题仍走原来的短摘要提示，只是同一次补全也不再附带工具。
