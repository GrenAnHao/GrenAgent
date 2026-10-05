---
title: 命令行工具行的运行时长由渲染层自计，起点定在 tool_execution_start
status: active
date: 2026-09-29
scope: electron-agent/tools
files:
  - electron-agent/src/stores/agentReducer.ts
  - electron-agent/src/features/chat/groupMessages.ts
  - electron-agent/src/features/chat/TurnTimeline.tsx
  - electron-agent/src/features/chat/ChatMessageItems.tsx
  - electron-agent/src/features/tools/ToolExecution.tsx
  - electron-agent/src/features/tools/RunDuration.tsx
  - electron-agent/src/features/tools/bashCardModel.ts
supersedes:
superseded_by:
---

## 背景
bash 工具行只有状态点，看不出一条命令跑了多久：运行中无从判断是卡住还是还在跑，结束后也没有留下耗时。pi 的 `tool_execution_start` / `tool_execution_end` 事件不带时间戳，工具结果里也没有耗时字段。

## 决定
时间由渲染进程自己记：reducer 在 `tool_execution_start` 写 `startedAt: Date.now()`，在 `tool_execution_end` 定格 `durationMs`，两个字段挂在 `ChatMessage` 的 tool 分支上并经 `ToolSegment` 透传到 `ToolExecution`。

计时起点是**开始执行**，不是卡片出现。卡片在参数流式生成阶段（`toolcall_delta` / `syncStreamingToolCalls`）就已立起，那段时间属于模型输出，不算命令运行时长，因此只有 `tool_execution_start` 写 `startedAt`。

显示交给 `RunDuration`，它自带 1s 定时器：工具段在 status/args/result 不变时被 `TurnTimeline` 的 `MemoSegment` 按值拦住，计时只能由组件内部推进。位置在 `ConvRow` 的 `name` 槽内、紧跟工具名之后，整行读作 `bash · 10s · 命令描述`；行尾仍然只有折叠箭头。格式 `formatRunDuration`：不足 1 分钟 `10s`，跨分钟 `1m20s`（整分省秒写 `2m`），跨小时降到分 `1h5m`。

只有 bash / shell / run_terminal_cmd 显示；其余工具虽然同样记下了 `startedAt` / `durationMs`（reducer 不按工具名分叉，省一层判断），但标题里不渲染。

## 放弃的方案
- 挂在 `ConvRow` 的 `meta` 槽（行尾、折叠箭头左侧）：右对齐后时长与它描述的命令之间隔着整行空白，扫一行读不出「这条跑了多久」；改到工具名后面与状态信息连成一串。
- 让 pi 侧在工具结果里回传耗时：要改 SDK 契约，而渲染层记的时间对用户是同一个量级；真需要精确到进程 exit code 的耗时时再考虑。
- 计时起点取卡片建立时刻（`toolcall_start`）：会把模型生成参数的时间算进命令运行时长，长 Write/Edit 参数能虚增好几秒。
- 由父级（`TurnTimeline`）每秒重渲染整段来推进计时：`MemoSegment` 的按值比较正是为拦住流式 tick 重渲染而存在，从外部驱动等于绕开它，一条 running 命令会让整段工具卡片每秒重渲染一次。
- 复用已有的 `formatCatalogDuration`（`1:20`）或 `formatGoalElapsed`（跨分钟只到 `1m`、丢掉秒）：前者是冒号制，与需求的 `1m20s` 不同；后者跨分钟后秒数不再变化，看不出进度。
- 在中断路径（`failRunningToolCards` / `settleIncompleteToolCards`）也定格耗时：那里处理的是参数没生成完就中断的卡片，没有 `startedAt`；真正在执行中被中断的命令仍走 `tool_execution_end`。

## 后果
- 历史会话回放（`messagesFromTranscript`）不带 `startedAt` / `durationMs`，旧记录的 bash 行不显示时长。会话文件里也不存这两个字段。
- 每条 running 的 bash 行有一个 1s 定时器；同时并发的命令行卡片越多，定时器越多。命令结束即清除。
- 时长是渲染进程观测到的事件间隔，含 IPC 往返，不等于子进程真实耗时。
