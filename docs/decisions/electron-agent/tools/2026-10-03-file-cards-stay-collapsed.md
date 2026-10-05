---
title: 写入和编辑默认收起，命令行继续展开并跟输出
status: active
date: 2026-10-03
scope: electron-agent
files:
  - electron-agent/src/features/tools/ToolExecution.tsx
  - electron-agent/src/features/chat/conv/TerminalBlock.tsx
supersedes:
superseded_by:
---

## 背景
运行中的写入、编辑和 bash 都会自动展开。写入和编辑的正文往往很长，展开后把后面的工具行顶出视线。bash 的输出路径是有的：`tool_execution_update` 会改卡片的 result，但输出一长，视口停在顶部，新行看不见。

## 决定
只有 bash / shell / run_terminal_cmd 在运行中默认展开。写入和编辑保持收起，标题行仍显示文件名和增删行数，点开才看正文。bash 输出区在运行中把滚动位置放在末尾。

## 放弃的方案
- 写入也收起、连 bash 一起收起：命令还在跑时，输出是这个卡片要看的内容。
- 生成阶段继续自动展开，结束后再收起：用户要的是调用时不要展开，生成过程同样会占住会话。

## 后果
流式写入和高亮还在，只是默认不打开。已经手动展开的卡片不会因为后续 delta 被重新收起。
