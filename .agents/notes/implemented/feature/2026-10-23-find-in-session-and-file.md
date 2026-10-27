# Agent Note: 会话内查找与文件内快速查找（Ctrl+F）

Status: implemented

## Problem

应用里没有页内查找：长会话里找一句话只能手滚；文件标签里打开的 Markdown 预览没有任何查找，代码编辑器只有 CodeMirror 默认的搜索面板（样式和应用对不上，也没有统一的计数、跳转、高亮）。窗口无菜单栏，Electron 的 `webContents.findInPage` 也没人调用，所以「宿主默认查找」并不存在。

另有一个现成的冲突：侧栏 `SearchBox` 用 lobe `SearchBar` 的 `shortKey="mod+f"`，Ctrl+F 原本是「聚焦会话搜索」。

## Decision

### 范围和默认取舍

- 会话：当前会话**已加载**的全部消息（store 里有的），不跨会话，不含侧栏、页头等应用界面。文件：当前打开的文本文件（Markdown 预览、代码、编辑中的 Markdown）；图片、二进制、没打开文件时不能查，Ctrl+F 不拦。
- 代码块：算（它是正文的一部分）。折叠着的内容（思考、工具卡的参数和输出）：**默认不查**——没渲染出来的内容命中了也看不见、没法高亮；展开后渲染出来的部分会在 DOM 扫描时计入。已渲染但在视口外的消息：查得到、能跳过去。被虚拟化卸载（没渲染）的消息：按文字内容估算命中数，跳过去渲染后以 DOM 为准。
- 不区分大小写，按字面匹配（不是正则），不提供「区分大小写 / 全词 / 正则」开关；最多记 5000 处。

### 触发、归属、优先级

- Ctrl+F（macOS ⌘+F）由 `FindShortcutHost` 在 `window` 捕获阶段统一处理，`App.tsx` 挂一份。范围根元素带 `data-find-scope`：会话是 `chat`，文件标签是标签 id。
- 归属看键盘焦点在哪个范围里，**含底部输入框和编辑器**（它们没有自己的查找，所以仍然拦截）。焦点在 body（刚点了消息文字）时按「最后一次点击落在哪个范围」认领。焦点在范围之外（侧栏、设置页、终端）、弹窗里（`.ant-modal` / `.ant-drawer` / `role=dialog`）、范围当前不能查（文件标签没打开文本文件）：不拦。
- 优先级：捕获阶段处理并 `stopImmediatePropagation`，先于挂在 document 上的侧栏搜索框 Ctrl+F，也先于 CodeMirror 自己的 `Mod-f`。于是：**焦点在对话区 / 文件标签里，Ctrl+F 归查找栏；焦点在侧栏等其他地方，侧栏原有的「聚焦会话搜索」照旧**。没有宿主默认查找要让路。
- 已经打开时再按：只把焦点放回输入框并全选，不重置查询。有选中的单行文字（≤120 字）时打开预填它。

### 查找栏 UI（视觉）

「视觉伴侣」没有现成的查找栏规范，沿用已有组件基线：侧栏搜索框（small + filled 输入）、`ActionIcon` small（24px、hover 灰底）、文件查看器工具栏 36px 的节奏。方案由用户在视觉伴侣里确认：**A 通栏条，控件靠右**（备选 B 右侧浮卡被否决）。

- 40px 通栏（`FIND_BAR_HEIGHT`），容器底色 + 底边线，控件靠右：输入框（240px，可收缩到 96px，13px）→ 计数（12px、等宽数字、「当前 / 总数」）→ 分隔线 → 上一个 → 下一个 → 关闭，图标 lucide 14px、按钮 24×24 圆角 6px。
- 状态：默认（输入为空：不显示计数、跳转置灰）、悬停（输入框加深一档、按钮灰底）、聚焦（容器底色 + 主色描边 + 2px 柔光）、有结果、无结果（描边和计数变红、计数写「无结果」、跳转置灰）。`role="search"`，计数 `aria-live="polite"`。
- 不遮内容：会话里查找栏绝对定位在顶部，同时列表容器顶边下移 `FIND_BAR_HEIGHT`（列表本来就是 `absolute inset:0`、输入区悬浮在底部，所以等价于独立一行）；文件里是工具栏和内容之间的一行。
- 焦点：打开时进输入框并全选；Esc / 点 × 关闭时清高亮，焦点回到**打开前的元素**，它已经不在了就落到范围里的输入位置（`[contenteditable]`），再不行落到范围根。Esc 在输入框里 `stopPropagation`，别处的 Esc（停止生成、退出编辑）不跟着触发。

