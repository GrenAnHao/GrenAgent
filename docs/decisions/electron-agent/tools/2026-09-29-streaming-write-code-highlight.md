---
title: 写入生成中只做逐行追加的代码高亮，完成后才换成 diff
status: active
date: 2026-09-29
scope: electron-agent/tools
files:
  - electron-agent/src/features/tools/StreamingCodeView.tsx
  - electron-agent/src/features/tools/ToolExecution.tsx
  - electron-agent/src/features/tools/FileDiffBlock.tsx
  - electron-agent/electron.vite.config.ts
  - electron-agent/vitest.config.ts
supersedes: ./2026-09-29-streaming-write-diff-quantized.md
superseded_by:
---

## 背景

上一篇把生成中的 diff 提交量化到「每新增一行一次」，闪动没了，但 pierre 的 `FileDiff` 只要内容变过就整列 `innerHTML` 重排，成本仍是每行 O(当前行数)。

更根本的一点是那篇没问：写入的 diff 有没有信息量。写入是整文件新增，diff 通栏全绿，左右两侧一模一样——生成阶段花在 diff 上的算力换不到任何信息。编辑不一样，编辑要看删了什么、加了什么。

## 决定

按工具分开：

- **写入生成中**：新增 `StreamingCodeView`，只做代码高亮（行号 + 语法着色，不带 diff 装饰）。底层用 `@pierre/diffs` 的 `FileStream`——正文以 `ReadableStream` 喂进去，token 到齐就 `appendChild` 一行，已渲染的行节点原地不动。这是 pierre 里唯一带 append 路径的渲染器。`allowRecalls` 让半截 token 在后续字符到达后自行纠正，所以不需要我们在外面按行量化。
- **写入完成后**：照旧交给 `FileDiffBlock` 的 pierre `CodeDiff`，diff 展示和交互完全不变。
- **编辑**：不动，继续走 `StreamingFileBody` 的旧/新块实时视图。

配套三件事：

1. `@pierre/diffs` 提到 `electron-agent/package.json` 的直接依赖，版本钉 `1.2.12`，与 `@lobehub/ui` 自己钉的完全一致，让 pnpm 收敛成同一份。
2. `electron.vite.config.ts` 和 `vitest.config.ts` 的 renderer 都加 `resolve.dedupe: ['@pierre/diffs']`。pierre 带模块级单例（`getSharedHighlighter`、自定义主题注册表、`customElements.define('diffs-container')`），两份副本就是两套注册表。加之前构建产物里每个主题 chunk 都是双份，`FileStream` 与 `FileDiff` 落在不同 chunk。
3. `StreamingCodeView` 自己保底注册 `lobe-theme`：先 `resolveTheme` 试探，拿不到才用 `@lobehub/ui/es/Highlighter/theme/lobe-theme` 的同一份主题数据在手上这份副本上补注册。dedupe 在打包时有效，但 vitest 把 `@lobehub/ui` externalize 给 Node 原生 ESM 加载，Vite 的 dedupe 管不到它，实测就会抛 `No valid theme loader registered for "lobe-theme"`。

顺带删掉 `FileDiffBlock` 的 `followTail`：生成中不再用这个组件，贴底逻辑移到 `StreamingCodeView` 的 `onPostRender`。

## 放弃的方案

- **继续让生成中渲染 diff（上一篇的结论）**：量化只能降低重排频率，消不掉 `FileDiff` 的整列替换；而且写入的 diff 本身没有信息量，优化一件不该做的事。
- **只加 dedupe，主题继续靠 lobe 注册**：打包路径可行，但正确性挂在一行 bundler 配置上，哪天副本再分叉就静默退回纯文本。实测 vitest 里已经分叉，说明这不是假想问题。
- **改用 pierre 自带的 `pierre-dark` / `pierre-light`**：完全不碰 lobe 内部路径，但配色和完成后的 diff 卡片不一致，切换时会看起来像渲染出错。
- **自己写行渲染器（不依赖 pierre）**：能免掉新依赖，但要自己维护流式 shiki 的语法状态、行号栅格和主题变量，是在重写 `FileStream`。
- **沿用 lobe 的 `SyntaxHighlighter animated`（改动前的committed 行为）**：它每次都整块重渲染，而且 `useStreamHighlight` 在正文持续增长时初始化永远完不成，`StreamingFileBody` 里那个 `HighlightedText`（冻住正文直到高亮 DOM 出现）就是为绕开它写的。

## 后果

- 多了一个直接依赖，版本与 `@lobehub/ui` 的内部选型耦合。lobe 升 pierre 时这里要跟着升，否则 pnpm 会装两份，dedupe 只能收敛到一份、另一份的主题注册表失效（好在有第 3 条兜底）。
- `@lobehub/ui/es/Highlighter/theme/lobe-theme` 走的是 lobe `exports` 里的 `./es/*`，合法但仍是内部文件布局。挪走了就 `console.error` + 退回纯文本 `<pre>`，不会白屏。
- 生成 → 完成之间有一次渲染器切换（`FileStream` 卸载、`CodeDiff` 挂载）。只发生一次，且那一刻内容一致；代价换掉的是原来每 600 字符一次的重挂。
- 超大写入仍按 `exceedsHighlightBudget` 退到 `StreamingFileBody` 的纯文本尾部预览。`FileStream` 是增量的，这条阈值其实可以放宽，但没有实测数据前不动。
- 流式视图用原生细滚动条（hover 渐显），最终 diff 卡片仍是自绘 thumb，两者的滚动条样式略有差异。
