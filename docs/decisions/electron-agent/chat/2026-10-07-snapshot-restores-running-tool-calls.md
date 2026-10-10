---
title: 会话快照把末尾还没有结果的工具调用补成 running 卡
status: active
date: 2026-10-07
scope: electron-agent
files:
  - electron-agent/src/stores/agentReducer.ts
  - electron-agent/src/stores/agent.ts
  - electron-agent/src/features/panels/useChildSessionBinding.ts
supersedes:
superseded_by:
---

## 背景

`messagesFromAgent` 只靠 `toolResult` 建工具卡，assistant 消息里发出、还没有结果的调用被丢掉（`ask_user` 除外）。工具正在跑的时候切进这个会话，且画面没有完整 shadow 可用时，界面用快照重建：思考显示「已深度思考」，下面没有那张卡，底部「正在处理」照常计时。之后的 `tool_execution_update` 只更新已有卡片，不会补建。前台 bash 静默等锁、跑几分钟的 ui:check 时，看起来就像会话已经停了。用真实会话 JSONL 截到这次调用为止喂给 `snapshotMessages`，能稳定复现。

## 决定

`messagesFromAgent` 把最后一条 assistant 消息发出、还没有结果的调用补成 running 卡（参数完整、无结果），之后的实时事件按 `toolCallId` 落在这张卡上。中途残留的孤儿调用不补，补在末尾会乱序。`ask_user` 保持原来的单独处理。

新增 `interruptPendingToolCards`：调用方确认这一轮已经不跑时，把这类 running 卡收成已中断（`interrupted: true`），避免应用重启后留下的调用一直转圈。主会话加载时看 runState（以及同一会话的实时状态），子代理种子读取时看 `running`。

## 放弃的方案

- 让 `tool_execution_update` 在找不到卡时补建：前台命令没有输出时不会有 update，静默等锁的那几分钟照样缺卡；而且 update 不带位置信息。
- 一律补成已中断：切进运行中的会话时，正在跑的 bash 会被标成已中断，直到结果回来。
- 在 `agent_settled` 时统一收掉所有 running 卡：会碰到 `ask_user` 等待行的恢复流程，影响面超出这个问题。

## 后果

渲染进程热重载后，运行态由 `restoreRunningTurns` 稍后补上。如果加载那一刻 runState 还是空的，补出来的卡会先显示已中断，等真实结果到达后，按 `interrupted` 的语义替换成真实结果。在这之前它看不到流式输出，但至少不再缺卡。
