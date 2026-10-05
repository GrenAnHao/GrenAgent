---
title: 提问浮层挂在对话列里，切走会话就一起隐藏
status: active
date: 2026-10-03
scope: electron-agent
files:
  - electron-agent/src/features/chat/input/sessionOverlay.ts
  - electron-agent/src/features/chat/input/ComposerPromptOverlay.tsx
  - electron-agent/src/features/chat/input/EnhancePromptOverlay.tsx
  - electron-agent/src/features/layout/MainChatColumn.tsx
supersedes:
superseded_by:
---

## 背景
ask_user 和增强提示词用 `position: fixed` 挂到应用根上。对话模块切走时只是 `display: none`，固定定位的节点不在这棵树里，上次量到的坐标还留在屏幕上，提问卡会盖到 MCP 这类别的页面。

## 决定
浮层 portal 到 `[data-chat-column]`，用相对列的绝对定位。列没有尺寸（被隐藏）时不渲染。列本身 `overflow: hidden`，卡片出不了会话页。

## 放弃的方案
- 继续挂到 `document.body`，只在 `activeModule !== 'chat'` 时不渲染：右栏、子视图仍和会话页叠在同一模块里，固定定位还是能画出列外。
- 列宽变成 0 时保留上一次坐标：这就是切页后卡片停在旧位置的原因。

## 后果
浮层的锚点必须在带 `data-chat-column` 的对话列里，否则不显示。列外的测试要自己包一层这个属性。
