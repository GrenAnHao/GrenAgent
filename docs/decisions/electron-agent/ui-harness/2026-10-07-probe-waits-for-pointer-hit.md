---
title: 虚拟列表里的 probe 交互先等目标被指针命中满 300ms
status: active
date: 2026-10-07
scope: electron-agent
files:
  - electron-agent/ui-harness/probes/subagent-conversation.mjs
supersedes:
superseded_by:
---

## 背景

`subagent-conversation` 的长模式偶发失败：有时找不到终态长思考，有时点了展开按钮没反应，有时滚轮推不动思考正文。有三个原因。第一，虚拟列表贴底时，排在最后一个工具之后的那条思考不一定已经挂载，而 probe 直接取「DOM 里最后一个思考块」。第二，virtua 0.51.3 在外层列表滚动期间会给内层容器设 `pointer-events: none`（`lib/index.js` 里的 `pointerEvents: isScrolling ? "none" : undefined`），这段时间的点击和滚轮都会被外层接走。第三，`scrollIntoView` 之后 scroll 事件要到下一帧才派发，virtua 那时才进入滚动态，所以只做一次命中测试，可能恰好落在这个空档里。

## 决定

先结束自动贴底，等「排在最后一个工具之后的思考块」挂载后再打标记。点击和滚轮之前用 `settleHit`：把目标滚到视口中央，等交互点的 `elementFromPoint` 连续 300ms 落在目标内（virtua 判定滚动结束的防抖约 150ms），这一步本身也记成一条断言。改完后连跑 6 次，每次 29/29。

## 放弃的方案

- 固定 sleep：时长要么不够，要么拖慢所有运行，并且掩盖了「交互点被挡住」这一事实。
- 只做一次命中测试：会抢在 scroll 事件到达之前通过，2 次里失败 1 次。
- 在页面里直接 `element.click()`：绕过真实的命中路径，违反 harness 只发真实输入事件的约定。

## 后果

主对话用的是同一个 `VList`，以后其他场景在虚拟列表里点击或滚动，都要先 `settleHit`。virtua 如果改了滚动期间的 pointer-events 行为，这条辅助可以去掉。
