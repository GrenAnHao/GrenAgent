# Agent Note: 代码索引页的结果列表有高度上限，分页渲染

Status: implemented

## Problem

Agent 数据 → 代码索引页，搜索框留空时走 `codegraph_files`，一次返回项目里所有被索引的文件，前端全部渲染成按钮，页面随之长到几万像素。三处叠在一起：

- 布局没有高度约束。`CodeRetrievalPanel` 的根节点是普通块，分栏 `SplitPane` 只有 `min-height: 440px`、没有上限。栏上的 `overflow: auto` 因为网格行跟着内容长，永远不生效，撑长的是外层 `AgentDataCenter` 的整个面板。记忆页用的是「填满剩余高度」布局（`memoryStyles.fill` / `split`），所以没有这个问题，代码页没跟上。
- 结果不分页。antd `Listy` 默认 `virtual=false`，传多少行画多少行。`codegraph_files` 没有 limit，搜索是 `limit: 20` 所以没事。
- 「原始结果」的 `<details>` 折叠着也在 DOM 里：每次渲染都对整份结果 `JSON.stringify` 一遍，再塞进一个没有高度限制的 `<pre>`。几千个文件的结果里这份 JSON 是兆级。

harness 里造 3000 个文件复现：分栏底边在 272742px，3000 个行按钮全在 DOM 里。

## Decision

### 布局：代码页和记忆页一样填满剩余高度

`codeStyles.root` 是 `display: flex; flex-direction: column; height: 100%`，搜索 + 分栏的卡片加 `codeStyles.fill`（`flex: 1; min-height: 320px; overflow: hidden`），`SplitPane` 加 `codeStyles.split`（`&& { min-height: 0 }` 盖掉分栏的 440px 下限）。左栏结果列表和右栏详情各自在栏内滚动，外层面板不再被撑长。`fill` 的 320px 下限是给矮窗口留的：放不下时由外层面板滚动，而不是把列表压成一条缝。这两个类和 `memoryStyles` 里的写法相同，各自留在自己的样式文件里，没有抽到 `workbenchStyles`，避免这次顺带改记忆页。

### 渲染：结果行一页 100 条，「显示更多」逐页追加

`CodeResultContent` 把行交给 `ResultRows`，一次只画 `RESULT_PAGE_SIZE = 100` 行，尾部「显示更多（还有 N 项）」每点一次多画一页，样式沿用记忆页列表尾部的分页按钮。已展开的页数放在 `ResultRows` 自己的 state 里，由调用方用 `key` 决定什么时候重置：`CodeRetrievalPanel` 的 key 是 项目 + 查询工具 + 查询词，换项目 / 换查询词 / 换模式回到第一页；同一个查询因为索引同步完成而重读，新的结果对象不会让用户展开的页数掉回去。`CodeRelations` 的 key 是它自己的 `workspace + 符号 + 文件 + 页签`。

### 原始结果：展开才序列化，有高度上限，超长截断

`RawResult` 监听 `<details>` 的 `toggle`，展开后才 `JSON.stringify`（`useMemo`，折叠即丢弃），`<pre>` 套上 `codeStyles.raw`（原先没人用的死样式，补了 `max-height: 420px; overflow: auto`）。展开后最多显示 `RAW_PREVIEW_LIMIT = 200000` 个字符，超出的截掉，并写「已截断：显示前 200000 个字符，共 N 个字符」。

涉及文件：

- `electron-agent/src/features/agentData/codeStyles.ts`
- `electron-agent/src/features/agentData/CodeRelations.tsx`
- `electron-agent/src/features/agentData/CodeRetrievalPanel.tsx`

## Alternatives considered

