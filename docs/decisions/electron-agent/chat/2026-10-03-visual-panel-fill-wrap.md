---
title: 视觉设计在面板里撑满高度，方案按宽度折行
status: active
date: 2026-10-03
scope: electron-agent
files:
  - electron-agent/src/features/visual/frameAssets.ts
  - electron-agent/src/features/visual/VisualPanel.tsx
supersedes:
superseded_by:
---

## 背景
右侧「视觉设计」的 iframe 已经铺满面板，页面本身却是内容高度，下面空出一块。`.split` 固定两列，方案一多就挤在同一行。整页 HTML 不走 frame 样式，这两条规则原先只对片段生效。

## 决定
`.split` / `.cards` / `.pros-cons` 改成 `auto-fit` + 最小宽度，放不下就换行。面板和全屏预览额外注入撑满高度的样式，让比较区吃掉剩余空间。聊天里的内联卡片仍按内容高度。

## 放弃的方案
- 只改片段的 frame CSS：预览里的 Preview/Source 说明那是整页文档，补丁打不上去。
- 给所有预览都设 `height: 100%`：内联卡片的 iframe 按内容量高度，百分比高度会把卡片撑成一块空视口。
- 用 `min-height: 100vh` 硬撑比较区：标题和说明在比较区下面时会被顶出视口。

## 后果
撑满依赖页面使用 `.split` 或 `.cards`，并且比较区在纵向 flex 里。自定义的单行 flex 不会被改写成折行。`show_visual` 的说明要求新页面用这两个类。
