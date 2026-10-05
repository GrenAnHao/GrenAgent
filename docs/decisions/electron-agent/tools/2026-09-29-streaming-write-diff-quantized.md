---
title: 生成中的写入 diff 按「新增一行」量化提交，而不是每帧重渲染或按字符数重挂
status: superseded
date: 2026-09-29
scope: electron-agent/tools
files:
  - electron-agent/src/features/tools/FileDiffBlock.tsx
  - electron-agent/src/features/tools/ToolExecution.tsx
supersedes:
superseded_by: ./2026-09-29-streaming-write-code-highlight.md
---

> 已过时 → 见 ./2026-09-29-streaming-write-code-highlight.md

## 背景

写入工具的参数是流式到达的，`agent.ts` 每个动画帧 flush 一次并重解析半截 JSON，所以生成中的卡片最高 60Hz 拿到新的 `args`。原实现在 `ToolExecution` 里给 `FileDiffBlock` 挂了 `key={Math.floor(content.length / 600)}`：内容每长 600 字符 key 就变，React 卸载重建整棵子树，`<diffs-container>` 被销毁后重新 `attachShadow`、重注主题 CSS、重新高亮、滚动位置归零——一个 466 行的文件一次生成里要重挂 ~25 次，表现为持续闪动。

底层还有一条库约束：`@pierre/diffs` 的 `FileDiff.canPartiallyRender()` 只要内容变过就返回 `false`，随后 `codeUnified.innerHTML = renderPartialHTML(...)` 整列替换。`FileDiff` 没有 append 路径，逐行追加 DOM 不是调用方能配置出来的。

## 决定

两件事：

1. 去掉 `key`，生成中到完成后全程复用同一个 `FileDiffBlock` 实例，`<diffs-container>` 只创建一次。
2. 新增 `LiveWriteDiff`：正文只增不减，用「最后一个换行符的位置」当水位线，只有出现新换行符时才把最新正文交给 `CodeDiff`。于是提交次数从「每帧一次」降到「每新增一行一次」，半截的行也不会反复重排整块代码——一行写完才整行出现。

顺带把 `FileDiffBlock` 那个 effect 的 `rows` 依赖去掉：`rows` 每次渲染都是新数组，留着会让指针/滚动监听每帧重绑、900ms 高亮兜底定时器每帧重排。内容变化已由 `newContent` / `oldContent` 表达。

## 放弃的方案

- **用 `@pierre/diffs` 的 `FileStream` 做真正的 DOM 逐行追加**：它是库里专为流式设计的类，`appendChild` 追加、带 token recall、复用同一个 shiki 单例，是唯一能消掉整列 `innerHTML` 的路径。放弃原因有三：`@pierre/diffs` 目前只是 `@lobehub/ui` 的间接依赖，直接 import 就要新增一个与 lobe 内部选型版本耦合的直接依赖（版本错开会出现两个 highlighter 单例）；它渲染的是 *file* 而不是 *diff*，行类型硬编码 `context`、`diffIndicators: 'none'`，要靠 unsafeCSS 去贴 pierre 的内部 data 属性才能补回加行的绿底和 `+`，视觉容易跟最终 diff 漂移；而且生成中和完成后会变成两个不同的渲染器，违反既有约束「生成中就用和完成后相同的 diff」（`ToolExecution.test.tsx` 有对应用例）。
- **纯时间节流（每 80ms 提交一次）**：同样能把 60Hz 压下来，但提交点与内容无关，会出现半截 token 被高亮成另一种颜色再改回来的抖动；而且测试里同步 rerender 后拿不到内容，得引入假定时器。按行量化既确定又正好落在语法边界上。
- **保留 `key` 但把 bucket 调大**：只是把闪动频率降低，没有消除重挂本身；滚动位置、shadow root、主题 CSS 依旧每次丢一遍。

## 后果

- pierre 内部那次整列 `innerHTML` 仍然存在，只是从每帧一次变成每行一次。单次成本是 O(当前行数)，所以整段生成是 O(行数²)：466 行量级没问题，但超大文件（几千行）会在末尾变慢。真要消掉这一项，只能走上面被放弃的 `FileStream` 路线，代价是新增直接依赖 + 自己贴 diff 样式。
- 生成中的写入路径没有接 `exceedsHighlightBudget` 的降级（`StreamingFileBody` 有）。超大写入会一路走高亮 diff，这条缺口是原有实现带来的，本次没有一并处理。
- `LiveWriteDiff` 依赖「正文单调增长」。`parsePartialArgs` 解析失败时返回 `{}`，正文会短暂变空，届时这一帧会退回 `StreamingFileBody`。实际未观察到，因为草稿 JSON 只追加。
