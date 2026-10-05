---
title: 拖入的文本文件一律只发路径，不再把内容嵌进消息
status: active
date: 2026-10-04
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/input/editor/useTauriFileDrop.ts
  - electron-agent/src/features/chat/input/editor/useTauriFileDrop.test.ts
  - electron-agent/src/features/chat/input/editor/composeMessage.ts
  - electron-agent/src/features/chat/input/editor/composeMessage.test.ts
  - electron-agent/src/features/chat/input/editor/pastedText.ts
  - electron-agent/src/features/chat/messageTags.tsx
  - electron-agent/src/features/chat/messageTags.render.test.tsx
  - electron-agent/src/features/chat/input/editor/ChatTag/ChatTagView.tsx
supersedes:
superseded_by:
---

## 背景
拖入文本文件按大小分两路：不超过 600 行且不超过 32KB 的读出全文，用 `<pi:attachment type="file">` 嵌进消息，气泡里显示成可展开的附件卡；更大的复制到 `.pi/dropped/<hash>/`，发 `@path`。一次拖四份设计文档，三份（126、310、404 行）进了正文、一份（超过 600 行）变成气泡里一长串 `.pi/dropped/...` 路径。同一次操作得到两种结果，而且小文件的全文被塞进了这一条用户消息，之后每轮都在上下文里。用户要的是把文件交给 agent 去读。

## 决定
拖入的文本文件不论大小都发路径：工作区内用相对路径，工作区外先 `importDropped` 复制到 `.pi/dropped/<hash>/` 再引用。仍会读一次内容，只用来在输入框 chip 上显示行数。`composeMessage` 把所有文件引用放在正文后同一行，空格分隔；粘贴的长文本（不是文件）照旧用 `<pi:attachment type="text">` 嵌入。气泡里 `.pi/dropped/` 下的文件 chip 只显示文件名，完整路径放在悬停提示里；其它 `@path` 原样显示。

## 放弃的方案
- 保留按大小分流、只把阈值调大：同一次拖放仍会分成两种结果，嵌入的全文照样常驻上下文。
- 区外文件直接发绝对路径、不复制：工作区沙箱下 agent 不一定读得到工作区外的文件；复制到 `.pi/dropped/` 是已有机制。
- 引用也画成气泡下方的附件卡：卡片要能展开内容，引用只有路径，没有内容可展开；行内文件 chip 已经是 `@path` 的现成显示。

## 后果
- agent 要多一次读文件的工具调用才能看到内容；对很短的文件来说比嵌入慢一步。
- 以前发出、带 `<pi:attachment type="file">` 的历史消息照旧解析成附件卡，不受影响。
- 文件名带空格时 `@path` 仍会在空格处断开，这是 `@` 引用原有的限制，这次没处理。
