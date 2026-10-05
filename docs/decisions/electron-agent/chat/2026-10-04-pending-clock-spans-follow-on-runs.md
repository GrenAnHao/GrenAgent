---
title: 正在处理的计时跨过 agent_settled，接着跑的回合沿用同一个起点
status: active
date: 2026-10-04
scope: electron-agent/chat
files:
  - electron-agent/src/stores/agentReducer.ts
  - electron-agent/src/stores/agentReducer.test.ts
  - electron-agent/src/stores/agent.ts
  - electron-agent/src/stores/agent.test.ts
  - electron-agent/src/stores/restoreRunningTurns.ts
  - electron-agent/src/stores/restoreRunningTurns.test.ts
  - electron-agent/src/features/chat/ChatView.tsx
  - electron-agent/src/features/chat/QuestionsCard.tsx
  - electron-agent/src/features/chat/PlanCard.tsx
supersedes: electron-agent/chat/2026-10-04-pending-clock-from-run-start.md
superseded_by:
---

## 背景
「正在处理…」的起点 `runStartedAt` 在 `agent_settled` 时清掉，下一次 `agent_start` 再从当时起算。用户发出一次请求后，主会话常常不止跑一轮：后台子代理结束时 `subagent-settled` 用 `triggerTurn` 叫起父会话；自动压缩完用隐藏消息续跑；执行中排队的跟进在本轮收尾后才发；引导赶上 `agent_settled` 时被 Pi 推迟成下一回合。这些都是先 `agent_settled` 再 `agent_start`，计时于是一次次归零。切到别的会话再切回、渲染层重载后恢复运行态，也会丢掉起点，从切回或恢复的那一刻重算。最近 40 份会话里有 28 次 `subagent-settled`，和「总在重新计算」的观感对得上。

## 决定
`agent_settled` 不再清 `runStartedAt`。从空闲开始的回合先标 `runOpening`，等它的第一条消息再定起点：
- 界面发送时已经用 `pinRunClock` 定好起点（`runOriginPinned`）：照办。空闲时发送是新请求，从发送那一刻起算；跟进、引导在还跑着的时候发出，沿用当前起点，Pi 把它们推迟到下一回合也不重算。问答卡、计划卡的执行按钮也先钉住。
- 没钉过、第一条是用户消息：从别处发来的新请求，从现在起算。
- 第一条是自定义消息（子代理回报、压缩续跑、后台任务通知）或直接续写助手：同一件事的延续，沿用。
- 回合中途的用户消息只用掉钉定，不动起点。

另外，切走时 shadow 带着起点，切回由 `takeShadowRunState` 还原；同一会话的强制重载保留起点；`restoreRunningTurns` 恢复运行态时画面没有起点，就用最后一条非引导用户消息的时间，没有才用现在。

## 放弃的方案
- 把 `agent_settled` 之后一小段时间内的 `agent_start` 当成同一轮：时间窗多长都不对，子代理可能跑几十分钟才回报。
- 主进程给每个回合标「由谁触发」再推给渲染层：要改 Pi SDK 事件或在 `WorkspaceHandle` 里跟踪 `sendMessage`，第一条消息的角色已经足够区分。
- 计时改成从用户消息的 timestamp 起算：引导和跟进也是用户消息，按最后一条用户消息算仍会在跟进时归零；而且本地刚发的消息还没有 timestamp。

## 后果
- 用户发一次请求、会话被子代理反复叫醒跑了半小时，这一行就显示半小时，中间空闲的时间也算在内。中间空闲时这一行不显示，再跑起来接着数。
- 以后新增「由界面发出、会开回合」的入口，要在发送前调用 `pinRunClock`，否则如果它发的是自定义消息，会被当成延续，接着上一轮计时。
- 从侧栏外（例如 IM 网关）发来的用户消息不会经过钉定，按「没钉过的用户消息」从收到时起算。
