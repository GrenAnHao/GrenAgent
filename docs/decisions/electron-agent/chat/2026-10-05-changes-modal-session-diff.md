---
title: 「查看改动」弹窗改用会话同款 FileDiffBlock，按 git patch 渲染
status: active
date: 2026-10-05
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/input/workspace/DiffPanel.tsx
  - electron-agent/src/features/tools/FileDiffBlock.tsx
  - electron-agent/src/features/tools/CodeCard.tsx
  - electron-agent/src/features/tools/LazyHighlighter.tsx
  - electron-agent/src/features/tools/fileDiffModel.ts
  - electron-agent/src/lib/lobeHeavy.ts
supersedes:
superseded_by:
---

## 背景
分支气泡里的「查看改动」弹窗原来是 860px 宽、460px 高，diff 是自己按行着色的纯文本，没有语法高亮和行号，和会话里编辑卡的 diff 不是一个样子。

## 决定
弹窗改为垂直居中，宽度 `min(1280px, 92vw)`，正文高度 `min(calc(100dvh - 160px), 820px)`，左侧文件列表 260px。lobe Modal 的 body 默认是 `maxHeight: 75dvh` + `overflow: auto` + 底部 16px 内边距，正文高一点 body 就会在弹窗外侧多出一条滚动条，所以通过 `styles.body` 把这两项改成 `none` / `hidden`，正文高度只由正文自己定。右侧用会话里的 `FileDiffBlock`（同一个 CodeCard 头、同一份 unsafeCSS、同一套悬浮滚动条）。`FileDiffBlock` 新增两个可选 prop：`patch` 和 `maxHeight`。传了 `patch` 时，改用 lobe 的 `PatchDiff` 渲染，它和 `CodeDiff` 都基于 @pierre/diffs。`maxHeight` 同时作用于 CodeCard 正文和 diff 的 `:host` / `[data-code]`。会话里的调用方不传这两个 prop，表现不变。PatchDiff 解析出错时，由 ErrorBoundary 退回行级 diff（`rowsFromGitPatch` → `rows`）。

## 放弃的方案
- 把 git diff 拆成 `rows` 交给现有的 `CodeDiff`：`textsFromRows` 会把多个 hunk 首尾拼成一段 old/new 文本，行号从 1 开始，hunk 之间的分隔也没了。整文件级别的改动看起来会很乱。
- 读 HEAD 版本和工作区文件的全文交给 `CodeDiff`：要新增一个 IPC 去读 `git show HEAD:path`。大文件时还要把整个文件送进渲染进程做 diff，而 git 本来就已经算好了 patch。
- 新写一个弹窗专用的 diff 组件：样式会和会话里的那份慢慢分叉，跟这次「同款」的要求相反。

## 后果
- `get_git_diff` 仍然是 `git diff -- <file>`，只包含未暂存的改动。已暂存的修改显示为空，或者走 `--no-index` 的整文件新增，这和原来一样，没有改。
- 二进制文件的 patch 里没有 hunk，弹窗显示「二进制文件或无文本 diff」，不会交给 PatchDiff，因为 PatchDiff 遇到空 patch 会直接抛错。
- `FileDiffBlock` 处于 patch 模式时不写 `data-new-content` / `data-old-content`，测试和 ui-harness 要改看 `data-diff-source`。
