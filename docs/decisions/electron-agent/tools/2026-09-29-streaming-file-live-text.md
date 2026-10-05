---
title: 生成中的编辑和写入先显示最新正文，不等高亮初始化完成
status: active
date: 2026-09-29
scope: electron-agent/tools
files:
  - electron-agent/src/features/tools/StreamingFileBody.tsx
  - electron-agent/src/features/tools/StreamingCodeView.tsx
  - electron-agent/src/features/tools/CodeCard.tsx
supersedes:
superseded_by:
---

## 背景

写入和编辑的参数是逐段到达的，卡片上的正文和行数应该跟着变。编辑路径把可见文本冻住，直到语法高亮的 DOM 出现；而高亮器在正文持续增长时初始化会被取消，永远等不到那个信号。于是屏幕上的内容停在第一段，整段参数写完、高亮不再被打断，才一次刷出来。写入的流式容器又用了 `flex-basis: 0` 加 `min-height: 0`，父级没有固定高度时正文区高度会被压成 0，行画进去也看不见，完成后换成 diff 才出现。

## 决定

可见文本始终用当前参数，不设水位。高亮能跟上就替换，跟不上就继续显示纯文本。写入在 FileStream 画出第一帧之前也先用这段纯文本。行数（写入是行数，编辑是已经露出的增删行）写在标题上，随半截参数更新。流式容器按内容撑高，上限仍是 `min(50vh, 360px)`。

## 放弃的方案

- 继续冻住正文直到高亮 DOM 出现，再用 2 秒超时放开：超时之前看起来就是「写完才更新」；组件若中途重挂，计时还会重新开始。
- 生成中只显示行数、正文仍等整段结束：行数本身没有正文信息，和用户看到的卡片对不上。

## 后果

生成中的编辑多半停在纯文本，配色要等参数停稳、高亮初始化成功才会出现。写入在 FileStream 接上之后仍走逐行追加；接上之前的那一帧是纯文本。
