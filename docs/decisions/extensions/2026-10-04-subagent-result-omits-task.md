---
title: 子代理结果正文不再回贴任务全文
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/multi-agent/index.ts
supersedes:
superseded_by:
---

## 背景

`wait` / `status`、并行汇总，以及 `list` 把登记任务整段写进交给父代理的工具正文。主代理用 codemode 调 `spawn_agent({ action: "list" })` 时，读到的就是这段正文。任务往往就是长提示词，于是找回审查结论时拿到的是提示词本身。

## 决定

结果正文只保留状态行和子代理自己的输出。`list` 每条同样只带状态和 `output` / `error`。任务全文仍放在 `details.task`、`details.results[].task` 和 `details.agents[].task`。界面继续优先读详情；旧会话里已经写进正文的 `Task:` 行仍按原解析兜底。

## 放弃的方案

- 只在界面上裁掉 `Task:` 行，工具正文维持原样：父代理读到的仍是任务全文，上下文和后续判断都还是错的。
- 改成只回贴任务第一句：第一句本身就是任务内容，长提示词的首行往往就是整句指令，问题还在。

## 后果

父代理不能再从工具正文里把任务抄回来，要对上是哪一次派发，看自己的调用参数或 `details.task`。旧结果格式不变，不需要迁移。
