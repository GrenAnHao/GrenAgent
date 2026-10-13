> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-18-memory-pipeline-upstream-aligned.md](../../../../.agents/notes/implemented/architecture/2026-09-18-memory-pipeline-upstream-aligned.md) 维护；本文件冻结只读。

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
超时值以 `electron/agent/shortCall.ts` 的 `KIND_TIMEOUT_MS` 为唯一来源：`ServiceTaskRegistry` 从它导入，`BUILTIN_SERVICE_TASKS` 里 memory_extract / memory_deduplicate / memory_scene / memory_persona / goal_judge / wiki_page_generate 的 `timeoutMs` 直接引用 `KIND_TIMEOUT_MS[kind]`，不再手抄第二份。memory_extract、memory_deduplicate 传 maxTokens 4096；memory_scene、memory_persona 不设上限，因为它们要输出整篇 Markdown。ModelRuntimeHost.completeSimple 只在给了 maxTokens 时才透传。

## 放弃的方案
- 传 reasoning: 'minimal' 压低思考：pi-ai 不传 reasoning 就等于关闭思考（openai-completions.js 里 enable_thinking = !!reasoningEffort），传 'minimal' 反而会打开。
- 显式传 temperature：上游 Chat Memory 管线也不传；先看宽松解析之后的失败率再决定。
- 给 L2 也设 4096：场景文件常有几千字，截断会写坏场景。

## 后果
排队阻塞有两层：先是 TaskQueue 对系统任务一次只启动一个（`startedSystem`，见 taskQueue.ts 的 `startAvailable`），其次 SystemWorkerManager 的 ShortCallQueue 也是串行，所以一个卡住的 L2 最多会让后面的 goal_judge、wiki 等 300 秒。如果出现明显排队，再把记忆任务和其他系统任务拆成两条队列。

两层超时同刻到期时外层 TaskQueue 的 withTimeout 先触发（它注册定时器早于内层），失败任务的 error 是 `service task timed out after Nms` 而不是 `aborted`；内层被 abort 的 complete 已在飞、ShortCallQueue 仍被占着，直到内层自身超时才释放。这正是超时值必须单一来源的原因：registry 侧一旦被改小，外层会先放行下一个系统任务，而内层还卡着。
