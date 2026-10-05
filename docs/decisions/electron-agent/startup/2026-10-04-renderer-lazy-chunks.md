---
title: 渲染层首包只留对话界面，@lobehub/ui 的重组件经本地模块中转按需加载
status: active
date: 2026-10-04
scope: electron-agent/startup
files:
  - electron-agent/src/lib/lobeHeavy.ts
  - electron-agent/src/features/chat/LazyMarkdown.tsx
  - electron-agent/src/features/chat/Mermaid.tsx
  - electron-agent/src/features/chat/MermaidLoading.tsx
  - electron-agent/src/features/tools/LazyHighlighter.tsx
  - electron-agent/src/features/tools/StreamingCodeView.tsx
  - electron-agent/src/features/workspace/ModuleContainer.tsx
  - electron-agent/src/features/workspace/ModuleContainer.test.tsx
  - electron-agent/src/features/dock/TabBodyRenderer.tsx
  - electron-agent/electron.vite.config.ts
supersedes:
superseded_by:
---

## 背景
生产构建的首屏 JS 约 9.8MB，入口块 9MB。里面有 elkjs 2.5MB、@primer/octicons 1.1MB、katex 0.9MB、recharts、emoji-mart、xterm，还有设置、Agent 数据等面板。`LazyMarkdown`、`LazyHighlighter`、`StreamingCodeView` 都写了 `import('@lobehub/ui')`，本意是按需加载。可这个包同时被首屏静态引用，打包器要备齐整个命名空间，结果 Markdown、Mermaid、EmojiPicker 全留在了首包里（构建日志里的 `INEFFECTIVE_DYNAMIC_IMPORT` 说的就是这个）。`LazyHighlighter` 还在模块顶层就发起这次导入，和首屏抢解析时间。

## 决定
- 新增 `src/lib/lobeHeavy.ts`，只转出 `Markdown`、`Highlighter`、`SyntaxHighlighter`、`CodeDiff`。按需加载一律 `import()` 这份文件，这样只有这几个组件及其依赖进按需分块。
- `Mermaid` 组件改成懒加载。分块到达前显示 `MermaidLoading`，和组件内部预检时是同一份样式，高度不跳。
- 设置、连接、扩展、用量、Agent 数据、开发者工作台面板，以及终端标签的 `TerminalBody`，都改成 `React.lazy`。
- `LazyHighlighter` 在第一次有组件要用时才导入；`CodeViewWarmup` 和 `MarkdownWarmup` 一样，等浏览器空闲（最多 3s）再预热。
- 开发态给渲染层 dev server 加 `server.warmup`，服务一起来就顺着 `src/main.tsx` 转译源码。

无头 Chrome 打开生产构建：首屏 JS 9.8MB → 3.5MB，DOMContentLoaded 约 780ms → 390ms，首次 React 提交约 1.4s → 0.96s。开发态单独起的 dev server 冷转译时首屏约 4.8s，加预热后约 2.0s。

## 放弃的方案
- 直接 `import('@lobehub/ui/es/Markdown')` 这类深路径：要依赖包内目录结构，升级就可能断；本地转出一层效果相同。
- 把 Markdown 栈留在首包、只拆面板：katex、octicons、rehype 加起来超过 2MB，空白草稿首屏用不到。
- 去掉 @lobehub/ui 从 CDN 拉字体（HarmonyOS Sans、Geist，约 8MB）：只影响第一次启动，而且会改变界面字形，这次不动。

## 后果
- 第一次打开某个面板、第一次出现 Mermaid 图或打开终端时，要多等一个本地分块，约几十毫秒，期间是空白或「Loading diagram…」占位。
- 以后要按需加载 @lobehub/ui 的其它组件，先加到 `lobeHeavy.ts` 再动态导入它；不要再写 `import('@lobehub/ui')`。
- 开发态里 @lobehub/ui、antd 是整包预打包的，这些拆分对开发态首屏帮助有限，主要省的是生产包。
