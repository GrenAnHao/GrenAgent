---
title: 记忆抽取按上游节奏：每 5 轮一批、预热 1→2→4→5、空闲 600 秒补抽、启动后补抽
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryService.ts
  - electron-agent/electron/agentData/memoryStore.ts
  - electron-agent/electron/agentData/runtime.ts
supersedes:
superseded_by:
---

## 背景
我们每次 agent_end 都抽取一次。上游 pipeline-manager.ts 是每个会话累计 everyNConversations（默认 5）轮才抽，新会话阈值从 1 开始，每抽一次翻倍（预热）；没到阈值时空闲 l1IdleTimeoutSeconds（默认 600）秒补抽；关闭时冲掉剩余。

2026-10-06-memory-task-usage-and-payload-dedupe.md（已被 2026-10-07-memory-extract-window.md 取代）否决过 everyN 节流，理由是调用次数只占成本的 6%。但上游控制成本靠的是「节奏 + 每批 10+5 上限」两者配合，单看频率会漏掉后一半。上限已在 2026-10-07-memory-extract-window.md 落地，这里补上节奏。

## 决定
MemoryService 按来源（user、workspace、session、source）记录计数和阈值，都在内存里，只存来源标识，不带 transcript。一次 capture 算一轮；没到阈值时返回 extraction: 'deferred'，并重置空闲计时。到阈值后先算抽取窗口（延后的轮次不会反复解析 transcript）：窗口为空就返回 'skipped'，只把计数清零、取消该来源的空闲计时，不翻倍阈值；真正入队才计数清零、阈值翻倍直到 everyN。没入队就不该推进预热。

任务进行中到来的轮数照样计数，任务结束后（finishCapture）够阈值就接着抽，不够就等空闲。这个进程里没见过该来源（重启后恢复的任务）时不知道积了多少轮，照旧立刻接着抽。

启动补抽代替上游的关闭时冲掉：recoverPendingCaptures 只登记请求，第一次见到开着开关的 capture 后（已见过则立刻）再等 60 秒，对有 pending 的来源补抽，最多 20 条、updated_at 新的优先。空闲补抽和启动补抽共用 flushSource，带 force 标记绕过阈值，force 只在主进程内部传，RPC 的 memory.capture 不会传。

补抽必须遵守用户开关 MEMORY_EXTRACT。主进程读不到这个设置，它只通过扩展每次 memory.capture 带的 extract 标志传进来，所以 MemoryService 记下最近一次非 force capture 的 extract 取值（extractObserved，未见过为 undefined）：收到 false 就取消所有来源的空闲计时和补抽计时（开关是全局的），补抽请求保留；收到开着的 capture 才挂补抽计时器；flushSource 在没确认开着时直接返回，任务结束后的接着抽在确认关着时也不入队。

dispose 之后 finishCapture 的后继、空闲计时、补抽都不再动作。

参数都可以通过 MemoryServiceOptions.extractCadence 覆盖，测试用 { everyN: 1, warmup: false } 保持旧行为。默认计时器 unref，空闲补抽不拖住进程退出。

## 放弃的方案
- 计数和阈值落库：重启后预热从 1 重新开始，只是早期多抽一次，代价很小，不值得为此加表。
- 退出时冲掉：Electron 退出时等不了模型返回，改为启动后补抽。
- 只做空闲补抽、不做 everyN：长会话一直在聊就一直不抽，pending 越积越大，最后被 10+5 窗口截掉。
- 同一 fingerprint 重复到达时不计轮：扩展重发同一份 transcript 时可以少数一轮。否决的理由不是「失败后原样重试要靠它立刻重新入队」：生产默认下失败时阈值已经 ≥2，原样重发只让计数 +1，仍是 deferred，并不能立刻重新入队。保留计轮是因为重复到达本身也是一次 agent_end，按上游口径就算一轮；为它单开去重判断没有收益。
- 启动补抽不看开关、到点就抽：用户关了 MEMORY_EXTRACT，重启后仍会把上次留下的 pending 送去抽取，绕过开关。
- 主进程自己读 MEMORY_EXTRACT：主进程读不到这个设置，要读就得新加一条通道，而每次 capture 本来就带着 extract 标志，复用它不用加接口。

## 后果
窗口外的消息被视为已处理，所以节奏越慢，单批里被跳过的早期对话越多。everyN 是 5 时，一批约 5 轮，正好落在 10 条新消息之内（每轮合并成 user + assistant 两条）。

如果某个来源的抽取每次都失败，每次启动会多试一次，不会无限重试：失败后只有出现更新的输入才会再入队。

失败后的重试要等阈值或空闲（默认 600 秒）才会再入队，比以前（每次 agent_end 都抽，重发即重试）慢。测试用 { everyN: 1, warmup: false } 保持旧的立即重试。

补抽受 MEMORY_EXTRACT 约束靠的是 capture 携带的 extract 标志，不是读设置：重启后要等第一次开着开关的对话进来才补抽，一直没有对话就一直不补。开关关闭期间被取消的空闲计时不会自动恢复，等该来源的下一次对话或下次启动。

启动补抽最多 20 条、新的优先；更旧的 pending 留给对应来源的下一轮对话，不会在这一轮被送去抽取。

节奏状态不落库，重启后每个来源的预热从 1 重来；进程内的来源条目只增不删，每条只有几个字段。
