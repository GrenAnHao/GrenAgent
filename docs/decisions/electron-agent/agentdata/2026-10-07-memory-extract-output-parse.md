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
新增 memoryOutputParse.ts，移植上游的 <think> 剥离、代码围栏剥离、sanitizeJsonForParse、repairExtractionJson。memory_extract 依次尝试：整段解析得到数组或信封；整段是单个场景对象就包成数组；整段是带别的字段的对象就在属性值里找场景数组；整段解析不出来才取第一个 [ 到最后一个 ] 再解析。返回数组前都要过同一个判定：空数组放行（模型明确说没有记忆），非空数组至少有一个带 memories 数组的对象，否则按解析失败处理。这个判定是必须的：flattenSceneExtraction 会跳过没有 memories 的元素，completeExtraction 在 l1 为空时照样提交游标，把裸 L1 记录数组或 [1] 当成结果返回，就是把这批对话静默当成没有记忆、永久跳过。输出里还有未闭合的 <think>（被 max_tokens 截断）时不走贪婪回退，直接失败。flattenSceneExtraction 对每条记忆补默认值：priority 非数字时转数字或给 50，source_message_ids 转字符串，metadata 不是对象时给空对象。其余 JSON kind 也先剥 think 和围栏，再走净化与修复。

## 放弃的方案
- 完全照上游，找不到数组时当作「没有记忆」直接提交：2026-10-06 的数据显示同样的输入重试会成功（dd38bb31 失败、紧接着的 76997ac5 成功），直接提交会丢掉这批记忆。所以仍然抛错，交给 TaskQueue 重试一次。
- 用 JSON mode（response_format）：上游 Chat Memory 也没用，而且中转和不同 provider 的支持参差不齐。
- type 缺失时默认 episodic（上游做法）：缺 type 的记录现在是被 l1RecordSchema 的 type: z.string() 丢掉的。不跟上游是为了不引入默认类型；episodic 在 chat 模式下是有效类型，默认它会把没写 type 的记录原样存进 chat 记忆，而 work 模式下才会被类型过滤丢掉。
- 回退路径不做判定、拿到数组就返回（即最初的实现）：截断的 <think> 里的 [1]、裸 L1 记录数组都会被当成「没有记忆」提交，和上面「完全照上游」有同样的问题。

## 后果
贪婪地取 [ 到 ] 时，如果模型在 JSON 前后的文字里也写了方括号，括号里的内容通常解析不出来，按解析失败重试；括号里的内容恰好是合法 JSON 但不是场景数组（如 [1]）时，按上面的判定也会失败重试，不再被当成空结果。整段已经是合法 JSON 对象时不再对原文做贪婪正则：对象里找不到场景数组（如 {"l1":[…],"summary":"x"}）就原样交给 parseMemoryExtraction 的严格校验，同样可重试。解析失败时的原文在 service_tasks.raw_output 里，可以据此继续补容错。
