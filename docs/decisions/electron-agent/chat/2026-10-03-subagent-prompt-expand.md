---
title: 子代理提示词展开最多 550px，短内容不撑满
status: active
date: 2026-10-03
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/TaskPromptFrame.tsx
supersedes: electron-agent/chat/2026-10-03-subagent-closed-prompt.md
superseded_by:
---

## 背景

任务提示词收起时最多 350px，并带底部阴影。展开若写成固定 550px，短提示词下面会空出一块。

## 决定

展开用最大高度 550px。内容不到 550px 时高度跟着内容；超过 550px 时停在 550px 并打开滚动条。收起仍是最大高度 350px、不显示滚动条、底部 `ScrollShadow`。闭合后才上屏、并行行模型芯片这两条保持不变。

## 放弃的方案

- 展开固定 550px：短内容会被撑出空白。
- 展开不设上限、整段铺开：长提示词会把后面的会话顶出视口。

## 后果

超过 550px 的提示词要在这条气泡内部滚动，而不是把会话条目无限拉长。
