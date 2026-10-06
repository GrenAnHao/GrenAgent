---
title: 记忆任务超时对齐上游（180s / 300s），抽取与去重输出上限 4096，不传 reasoning
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/agent/modelRuntimeHost.ts
  - electron-agent/electron/pi/systemWorkerManager.ts
  - electron-agent/electron/agent/shortCall.ts
  - electron-agent/electron/app/appServer/serviceTaskRegistry.ts
supersedes:
superseded_by:
---

## 背景
记忆任务统一 60 秒超时，历史上有 36 个任务因此失败（72 次 attempt）。上游 L1 抽取、去重、L3 是 180 秒，L2 是 300 秒；L1 输出上限 4096 token。我们的系统 worker 只传 systemPrompt / user / signal。

## 决定
KIND_TIMEOUT_MS 和 ServiceTaskRegistry 两处超时都对齐上游。memory_extract、memory_deduplicate 传 maxTokens 4096；memory_scene、memory_persona 不设上限，因为它们要输出整篇 Markdown。ModelRuntimeHost.completeSimple 只在给了 maxTokens 时才透传。

## 放弃的方案
- 传 reasoning: 'minimal' 压低思考：pi-ai 不传 reasoning 就等于关闭思考（openai-completions.js 里 enable_thinking = !!reasoningEffort），传 'minimal' 反而会打开。
- 显式传 temperature：上游 Chat Memory 管线也不传；先看宽松解析之后的失败率再决定。
- 给 L2 也设 4096：场景文件常有几千字，截断会写坏场景。

## 后果
ShortCallQueue 是串行的，一个卡住的 L2 最多会让后面的 goal_judge、wiki 等 300 秒。如果出现明显排队，再把记忆任务和其他系统任务拆成两条队列。
