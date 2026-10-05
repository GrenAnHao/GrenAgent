---
title: Memory 列表高度锁在窗口剩余区域，超长时在分栏内滚动
status: active
date: 2026-09-29
scope: electron-agent/agentdata
files:
  - electron-agent/src/features/agentData/memoryStyles.ts
  - electron-agent/src/features/agentData/MemoryPanel.tsx
supersedes:
superseded_by:
---

## 背景
Agent 数据的标签页已经是定高，滚动发生在 `.panel` 上。Memory 根节点没有接上这条高度，左侧列表随条目变高，整页可以一直往下滚。

## 决定
Memory 根节点 `height: 100%` 并做成纵向 flex。页头和分组留在外面，下面的卡片 `flex: 1; min-height: 0; overflow: hidden`。分栏去掉 440px 下限，左右两栏继续各自 `overflow: auto`。搜索条留在列表外面，不跟着条目滚。

## 放弃的方案
- 给列表写 `max-height: 100vh`：视口高度含标题栏和标签栏，列表仍然高出可见区域，外层照样能滚。
- 改共用分栏的 `min-height: 440px`：Wiki 和代码索引还靠这个下限撑开，它们的页面本身仍随内容变高。

## 后果
窗口很矮时列表会缩到剩余高度，不再保证 440px。详情栏和列表同一高度，长正文在右侧栏内滚动。