### 高亮（琥珀色）

- 用 **CSS Custom Highlight API**（`::highlight(gren-find)` / `::highlight(gren-find-current)`），**不改 DOM**：链接、行内代码、加粗里的命中都能高亮，原有格式不受影响；命中框的是文本片段（`Needles` 里只高亮前缀）。颜色在 `index.css` 的 `--gren-find-*`：深色 其他 `rgba(210,153,34,.35)`、当前 `#d29922` + 文字 `#0d1117`；浅色 其他 `rgba(255,212,0,.4)`、当前 `#ff9a1f` + 文字 `#1f2328`，对比度约 7.4~12:1。
- 限制：`::highlight` 只能改背景色和文字色，画不了描边，所以「当前项」靠更实的底色 + 高对比文字区分。
- 高亮颜色用户没有在视觉伴侣里作答，按推荐的琥珀色实现（蓝色备选未选）；需要改只动 `index.css` 的四个变量。
- 会话和文件预览可以同时在查，高亮注册表按查找器取并集，一个关闭不会清掉另一个的高亮。

### 引擎

- `findMatch.ts`：查询编译（转义、`giu`）、命中计数、`stripMarkdownForFind`（给没渲染的消息估算：去围栏行、反引号、粗体标记、链接 / 图片语法壳、行首记号；**不动单个 `*` / `_`**，标识符里有下划线）、`visibleItemText`（用户消息 + 助手正文；不含思考和工具卡）、`collectText`（把可见文本节点按文档顺序拼成串，跨块级元素插换行，于是 `par<b>tial</b>` 这种跨行内元素的词能命中而跨段落不会；跳过 `[data-find-ignore]`、脚本样式、被 CSS 隐藏的节点）。
- `DomFinder`：列表型（会话）按项计数，渲染出来的项以 DOM 为准并缓存（卸载后不回跳），没渲染的项用文字估算；游标是（项 id，项内第几处），内容变化（流式增长）时夹紧保持。`MutationObserver` + rAF 合并重算，但**只重扫变更落在其上的那一项**（`[data-find-item]`）；列表外的垫片、高度变化不触发重扫。估算文字或元素换了的项也会重扫，宽限期内没命中对齐的项到点再扫一次。上一个 / 下一个只改当前高亮，不再为移动游标重走 DOM；到项尾换项，走到头循环。当前项不在可见区就滚：嵌套滚动区改 `scrollTop`，列表自己走 `TranscriptScrollHandle.scrollBy`（会打断「贴底跟随」，否则流式输出会把视图拽回底部）；当前项所在消息没渲染就 `scrollToItem` 请列表滚过去，渲染后再精确定位，并在 300ms 后复查一次（virtua 的 `scrollToIndex` 测高后还会再滚一次）。整块型（Markdown 预览）没有分项，这块里的任何 DOM 变化都重扫整块。
- **懒加载内容的宽限期**：渲染出来的项 DOM 命中数比估算少时（代码块、图表是懒加载的，刚挂上来是空的），1.5 秒内仍按估算计，别把当前项判成「没命中」而重置游标；超过 1.5 秒还是少就以 DOM 为准（折叠等真实差异）。这条是 harness 里踩到的：跳到代码块那条消息时计数掉了 2 并被拽回第一处。
- `EditorFinder`：CodeMirror 只渲染视口内的行，DOM 扫不全，所以用它自己的 `SearchQuery` 在整份文档里数，当前项就是编辑器选区，跳转 = 移动选区并滚到视口中部。高亮交给 CodeMirror 的 `.cm-searchMatch` / `.cm-searchMatch-selected`（主题改用同一套 `--gren-find-*` 颜色）；CodeMirror 只在「搜索面板打开」时才画高亮，所以注册一个隐藏的占位面板（`search({ createPanel })` + `.cm-panels { display: none }`）来激活它。F3 / Mod-g 仍可用。
- `findStore`（zustand，按范围存 `open / query / status / focusNonce / nav`）和 `useFindDriver`：查找栏只写 store，驱动读 store 执行并把计数写回，所以会话、预览、编辑器共用同一个 `FindBar`。换会话 / 列表卸载关闭查找栏；文件标签里换文件，用同一查询重新查（`resetKey`）。
- 只有查找栏打开时才算消息文字（流式每 100ms 一次，平时不为它多遍历一遍整个会话）。缓存按消息 id 加正文字符串引用：`groupMessages` 每次都造新对象，但没改过的正文仍是同一条字符串，流式增长只重算正在写的那一条。
- `EditorFinder` 在文档连续变化时把重搜合并到 200ms 一次；换查询和上一个 / 下一个立刻用当前文档，不等这 200ms。编辑器按键不再逐次把整篇文档送进 React，见 [文件管理器多标签](./2026-10-23-file-manager-tabs.md)。

