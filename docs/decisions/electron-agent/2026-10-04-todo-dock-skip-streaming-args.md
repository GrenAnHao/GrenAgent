---
title: 任务条在 todo 参数流式生成期间不读半截参数，等 argsComplete 再切换
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/features/chat/input/latestTodos.ts
  - electron-agent/src/features/chat/input/latestTodos.test.ts
supersedes:
superseded_by:
---

## 背景
模型调用 todo 更新清单时，任务条一直闪。`toolcall_delta` 每来一段，`materializeToolDrafts` 就把半截 JSON 解析进卡片 `args`。`todosFromArgs` 只检查「每一行都有合法 status」，可流式前缀经常满足这一点，下一个字又不满足。于是任务条在旧清单、空清单（`{"todos":[` 解析成 `[]`，任务条整个卸载）和半截新清单之间来回切换，任务名也逐字变长。回放一次三行的更新，任务条出现了 14 种不同状态。

## 决定
`todosFromTool` 遇到 `argsComplete === false` 时不再读 `args`，任务条停在上一份成功清单，等 `toolcall_end` 写入完整参数后一次切到新清单。中间结果（`result.details`）仍然优先。`argsComplete` 缺省视为完整，历史与非流式后端走原路径。

## 放弃的方案
- 加严 `todosFromArgs` 的完整性判断（例如要求 text 闭合）：partial-json 解析器会把未闭合字符串补全，渲染侧分不清字符串是否已闭合；就算判断准了，前缀一样会短暂满足条件，旧清单和半截新清单还是会交替出现。
- 像 `spawn_agent` 那样在 `materializeToolDrafts` 里给 todo 做 `closedTodoArgs`：能挡住逐字长出，挡不住「行数少于旧清单」时旧新交替，还要在 reducer 里再加一个按工具名分支的特例。
- 在 `TodoDock` 里做防抖或记住上一帧：只是把闪烁压慢，数据源仍在抖，而且要在组件里藏状态。

## 后果
流式期间任务条不再实时跟着参数长，要等参数写完（todo 参数很短，通常在一秒内）才切换。若以后要做「边写边长」的任务条，需要一个能区分已闭合行的流式解析，不能简单删掉这道 `argsComplete` 判断。
