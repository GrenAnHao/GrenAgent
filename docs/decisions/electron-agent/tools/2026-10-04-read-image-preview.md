---
title: 读取图片时在卡片里直接显示画面
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/features/tools/FileImageRead.tsx
  - electron-agent/src/features/tools/ToolExecution.tsx
  - electron-agent/src/features/chat/turnRows.ts
supersedes:
superseded_by:
---

## 背景
`read` 读到图片时，Pi 的结果里同时有一句说明（`Read image file`、缩放尺寸）和 `type: image` 的字节。卡片只用说明文字去填代码高亮，画面本身不出现。连续读取还会把这条收进「已收集上下文」。

## 决定
结果里有图像块时，展开区用这些字节画图，点击可放大，不再把说明文字当成文件正文。这类读取单独成行，但和其它文件读取一样默认收起。普通文本读取不变，两段及以上仍可折叠。

## 放弃的方案
- 继续只显示说明文字：那是给模型的尺寸备注，用户看不到图。
- 再用 `read_file_binary` 按路径读一遍原图：结果里已经是模型看到的那份（可能被缩小），再读一次可能失败，也可能和卡片里的尺寸对不上。
- 留在上下文折叠里：图片读取的内容就是画面，不该和一串文本读取捆在「已收集上下文」后面。
- 结果一到就自动展开：用户要求读取卡片保持收起，点开才看图。

## 后果
图像字节本来就在工具结果里，现在还会放进 img 的 data URL。卡片默认收起，点开才看到图。没有图像块的读取不受影响。