- **虚拟列表（`Listy` 的 `virtual` 模式）** — 最强的理由：滚动到哪画到哪，不需要「显示更多」，一次性浏览几万个文件也顺。否掉：`virtual` 需要传一个像素值的 `height`，要自己用 ResizeObserver 量容器；我们的行是多行、高度不一的按钮，要依赖 `rc-virtual-list` 的测高，选中态和焦点恢复（`resultTrigger.current.focus()`）也要跟着虚拟化重写。而这页本来就是「搜符号」为主，没有人会真的逐个翻几千个文件。分页和记忆页同一套交互，改动面小。浏览量继续涨到分页不够用时再重访。
- **在主进程给 `codegraph_files` 加 `limit` / `offset`** — 最强的理由：数据也不用全量过 IPC，是真正的「不全量加载」。否掉：要改 `codeRetrievalProtocol` 的参数白名单、`listFiles`、`CodeArgsByTool` 类型和相应测试，是跨文件契约改动；而文件列表本来就在 SDK 的内存里，几千条行过一次 IPC 是毫秒级，慢的是 DOM 和 stringify，这次已经去掉。当时留作后续，之后在[文件列表由主进程分页返回，大文件源码预览虚拟化](./2026-10-14-code-index-paged-files-and-virtual-source.md)里采纳了。
- **只给侧栏加 `max-height`** — 最强的理由：一行样式就能让列表不再撑页。否掉：详情栏、窄视口、`w.empty` 空状态各有各的高度来源，分别打补丁比对齐到记忆页已验证的填满布局更乱；也解决不了 3000 个按钮全在 DOM 里。

## Consequences

- **收益**：空查询浏览 3000 个文件的项目，DOM 里是 100 行而不是 3000 行；页面高度由窗口决定，外层面板不再出现整页滚动；展开原始结果不再卡住，折叠时一次 stringify 都不做。
- **代价与已知上限**：想看第 N 个文件要连点「显示更多」，没有按位置跳转，实际靠搜索或 `pattern` 缩小范围；`RAW_PREVIEW_LIMIT` 只是显示层截断，不影响数据本身。文件列表全量过 IPC、源码预览整个文件全画这两处，由[后续那篇](./2026-10-14-code-index-paged-files-and-virtual-source.md)处理：文件列表改为主进程分页，前端切页只留给没有分页信息的结果；超过 1000 行的源码预览改为虚拟化。

## Verification

结果：通过。证据都在 `.agents/evidence/2026-10-14-code-index-bounded-list/`。

- 先写测试再改：`cd electron-agent && npx vitest run src/features/agentData/CodeRelations.test.tsx src/features/agentData/CodeRetrievalPanel.workbench.test.tsx`，把三个源文件还原到改之前，新增的 7 条里 6 条失败（「不足一页没有按钮」新旧代码都通过），日志 `vitest-red-before-fix.txt`；覆盖：分页一页 100 行、点一次多一页、不足一页没有按钮、换 key 重置、同 key 重读不重置、面板里空查询 250 个文件只画 100 个且换成搜索后重置、原始结果展开前不序列化、超长截断。
- 改之后 `npx vitest run src/features/agentData`：29 个文件 351 条全部通过，日志 `vitest-agentdata.txt`。
- 新增 ui-harness 场景 `code-retrieval-panel`（真实 `CodeRetrievalPanel` + `AgentDataTaskProvider`，外面套 `AgentDataCenter` 的 `styles.panel`，主进程用桩，项目 3000 个文件）：`npm run ui:check -- code-retrieval-panel` 33 条全部 PASS，日志 `ui-check-code-retrieval-panel.txt`。覆盖：只画第一页、外层面板不被撑长、列表在栏内滚动、滚到底点得到「显示更多」、追加一页、原始结果高度 ≤ 422px 且标注已截断、换搜索后重置、详情栏同高并在栏内滚动、窄视口只显示详情栏时同样有上限。改之前同一个场景失败（3000 个按钮、分栏底边在 272742px），日志 `ui-check-code-retrieval-panel-before-fix.txt`。只跑了这一个场景。
- 渲染层类型检查：临时 tsconfig 只含 `CodeRelations.tsx`、`CodeRetrievalPanel.tsx` 和新场景，这三个文件没有类型错误；其余报错来自间接引入的 `electron/*`（临时配置没带 node 类型），与本次改动无关。
