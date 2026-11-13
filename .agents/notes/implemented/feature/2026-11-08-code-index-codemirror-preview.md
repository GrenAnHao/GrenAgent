# Agent Note: 代码索引详情区换 CodeMirror 只读预览并铺满高度

Status: implemented

## Problem

代码索引详情区的源码预览是自绘 `pre` + virtua 虚拟化（[旧决定](../bug-fix/2026-10-14-code-index-paged-files-and-virtual-source.md)）：没有语法高亮、520px 高度上限在高窗口里留下大片死白；工具栏是两排大按钮加说明文字，松散；文件行（无符号）详情底部还挂着「未提供符号，无法查询调用关系。」一句废话。用户要求：CodeMirror 只读 + 语法高亮、内部铺满高度、工具栏紧凑、去掉底部废话。

## Decision

- `CodeSourceLines` 是 CodeMirror 6 只读 viewer：`lineNumbers`、`syntaxHighlighting`（暗 oneDark / 明 default，跟 `useThemeMode`）、按文件名异步加载语言（`LanguageDescription.matchFilename`，cancelled flag 防换文件竞态）、目标行用 `StateField` + `Decoration.line` 画橄榄绿底 + 左侧强调条（`.cm-target-line`）、`scrollToLine` 走 `EditorView.scrollIntoView(..., { y: 'center' })`。对外 API 不变（`lines` / `target` / ref `scrollToLine`），新增 `path` 供语言识别。换文件整份替换文档但保留扩展与语言。
- 行号栏背景必须不透明（`colorBgContainer`，viewer 宿主同色）：横向滚动时代码从 sticky 行号栏下穿过，透明底会让行号叠在代码上——用户实际报过的 bug。
- `CodeSourceDetail` 单行紧凑工具栏：`N 行 · 只读` + 小号行号输入 + 跳转到行 + 复制/系统打开图标按钮（aria-label 保留旧可访问名，系统打开的 tooltip 写明不保证定位行号）；删「项目根目录」「行号定位…」「未提供行号」三段说明；viewer `flex: 1` 铺满卡片剩余高度。
- 详情列 flex 布局：源码卡 `flex: 1`（min-height 240px）铺满；有符号时节点上下文 + 调用关系收进底部 `max-height: 38%` 限高、栏内滚动区；无符号时什么都不挂。
- 测试策略：jsdom 编排类测试（CodeSourceDetail / navigation / workbench）经 `codeSourceLinesStub` 替换 viewer，`scrollToLine` 记 spy；真实 viewer 由 CodeSourceLines.test（jsdom 已验证 CM 可渲染；scrollTo 给无操作替身）与 ui-harness code-retrieval-panel 场景覆盖。probe 源码段断言在 `.cm-line` / `.cm-target-line` / `.cm-scroller` 上：铺满、窗口化、跳行居中、长行横向滚动、行号栏不透明；夹具源码带空行（每 7 行一空行）守着行号对齐。注意夹具里 200 的倍数行是长注释，跳行断言按 `// line N:` 前缀写。

## Alternatives considered

- **保留自绘 pre，只放开高度上限** — 最强理由：改动最小，probe 几乎不用动。否掉：用户明确要 CodeMirror 与语法高亮；自绘预览没有高亮，折行量高、选中复制体验都差，文件管理器已有成熟 CM 主题/语言加载模式可复用。
- **直接复用文件管理器 CodeEditor 组件** — 最强理由：主题、查找、语言加载全现成。否掉：CodeEditor 带编辑历史、diff、查找驱动、onChange 节流等编辑器契约，只读预览用不到还要喂 dummy props；viewer 扩展集小得多，单独写更窄，主题写法照抄它的模式。
- **关系区做成可折叠抽屉** — 最强理由：代码永远铺满。否掉：多一次点击才能看调用关系，符号行场景变差；限高底部区一眼可见且代码仍占大头。

## Consequences

- 收益：源码有语法高亮、只读可选中复制；行号跳转居中、目标行高亮；文件行详情铺满无死白、无废话；工具栏一行收齐；长文件 DOM 只有窗口附近的行（CM 自带）。
- 代价：jsdom 无布局，viewer 的真实几何（铺满、窗口化、居中）只能由 harness 守；编排测试靠 stub，stub 与真实 API 漂移时 harness 会红。CM 语言包异步加载，首帧短暂无高亮。
- 旧笔记里「文件列表主进程分页」部分仍成立；「自绘预览 + virtua」部分被本篇取代，旧篇已加互链。

## Verification

结果：通过。证据在 `.agents/evidence/2026-11-08-code-index-codemirror-preview/`。

- `npx vitest run src/features/agentData src/features/codeIndex`：12 个文件 149 条全过，日志 `vitest-cm-final.log`。
- `npm run ui:check -- code-retrieval-panel`：71 条全 PASS，日志 `ui-check-cm5.log`。覆盖：文件行源码框铺满详情列且底部无废话、符号行源码与上下文区一起填满、语法高亮、大文件窗口化、跳 9000/12000 居中、长行横向滚动、行号栏不透明、空行行号对齐、滚轮滚动、滚回头顶、矮窗口下限、窄视口、深浅色截图（`code-retrieval-panel-detail-file-light.png`、`code-retrieval-panel-detail.png`）。
- `npm run ui:check -- code-index-sync`：22 条全 PASS，日志 `ui-check-sync3.log`。
- 过程中修掉的两个真问题：行号栏透明底横滚叠字（改不透明）；probe 跳行断言字符串与夹具长注释行不符（按 `// line N:` 写）。