## Alternatives considered

- **Electron `webContents.findInPage`**。最强理由：零前端代码，原生高亮和跳转。不用：它查的是整个窗口（侧栏、页头、输入区也命中），不能限定会话；虚拟化卸载的消息查不到；高亮样式不可控、没法对齐视觉规范；Windows 下计数和当前项的回调也不能和我们的查找栏联动。
- **把命中包进 `<mark>`（改 DOM）**。最强理由：任何浏览器都支持，样式随意。不用：要拆开文本节点，破坏链接、代码高亮、Markdown 渲染产物，React 下重渲染还会与 DOM 打架；流式输出每 100ms 重渲，改 DOM 的方案要不停撤销重做。
- **只按 store 里的消息文字计数（不看 DOM）**。最强理由：覆盖全部已加载消息、不受虚拟化影响，计数稳定。不用：消息是 Markdown，源文本和渲染文本不一样（链接地址、语法记号），命中数对不上；折叠 / 展开的内容也无从知道。所以只对没渲染的消息估算，渲染后以 DOM 为准。
- **只扫 DOM（不估算）**。最强理由：实现最简单、永远和所见一致。不用：虚拟化只挂视口 ± 800px，长会话里大部分消息扫不到，「第 n / 共 m」毫无意义，也没法循环跳到屏幕外。
- **每次 DOM 变化都重扫所有已渲染项**。最强理由：不会漏掉「展开思考」这种估算文字没变、DOM 变了的情况，实现也简单。不用：查找开着时，流式输出会让每一帧都走完整个可见会话的文本节点。变更记录能定位到具体的 `[data-find-item]`；估算文字或元素换了的项另外重扫，宽限期没对齐的项到点再扫。
- **布局方案 B：右侧浮卡**。最强理由：更像浏览器，视觉更轻。不用（用户选 A）：为了不遮内容仍要预留一整行，左边一大块是空的，浮卡反而多占视觉。
- **文件里的代码编辑器用 CodeMirror 自带搜索面板**。最强理由：零代码，支持正则 / 全词 / 替换。不用：样式和应用对不上，计数、Esc、焦点归属都和会话里的行为不一致；本期要统一体验。保留了 F3 / Mod-g。
- **为查找栏新开一个全局状态机**（而不是 store + 驱动分离）：没有选，两种内容类型（DOM / CodeMirror）的查找器实现完全不同，分离才能共用一个栏。

## Consequences

- 收益：会话和文件里都能 Ctrl+F，一套栏、一套高亮色、一套键盘约定；不改 DOM，Markdown / 链接 / 代码渲染不受影响。
- 已知限制：
  - 没渲染的消息命中数是估算，工具卡标题等「文字估算里没有、DOM 里有」的命中，滚到那里渲染后总数才会加上；折叠内容默认不查。计数在滚动过程中可能小幅变化（以 DOM 为准的项越来越多）。
  - Markdown 编辑模式（左右分栏）下查的是编辑器，预览里不高亮；预览模式才查预览。
  - 跨块级元素的查询不会命中（段落之间隔着换行）；查询里不支持换行。
  - 不支持正则、全词、区分大小写、替换；最多 5000 处。
  - 文件树的筛选框（在文件标签范围内）按 Ctrl+F 也会打开文件查找而不是聚焦别处，这是「范围内一律拦」的代价。
  - 侧栏的 Ctrl+F 只在焦点落在会话 / 文件标签之外时生效。
  - 主面板右侧的内置浏览器、终端不在范围内。
