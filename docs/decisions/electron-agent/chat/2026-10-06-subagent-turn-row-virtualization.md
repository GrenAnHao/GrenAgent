---
title: 子代理长回合按时间线行虚拟化，完成态思考沿用流式限高
status: active
date: 2026-10-06
scope: electron-agent
files:
  - electron-agent/src/features/chat/ChatMessageItems.tsx
  - electron-agent/src/features/chat/VirtualizedMessageList.tsx
  - electron-agent/src/features/chat/TurnTimeline.tsx
  - electron-agent/src/features/chat/ReasoningInline.tsx
  - electron-agent/src/features/panels/SubAgentConversation.tsx
supersedes:
superseded_by:
---

## 背景

子代理详情已经使用主对话的 virtua 列表，但一次任务的连续 assistant/tool 被 `groupMessages` 合成一个 turn。只有初始任务和整轮回复两个虚拟条目时，180 次工具循环仍挂载全部 180 张工具卡。完成态思考展开直接渲染 Markdown，也没有流式态已有的 160px 上限。

## 决定

`ChatMessageItems` 增加仅子代理详情启用的 `virtualizeTurnRows`，通过原有 `buildTurnRows` 把一个 turn 展开为列表条目。上下文分组仍是一个条目，嵌套工具仍随父工具渲染；`TurnTimelineRow` 复用原有段落渲染，整轮只在末行显示一个复制入口，复制内容仍是整轮正文。`VirtualizedMessageList` 泛型仅要求稳定 id，贴底、阅读锚点、测高和回到底部逻辑保持共用。主对话默认仍按完整 turn 虚拟化。

完成态思考的 Markdown 外包流式态同一份限高滚动样式，主对话和子代理同时采用 160px 上限。

## 放弃的方案

- 只调小 virtua 缓冲区：整个 turn 仍是一个条目，无法卸载这一轮里离屏的工具。
- 在子代理详情再加独立的嵌套虚拟列表：两层滚动和测高相互影响，还会复制主对话已有的锚点维护。
- 直接把每条 assistant/tool 消息当成条目：破坏连续查找工具分组、相邻思考合并和嵌套调用的父子关系。
- 每一行都复制一次整个 turn：会出现大量重复操作栏；保留单个末行入口即可。

## 后果

工具和思考离开缓冲区后卸载，重新回到视口时折叠状态按组件默认值恢复，与现有列表卸载完整 turn 的行为一致。单个上下文分组或父工具自身包含特别多内容时仍是一个条目；如果以后这类内容成为瓶颈，应在对应组件内部处理，而不是拆散它们的语义。
