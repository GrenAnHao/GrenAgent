---
title: 对话列表贴底改写 scrollTop，不再用 virtua 的 scrollToIndex
status: active
date: 2026-10-08
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/VirtualizedMessageList.tsx
  - electron-agent/ui-harness/probes/subagent-conversation.mjs
supersedes:
superseded_by:
---

## 背景

`VirtualizedMessageList` 每次渲染都用 `scrollToIndex(last, { align: 'end' })` 贴底。virtua（0.51.3，到 0.53.3 仍然如此）的 `scrollToIndex` 不是一次性滚动：它在 `observer.ts` 的 `_scroll` 里订阅测高事件，最后一次测高后 150ms 内每次测高都重滚到目标，用户滚动不会取消它。流式输出或刚挂载时用户往上滚，新挂上的条目一测高，视图就被拽回底部；如果同一窗口里还挂着锚点为 0 的 `scrollToIndex`，会直接跳到顶部。子代理详情加了末尾留白后，`subagent-conversation` 场景的滚轮正好落进这个窗口，问题才暴露出来。

## 决定

贴底（`stickToBottom`、打开会话时的钉底、resize 收尾时的贴底分支）直接写滚动容器的 `scrollTop = scrollHeight`，不留下任何待重滚的任务。末尾条目测高后变高，由新增的内容 ResizeObserver 在贴底状态下跟上，resize 期间不插手。用户点「回到底部」仍用 `scrollToIndex(..., { smooth: true })`，那是用户主动发起的，平滑滚动在测完高后立即结束。非贴底时 resize 的锚点恢复保持 `scrollToIndex`。

场景里去掉了「滚之前先等滚动停稳」的等待，改成断言挂载后立刻上滚 200px，500ms 后仍停在用户位置。把贴底换回 `scrollToIndex` 时这条断言会失败（一次跳到顶部，一次被拽回离底 37px）。

## 放弃的方案

- 升级 virtua：最新的 0.53.3 仍不在用户滚动时取消挂起的 `scrollToIndex`。
- 用户上滚时调用 `scrollTo(当前位置)` 顶掉旧任务：新任务的目标是调用时的固定偏移，滚轮在它之后才生效，测高时又会被拽回去。
- 用户上滚时调用 `scrollToIndex(锚点)` 顶掉旧任务：每次滚动都要重发，程序化滚动还会打断 Chromium 的滚轮平滑动画。
- 只在 probe 里等滚动停稳：只掩盖测试，真实使用时流式中第一下上滚仍会被拽回。

## 后果

贴底不再依赖 virtua 的重滚机制，靠内容 ResizeObserver 跟随，所以 virtua 内部 DOM 结构（滚动容器 → 内容容器）变了需要同步调整选取方式。主对话也走这个列表，但目前没有 ui-harness 场景覆盖主对话的流式贴底。virtua 以后如果在用户滚动时取消挂起的 `scrollToIndex`，可以重新评估是否换回。
