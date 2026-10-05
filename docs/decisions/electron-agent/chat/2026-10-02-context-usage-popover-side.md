---
title: 上下文用量卡片默认朝右，对话列放不下才朝左
status: active
date: 2026-10-02
scope: electron-agent
files:
  - electron-agent/src/features/chat/input/ContextUsageTag.tsx
  - electron-agent/src/features/layout/MainChatColumn.tsx
supersedes:
superseded_by:
---

## 背景
用量环在输入栏左侧。卡片原先固定 `topRight`，一律从触发器往左长。窗口够宽、右侧还是对话区时，卡片却盖向侧栏方向，右边空着。

## 决定
默认 `topLeft`，卡片在触发器上方往右长。碰撞盒是对话列（`data-chat-column`），不是整个窗口。列的右侧放不下时，对齐从 start 翻成 end，卡片改往左长。窗口变窄和右栏占住右侧都会把列的右缘往左推，同一条规则覆盖这两种情况。

## 放弃的方案
- 只改成 `topLeft`，继续按视口翻转：右栏在窗口里面，视口右侧仍有像素，卡片会盖住右栏里的内容。
- 右栏一打开就强制朝左：列里触发器右侧还够放卡片时，不必让开整块右栏。
- 自己量矩形再写死 placement：浮层库已经在打开期间跟祖先尺寸走，右栏拖动时列会变，再写一套测量会漏掉打开中的变化。

## 后果
用量环必须留在带 `data-chat-column` 的对话列里，碰撞盒才认得出右栏边界。列外单独渲染时退回库的默认裁剪祖先。卡片仍然优先留在上方，不会改到触发器左右两侧。
