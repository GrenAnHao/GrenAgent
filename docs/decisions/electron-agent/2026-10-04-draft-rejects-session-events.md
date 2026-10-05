---
title: 未绑定会话的草稿画面不接收任何带 sessionPath 的事件
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/stores/agent.ts
  - electron-agent/src/stores/agent.test.ts
supersedes:
superseded_by:
---

## 背景
同项目多会话并行后，渲染层按 `sessionPath` 分流事件。草稿画面（`loadedSessionPath` 为空）原先只拒收两种事件：路径等于 `detachedPath` 的，和已经有 shadow 的。会话停到后台时如果正空闲，`parkCurrent` 不给它留 shadow，`detachedPath` 也会在下一次停靠或 `reset` 时被覆盖。这样的会话之后被唤醒，比如后台子代理回报把父会话叫起来，它又起了一个子代理，它的事件两条都对不上，就整段灌进草稿。用户看到的是别的会话的回复和子代理卡片出现在空白草稿里。

## 决定
草稿画面收到带 `sessionPath` 的事件一律按后台处理，写进该会话自己的 shadow。草稿首发在 `ensureSessionForSend` 里先 `bindSessionPath` 再 `prompt`，所以绑定前不会有属于草稿本身的带路径事件。没有路径的事件照旧进画面。`bindSessionPath` 同时丢掉该路径上可能残留的 shadow，因为从这一刻起画面就是它。

## 放弃的方案
- 停靠时不管忙闲都留 shadow：只能盖住「停靠过」的会话。渲染层从没见过的会话（store 刚建、被淘汰后重建）仍会漏进草稿。
- 用一个集合记住所有停靠过的路径：和上一条一样只认识见过的会话，还要多维护一份状态。
- 草稿收到第一条带路径事件时把它当成自己的会话绑定：另一个会话的事件可能先到，草稿就被绑错会话。

## 后果
- 草稿在绑定前不会显示任何会话的流式内容。如果以后有流程在 `bindSessionPath` 之前就让草稿自己的会话开跑，必须先把绑定提前，否则这些事件会进 shadow，不显示在画面上。
- 后台会话在草稿期间攒出的 shadow 切回时照常接上。没有缓存打底的 shadow 按 partial 处理，消息以后端快照为准。
