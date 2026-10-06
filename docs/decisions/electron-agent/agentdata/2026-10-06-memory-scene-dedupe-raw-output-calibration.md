---
title: memory_scene 也不再重复发送场景正文，解析失败留下模型原文，用量以埋点 token 为准不做字节换算
status: superseded
date: 2026-10-06
scope: electron-agent/agentdata
files:
  - electron-agent/electron/pi/systemWorkerManager.ts
  - electron-agent/electron/app/appServer/taskQueue.ts
  - electron-agent/electron/app/appServer/types.ts
  - electron-agent/electron/agentData/storage.ts
supersedes:
superseded_by: 2026-10-07-memory-scene-inline-related.md
---

> 已过时 → 见 2026-10-07-memory-scene-inline-related.md

## 背景
2026-10-06 打开记忆系统、在一个新会话里跑了几轮，埋点数据如下：

| 类型 | 任务 / attempt | prompt token |
|---|---|---|
| memory_scene 成功 | 1 / 1 | 66,593 |
| memory_extract 失败 | 4 / 8 | 13,276 |
| memory_extract 成功 | 2 / 2 | 6,262 |
| memory_persona 成功 | 1 / 1 | 3,359 |

memory_extract 去重之后，最贵的变成了 memory_scene。它的 input 是 63.5 KB，其中 `scenes`（现有全部场景文件）占 60 KB；`sceneUserPrompt` 已经把每个场景的正文内联进消息体，`Input:` 行又整个序列化了一遍，user 消息达到 124,321 字符。

新会话的 5 个抽取任务里有 3 个因为输出格式失败（两个 `memory extraction output is invalid`，一个 `invalid JSON`），花掉了抽取 token 的 68%。这类失败不是确定性的：`dd38bb31` 重试两次都失败，紧接着输入几乎一样的 `76997ac5` 一次就成功了。原始输出解析失败后就丢了，看不出模型返回了什么。

用量校准：同一个中转（`custom-muc3psr5/deepseek-v4.1-flash`）对几乎相同的 prompt，未命中缓存的部分都在 2,100 左右，缓存命中一次报 384、一次报 2,432，每次 attempt 的合计一个是 2,485、一个是 4,545。按实际渲染的 system + user 字符算，当天样本在 1.9 到 4.5 chars/token 之间，中文越多越低。handoff 里的 0.215 chars/token 和约 16.8k token 的固定前缀，在这条链路上都不存在。

## 决定
memory_scene 的 `Input:` 行去掉已经渲染过的字段：`memories`（正文里整段序列化）、非空的 `sceneSummaries`、字符串 `currentTimestamp`，以及每个场景条目的 `content`。场景的 `filename`、`summary` 和其余字段保留；`filename` 或 `content` 不是字符串的条目渲染时会被跳过，所以整条保留。`maxScenes`、`mode` 和来源字段不动。memory_persona 的重复只有约 2.6 KB，不改。

`SystemWorkerManager` 拿到模型文本后、解析之前，通过 `hooks.onRawOutput` 交出原文。`TaskQueue` 只在这次 attempt 失败时把它写进 `service_tasks.raw_output`（新列，截到 8000 字），任务成功时清空。格式类失败保留重试。

用量统计直接读 `input_tokens + cache_read_tokens + cache_write_tokens`，不再用 `LENGTH(input)` 换算。只有估算埋点之前的历史数据时，才按约 2 chars/token 粗算，并注明误差可能有一倍。

## 放弃的方案
- 把场景条目整个从 Input 去掉：`summary` 不在正文里，删掉会丢信息。
- 每次只发和新记忆相关的场景，不发全部：这会改变上游模板「全部场景内联」的语义，属于结构性改动，不在这次范围内。
- 把格式类失败也划进不重试：实测重试会成功，划进去会丢记忆。
- 原文写进 `error` 列：`error` 会在任务视图里展示，而且会被前缀匹配，塞进几千字的模型输出两边都会受影响。
- 每次 attempt 都留原文：成功的那次已经有 `output`，再存一份只是占空间。
- 在笔记里定一个统一的 chars/token：同一个中转对同样的 prompt 报出的数相差近一倍，单一比值会给出虚假的精度。

## 后果
场景数越多，memory_scene 越贵：每次都要发全部场景正文，去重只砍掉了重复的那一份。场景数逼近 `maxScenes` 时，单次就会有几万 token。

`raw_output` 里可能出现对话内容的摘录，和 `input`、`memories` 的敏感程度相同。

如果要精确核算成本，应换一个用量上报可信的 provider 再校准；这个中转的数字只适合看相对变化。
