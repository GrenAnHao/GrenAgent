---
title: 抽取输出按上游宽松解析：剥 think、去围栏、对象里找数组、修复控制字符与 priority
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/agent/memoryOutputParse.ts
  - electron-agent/electron/pi/systemWorkerManager.ts
  - electron-agent/electron/agent/memoryExtraction.ts
supersedes:
superseded_by:
---

## 背景
2026-10-06 一个新会话的 5 个 memory_extract 任务里有 3 个因格式失败（两个 `memory extraction output is invalid`，一个 `invalid JSON`），花掉了抽取 token 的 68%。我们的解析要求整段输出能被 JSON.parse，而且必须是场景数组或 {l1,l2,l3}；对象套数组、单个场景对象、字符串里有裸换行、priority 写成单词，都会整批失败。上游 l1-extractor.ts:571-681 对这些都有处理。

## 决定
新增 memoryOutputParse.ts，移植上游的 <think> 剥离、代码围栏剥离、sanitizeJsonForParse、repairExtractionJson。memory_extract 依次尝试：整段解析得到数组或信封；整段是单个场景对象就包成数组；否则取第一个 [ 到最后一个 ] 再解析。flattenSceneExtraction 对每条记忆补默认值：priority 非数字时转数字或给 50，source_message_ids 转字符串，metadata 不是对象时给空对象。其余 JSON kind 也先剥 think 和围栏，再走净化与修复。

## 放弃的方案
- 完全照上游，找不到数组时当作「没有记忆」直接提交：2026-10-06 的数据显示同样的输入重试会成功（dd38bb31 失败、紧接着的 76997ac5 成功），直接提交会丢掉这批记忆。所以仍然抛错，交给 TaskQueue 重试一次。
- 用 JSON mode（response_format）：上游 Chat Memory 也没用，而且中转和不同 provider 的支持参差不齐。
- type 缺失时默认 episodic（上游做法）：Pi 默认 work 模式，episodic 会被 parseMemoryExtraction 的类型过滤丢掉，结果一样，不如保持「缺 type 即丢」更直白。

## 后果
贪婪地取 [ 到 ] 时，如果模型在 JSON 前后的文字里也写了方括号，会解析失败，然后照常重试。解析失败时的原文在 service_tasks.raw_output 里，可以据此继续补容错。
