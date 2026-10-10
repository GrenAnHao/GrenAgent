---
title: 并发会话先合并连续增量，后台会话复用批量收流并稳定子代理订阅
status: active
date: 2026-10-06
scope: electron-agent/chat
files:
  - electron-agent/src/stores/sessionStream.ts
  - electron-agent/src/stores/sessionStream.test.ts
  - electron-agent/src/stores/agent.ts
  - electron-agent/src/stores/agent.test.ts
  - electron-agent/src/stores/subagentLiveStore.ts
  - electron-agent/src/stores/subagentLiveStore.test.ts
supersedes:
superseded_by:
---

## 背景

三个主会话和多个子代理同时输出时，按帧 setState 仍不能限制 reducer 的工作量：同一批里的每个正文或思考增量都会复制完整消息数组。同项目停靠会话还绕过 sessionStream，逐事件处理并更新缓存。子代理列表每次查询都产生新行对象，即使没有变化也通知所有卡片，而且请求未完成时会继续叠加查询。

## 决定

sessionStream 在入队时合并相邻、没有 message 快照、同类型且同 contentIndex 的正文或思考增量；消息开始、结束、工具事件、类型变化和带快照的事件都保留边界。主会话和子代理详情共用该机制。同项目的后台会话各自复用 sessionStream，以现有 60ms 调度批量处理；切回、补历史快照、退出及最终结束前先 flush，移除绑定和销毁时取消调度。

子代理全局轮询不叠加未完成请求。按 ID 复用内容未变化的行对象；列表的行与顺序都没变时不更新 store，变化的代理不再引起其他卡片的对象订阅更新。

## 放弃的方案

- 限制用户的代理并发数：不能解决每个 token 复制历史和无变化卡片刷新的来源，也会改变用户的工作方式。
- 只降低 UI setState 频率：队列里仍逐条跑 reducer，后台会话也仍逐 token 处理。
- 合并带 message 快照的增量，或跨工具、消息边界合并：快照具有覆盖语义，跨边界会改变消息顺序与工具草稿状态。
- 只给主进程 IPC 限速：未证明 IPC 是主要瓶颈，且无法消除渲染端对同一帧内增量的重复历史复制。

## 后果

后台缓存最多延后现有批处理间隔，切回前同步应用队列，因此可见内容不丢失。合并只覆盖正文与思考增量，工具参数流仍走原有草稿解析机制。回归以九条并发流的内容和 reducer 调用次数验证工作量，不能替代用户真实负载下的帧率测量。
