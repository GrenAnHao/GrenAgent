---
title: 子会话事件在主进程只广播一次，由第一个认领的 WorkspaceHandle 转发
status: active
date: 2026-10-05
scope: electron-agent
files:
  - extensions/multi-agent/embedded-events.ts
  - electron-agent/electron/agent/workspaceHandle.ts
  - electron-agent/src/features/panels/useChildSessionBinding.ts
supersedes:
superseded_by:
---

## 背景

子代理详情在流式输出时叠字，每个增量都出现 3 遍（`Wal` `Wal` `Walking through re` `king through re` `king through re`……），结束后正文恢复正常。渲染层的 reducer 按 `thinking_delta` / `text_delta` 逐条累加，每条事件只处理一次，所以重复发生在事件到达之前。结束后恢复，是因为 `useChildSessionBinding` 在 `running` 变化时重置状态并从 JSONL 重新读一遍，JSONL 本身是对的。

主进程里，每个 `WorkspaceHandle.start()` 都往模块级的 `embedded-events` sink 表里注册一个 sink，只按 workspace 过滤。`AgentHost.groups` 允许同一项目同时活着多个 handle（前景会话加停靠的忙会话），于是一个子会话事件被每个 handle 各广播一次，渲染层收到 N 份。截图里是 3 个 handle 同时在线。

## 决定

`EmbeddedSubagentEventSink` 可以返回 `true` 表示已认领，`emitEmbeddedSubagentEvent` 遇到第一个返回 `true` 的 sink 就停。`WorkspaceHandle` 的 sink 在已 dispose 或 workspace 不匹配时返回 `false`，转发之后返回 `true`。认领的 handle 被 dispose 时它的 sink 随之注销，下一个同项目的 handle 自动接手，不用额外交接。

广播本身（`broadcastPiEvent`）是发给所有窗口的，不依赖是哪个 handle 发的，所以谁来发都一样。

## 放弃的方案

- 在渲染层 `useChildSessionBinding` 去重：事件没有序号，相邻两个 delta 文本完全相同是合法的（比如连续的空格或逗号），按内容去重会吞掉正文；要可靠去重得先给事件加序号，改动比在源头只发一次大。
- 只让前景 handle 注册 sink：前景会随切换会话而变，被停靠的会话里的子代理照样在跑，它的事件要有人转发；前景被淘汰时还得重新注册。
- 给事件带上父会话路径，由 `session.sessionFile` 匹配的那个 handle 转发：孙级子代理的父是子会话路径，handle 不认识，要沿登记表一路回溯；会话在运行中被 `switchSession` 换掉时归属也会丢。
- 把 sink 从 handle 里搬到 `main.ts` 注册一次：需要把事件里的 cwd 映射回逻辑 workspace，现有测试和 catalog sink 的结构都要跟着改，对一个单点 bug 偏重。

## 后果

多个逻辑 workspace 共用同一个 cwd 时，只有最早注册的那个 handle 会转发，别的收不到。渲染层 `useChildSessionBinding` 只按 `sessionPath` 过滤、不看 workspace，所以界面上没有影响。

`workspaceHandle.test.ts` 很多用例 `start()` 之后不 `dispose()`，会在模块级 sink 表里留下旧 handle 并先认领事件，所以那个文件加了 `beforeEach` 重置 sink 表。以后新增依赖子会话事件转发的用例要沿用。

`registerCatalogChangeSink` 有同样的"每个 handle 各发一次"结构，但它发的 `subagent_catalog_changed` 只触发页头重读，重复无害，这次没动。以后如果它的消费端变成累加式的，需要照此处理。
