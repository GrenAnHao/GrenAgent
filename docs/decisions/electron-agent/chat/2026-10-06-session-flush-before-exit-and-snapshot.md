---
title: 会话退出和同会话快照载入前先应用实时事件队列
status: active
date: 2026-10-06
scope: electron-agent
files:
  - electron-agent/src/stores/agent.ts
  - electron-agent/src/stores/agent.test.ts
supersedes:
superseded_by:
---

## 背景

实时事件按帧或 60ms 批处理，收到事件时 store 的运行标记可能还是上一批的状态。进程退出只清标记时，队列里的 `agent_start` 会在稍后把已退出的会话重新标成运行；同会话快照只看当前标记时，会把尚未应用的 start / 正文增量随队列一起清掉，或因未应用的 end 错误拒绝已结束会话的快照。

## 决定

前景进程退出时先 `stream.flush()` 留住最后一批输出，再清 `isStreaming`、`runActive`、`awaitingResponse` 和前景活动标记。同会话载入快照时先应用 pending 队列，再按更新后的运行状态决定保留实时内容、合并缺失历史或载入终态快照。切到另一会话继续走现有停靠和后台 shadow 收流路径。

## 放弃的方案

- 退出或载快照时只 `clear()`：最后一批正文、工具状态和结束事件会永久丢失。
- 只检查 `hasPending()` 就拒绝快照：队列也可能装的是 end / settled，应用后应允许更新历史，不能一律挡住。
- 等下一帧再处理退出或快照：把正确性依赖于渲染调度顺序，隐藏窗口下还会拖到超时兜底。

## 后果

退出和同会话快照载入会同步应用最多一批已到达事件，不增加请求或定时器。运行态判断与实际接收的事件一致，迟到的调度回调只能进行空 flush。
