> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-18-memory-pipeline-upstream-aligned.md](../../../../.agents/notes/implemented/architecture/2026-09-18-memory-pipeline-upstream-aligned.md) 维护；本文件冻结只读。

---
title: 系统任务记录模型用量，memory_extract 不再重复发送对话载荷，empty content 不重试
status: superseded
date: 2026-10-06
scope: electron-agent/agentdata
files:
  - electron-agent/electron/pi/systemWorkerManager.ts
  - electron-agent/electron/app/appServer/taskQueue.ts
  - electron-agent/electron/app/appServer/types.ts
  - electron-agent/electron/agentData/storage.ts
  - electron-agent/electron/agentData/runtime.ts
  - electron-agent/electron/agent/modelRuntimeHost.ts
  - electron-agent/electron/main.ts
  - extensions/_shared/oneshot.ts
supersedes:
superseded_by: 2026-10-07-memory-extract-window.md
---

> 已过时 → 见 2026-10-07-memory-extract-window.md
> everyN 节流的否决另见 2026-10-07-memory-extract-cadence.md

## 背景
2026-09-08 至 09-28 的记忆任务共发出 49.8 MB input，其中 memory_extract 占 46.5 MB（305 个任务）。这些调用走 `ModelRuntimeHost.completeSimple`，不写 session JSONL，用量面板看不到，`service_tasks` 也没有 token 列，改了什么都无法验证收益。

`serviceTaskPrompt` 先用 `formatExtractionPrompt` 把 `delta` / `background` / `previousSceneName` 渲染成正文，再在 `Input:` 行把整个 `task.input` 序列化一遍，同一份对话发了两次。`delta` 与 `background` 占 input 的 95%。

失败任务占了 68% 的 input，其中 `error='empty content'` 有 108 个任务、216 次 attempt。重试来自 `TaskQueue`：registry 里 memory_* 的 `maxAttempts` 是 2。`SystemWorkerManager` 自己的重试循环在生产里 `maxAttempts` 取默认值 1，不是翻倍的来源。

`empty content` 的成因有一部分光看代码看不出来。pi-ai 的 `completeSimple` 不抛异常：HTTP 错误、限流、上下文超长都以 `stopReason: 'error'`、content 为空的消息返回（`AssistantMessageEventStream` 把 `error` 事件的 `event.error` 当作 result）。`formatNonStream` 只看 text 块，于是把 provider 的报错也记成 `empty content`。

## 决定
用量埋点。`ShortCallInput.onUsage` 在 `runtime.completeSimple` 返回后、文本校验之前回报 `{ model, usage }`，所以空内容和报错的那次调用也会记上。回报沿 `SystemWorkerManager.run(task, hooks)`、`executeServiceTask(task, hooks)`、`TaskQueue` 传回，`TaskQueue` 把它累加到 `service_tasks` 新增的 `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` / `model` 列。这几列用 `ensureColumn` 加，不动 `schema_version`。各次 attempt 都累加进同一行；一次也没拿到用量的任务这几列是 NULL。缓存读写单独成列：handoff 实测有约 16.8k token 的固定前缀，只看 `input` 会把缓存命中算漏。

M1：只对 memory_extract，`Input:` 行去掉本次真正渲染过的字段。`newMessages` 是数组时渲染的是它，否则是 `delta`；`background` 同理；`previousSceneName` 是字符串时去掉。`source` / `fingerprint` / `userId` / `projectId` / `workspace` / `sessionId` / `mode` 原样保留。其余 kind 不变。用本机 305 条历史 memory_extract 重放，user 消息平均从 316,642 字符降到 157,056 字符（比值 0.496，最大的一条从 3,757,389 降到 1,857,650）。逐条比对，保留字段的键和值没有任何差异。

F1：`formatNonStream` 先看 `stopReason`，`error` / `aborted` 时直接返回 provider 的 `errorMessage`。真正没有文本时仍以 `empty content` 开头，后面带上 `stopReason` 和块类型，例如 `empty content (stopReason=length, blocks=thinking)`。

F2：`TaskQueue` 遇到 `empty content` 开头的错误不再重试。provider 报错（限流、网络）照旧按 registry 的 `maxAttempts` 重试。

## 放弃的方案
- 直接删掉整个 `Input:` 行：上面 7 个字段从没被 `userBodyFor` 渲染过，删掉模型就看不到它们。
- 对 memory_scene / memory_persona 一并去重：`sceneUserPrompt` 只取 `scenes` 里的 filename/content，`personaUserPrompt` 也只取部分字段，逐字段确认之前不动它们，而且它们不是开销大头。
- 全局把 `maxAttempts` 改成 1：会影响所有 kind，还和「失败不重发积压」（阶段 2 的 M3）有顺序约束。这次只按错误类型分级。
- 在 `SystemWorkerManager` 的重试循环里做 F2：生产里那条循环只跑一次，改了也不会减少 attempt。
- 无 text 块时把 thinking 块当作回答：推理文本不是约定的 JSON 输出，交给 `parseCompleteOutput` 只会换一种失败方式，还可能抽出错误的记忆。先靠新的错误信息看清真实分布再决定。
- 加 `everyN` / warmup / idle debounce 节流：调用频次实测只有 1.15 次/轮，攻击的是只占 6% 的部分，还会让积压变大，更容易触发超大请求失败。
- 让 `completeSimple` 改返回 `{ text, usage }`：Wiki 等调用方都要跟着改，失败的那次也拿不到用量。用回调只加一个可选字段。
- 用量写进 `usage` JSON 列：按列存可以直接用 SQL 求和、和 `LENGTH(input)` 对比。

## 后果
token 与字节的换算还没校准：记忆系统目前关着（`MEMORY_EXTRACT=0`），要重新打开、跑一次抽取，拿新列和 `LENGTH(input)` 算出本机的 chars/token，结果另写一篇笔记。在那之前，`LENGTH(input)` 只能当相对负载看。

以前被记成 `empty content` 的 provider 错误现在会带着原始报错重试一次，所以 empty content 的 attempt 会少于原来的一半，provider 错误的 attempt 会多出来。看新数据时两类要分开统计。`formatNonStream` 也被 `pi oneshot` 子命令和 Wiki 生成使用，它们拿到的错误文本同样变成了 provider 的原始信息。

memory_scene / memory_persona 的载荷仍然可能重复；如果新埋点显示它们的占比上来了，再逐字段确认后去重。
