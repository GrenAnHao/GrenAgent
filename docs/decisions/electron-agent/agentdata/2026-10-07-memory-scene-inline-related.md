---
title: L2 只内联与新记忆相关的场景正文（最多 3 个），没给正文的已有场景不许写也不许删
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryLayers.ts
  - electron-agent/electron/app/memoryService.ts
  - electron-agent/electron/agent/memoryLayerPrompts.ts
  - electron-agent/electron/pi/systemWorkerManager.ts
supersedes: 2026-10-06-memory-scene-dedupe-raw-output-calibration.md
superseded_by:
---

## 背景
被推翻的笔记在「放弃的方案」里写过：只发相关场景「会改变上游模板『全部场景内联』的语义」。这句话是错的。上游 scene-extraction.ts:551-565 只给文件清单和摘要，正文由模型用 read 工具按需读；「全部内联」是 Pi 移植时因为系统 worker 没有工具而自己加的。2026-10-06 一次 L2 调用就用了 66,593 prompt token，占当天记忆 token 的 74%，而且场景越多越贵。

## 决定
主进程用关键词重叠（memoryTerms）挑出和本批新记忆最相关的最多 3 个场景内联正文，其余只出现在摘要清单里。场景数 ≥ maxScenes − 1 时（必须 MERGE）全部内联。提示词写明只能改或删正文已提供的场景，可以新建。completeScene 落库前丢掉对「已存在但没给正文」的场景的写入和删除；重启恢复的任务从存储的输入里还原哪些场景给过正文（带 content 的条目就是给过的）。

拼 prompt 时场景总数和红 / 橙 / 黄预警档位按 `scenes` 的全部条目算，不再按带正文的条目算：预筛之后带正文的最多 3 条，按它算会让 13 个场景的黄色预警消失。正文区仍只渲染带 content 的条目。

被推翻的旧笔记里，以下结论仍然有效：memory_scene 的 Input 行去掉已渲染字段（memories、sceneSummaries、currentTimestamp、场景 content）；service_tasks.raw_output 在解析失败时留下模型原文；用量统计直接读埋点 token，不做字节换算（同一中转对相同 prompt 报出的数相差近一倍，当天样本在 1.9 到 4.5 chars/token 之间）。

## 放弃的方案
- 给 L2 worker 开只读 read 工具，完全对齐上游：要让系统 worker 跑工具循环，改动大，用户选择了主进程预筛。
- 只发摘要、一律不内联正文：UPDATE 要输出完整正文，模型看不到原文就只能凭摘要重写，会丢内容。
- 按 L1 的 scene_name 精确匹配文件名：L1 的情境名是一句话（「用户在围绕英语时态学习」），和场景文件名对不上。

## 后果
预筛靠关键词，相关场景用词差别大时可能漏选，模型就会新建一个本该合并的场景；场景数逼近上限时会全部内联、强制 MERGE，把这类重复收回来。场景文件名常带共同前缀（如「团队记忆-」），新记忆正文恰好含「记忆」这类词时，每个场景都会有一分，最终按得分再按文件名挑前 3 个，相关性会变弱；将来如果观察到这种情况，应给共同前缀词降权，而不是放大内联数量。被丢掉的写入或删除没有记录，要排查时看 service_tasks.output 和 L2 的实际变化。
