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
MemoryService 按来源（user、workspace、session、source）记录计数和阈值，都在内存里，只存来源标识，不带 transcript。一次 capture 算一轮；没到阈值时返回 extraction: 'deferred'，并重置空闲计时。到阈值就入队，计数清零、阈值翻倍直到 everyN。窗口是否为空放在到阈值之后才算，所以延后的轮次不会反复解析 transcript。

任务进行中到来的轮数照样计数，任务结束后（finishCapture）够阈值就接着抽，不够就等空闲。这个进程里没见过该来源（重启后恢复的任务）时不知道积了多少轮，照旧立刻接着抽。

启动 60 秒后对所有还有 pending 的来源各补抽一次，代替上游的关闭时冲掉。空闲补抽和启动补抽共用 flushSource，带 force 标记绕过阈值，force 只在主进程内部传，RPC 的 memory.capture 不会传。

参数都可以通过 MemoryServiceOptions.extractCadence 覆盖，测试用 { everyN: 1, warmup: false } 保持旧行为。默认计时器 unref，空闲补抽不拖住进程退出。

## 放弃的方案
- 计数和阈值落库：重启后预热从 1 重新开始，只是早期多抽一次，代价很小，不值得为此加表。
- 退出时冲掉：Electron 退出时等不了模型返回，改为启动后补抽。
- 只做空闲补抽、不做 everyN：长会话一直在聊就一直不抽，pending 越积越大，最后被 10+5 窗口截掉。
- 同一 fingerprint 重复到达时不计轮：扩展重发同一份 transcript 时可以少数一轮，但「任务失败后原样重试」的现有行为依赖它计一轮才能立刻重新入队，改了就要给重试单开通道。

## 后果
窗口外的消息被视为已处理，所以节奏越慢，单批里被跳过的早期对话越多。everyN 是 5 时，一批约 5 轮，正好落在 10 条新消息之内（每轮合并成 user + assistant 两条）。

如果某个来源的抽取每次都失败，每次启动会多试一次，不会无限重试：失败后只有出现更新的输入才会再入队。

节奏状态不落库，重启后每个来源的预热从 1 重来；进程内的来源条目只增不删，每条只有几个字段。