- 共享代码的影响面：`VirtualizedMessageList` 的 `TranscriptScrollHandle` 多三个**可选**方法（`scrollToItem` / `getRoot` / `getScroller`），每行多一个 `data-find-item` 属性；`ChatView` 根加 `data-find-scope`、列表容器 `top` 随查找栏下移；`ChatListView` 挂 `useSessionFind`；`CodeEditor` / `MarkdownPreview` / `FileViewer` / `FileExplorer` 多可选 props 并接入；`CodeEditor` 的 `.cm-searchMatch` 主题颜色改了；`index.css` 多 `--gren-find-*` 和两条 `::highlight`；`App.tsx` 挂 `FindShortcutHost`。没有新增依赖（`@codemirror/search` 本来就在）。
- 历史：冻结的 `docs/superpowers/archive/specs/2026-06-28-chat-rendering-perf-design.md` 写过「不做 find-in-page」，本篇之后该前提不再成立；那篇是冻结历史，不改。

## Verification

- 视觉方案：`.agents/evidence/2026-10-23-find-in-session-and-file/visual-design.html`（视觉伴侣，用户选 A 并要求控件靠右）。
- `cd electron-agent && npx vitest run src/features/chat src/features/find src/features/fileExplorer src/features/dock src/features/layout src/features/links`：160 个文件 1180 条通过。其中 `src/features/find` 的 `findMatch.test.ts` / `domFinder.test.ts` / `FindBar.test.tsx` / `FindShortcutHost.test.tsx` 共 48 条：计数、字面匹配、跨行内元素命中、不跨块、懒加载宽限期、两个查找器高亮并集、焦点归属、Ctrl+F 归属规则。
- `npm run ui:check -- chat-find file-explorer`：通过，`chat-find` 71 条 + `file-explorer` 174 条（含原有的）0 失败，日志 `.agents/evidence/2026-10-23-find-in-session-and-file/ui-check.log`，截图在同目录 `shots/`。真实键鼠事件下：焦点在底部输入框时 Ctrl+F 拦截并把焦点放进查找栏、范围外输入框的 Ctrl+F 不被抢、点了消息文字后按最后点击的范围认领；查找栏占独立一行不压消息不碰输入区、控件靠右；80 条消息里 9 处命中（大部分没渲染）计数正确，逐个跳转每一步当前项完整可见、末尾循环、第 6 处在代码块里（离屏消息）精确定位；加粗 / 行内代码 / 链接 / `Needles` 前缀都高亮且 DOM 里没有 `mark`；无结果空状态、改查询回到第一个、新消息到来计数 +2、Esc 关闭清高亮并把焦点还给输入框、换会话关闭、浅色主题高亮色；文件里 Markdown 预览（滚到可见、循环、无结果、Esc 焦点回预览）、代码编辑器（CodeMirror 高亮与选区、只读不改文档、不是默认面板）、开着查找栏切文件重新查、图片不拦。
- 没覆盖到：`ChatView.tsx` 自己的布局接入（根的 `data-find-scope`、列表 `top` 下移、查找栏位置）harness 里是按它的结构复刻的，没有挂真实 `ChatView`（它依赖整套 store 和 pi 桥）；未在真实 macOS 上验证 ⌘+F；长会话（上千条）的查找性能没有实测。
- 增量扫描（2026-10-26）：`cd electron-agent && npx vitest run src/features/find src/features/fileExplorer src/features/chat` 131 个文件、980 条通过。`npm run ui:check -- chat-find file-explorer` 230 条通过、0 失败（126.7s）。单测覆盖：只重扫变更的那一项、上一个 / 下一个不再整表重扫、正文引用没变时不重新剥离、编辑器查找 200ms 合并重搜且跳转立刻用最新文档。
- 开发中的环境说明：验证期间另一路改动（计划模式）暂时让 `PlanCard` / `PlanPanel` 缺失，harness 构建失败；当时在一份隔离副本里（把被删的 `PlanCard.tsx` 从 HEAD 补回）跑通，该路改动落盘后又在主工作区复跑，上面的结果是主工作区的。
