---
title: 文件浏览器的文件树在右边，并且可以收起
status: active
date: 2026-10-11
scope: electron-agent/file-explorer
files:
  - electron-agent/src/features/fileExplorer/FileExplorer.tsx
supersedes:
superseded_by:
---

## 背景

文件浏览器原来是左边文件树、右边内容。看文件时树占着阅读起点，而且没有办法把它让开。

## 决定

内容区在左，文件树在右。树头有收起按钮，收起后右边留一条 32px 的竖条，点它再展开。展开或收起记在 localStorage，宽度偏好沿用原来的键。分隔条仍在树的内侧：往左拖树变宽。

## 放弃的方案

- 收起后完全不留入口，把展开按钮放进内容工具栏。没打开文件时工具栏不存在，树收起来就找不回来。
- 树继续放在左边，只加一个收起。阅读起点还是被树挡住，和这次要的布局相反。

## 后果

空状态文案是「从右边选一个文件查看」。收起会卸掉树的界面，已展开的目录仍留在数据里，再展开不用重新列根。
