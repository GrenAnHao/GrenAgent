# Agent Note: 代码索引页的文件列表由主进程分页返回，大文件源码预览虚拟化

Status: implemented

## Problem

承接[代码索引页的结果列表有高度上限，分页渲染](./2026-10-14-code-index-bounded-list.md)。那一篇把页面限了高、结果行在前端切页，留下两处仍是「全量」：

- 文件列表全量过 IPC。搜索框留空时 `codegraph_files` 没有 `limit`，主进程把整个项目的索引文件（几千条）一次返回，前端拿到后才切页。DOM 的问题解决了，数据还是全量搬一遍，响应里的 `text` 和 `structuredContent` 各带一份。
- 源码预览全量渲染。`CodeSourceDetail` 把整个文件逐行画成 `div + span + code`。`read_file` 的上限是 512KB，但短行文件 512KB 可以有两万行，六万个节点，再加折行排版；预览框只是 `max-height: 520px`，节点数一个没少。

## Decision

### `codegraph_files` 由主进程分页

`codeRetrievalProtocol` 的 `codegraph_files` 白名单放行 `limit` / `offset`，校验沿用通用的整数规则（`limit` ≥ 1，`offset` ≥ 0）。`listFiles` 先按 `path` / `pattern` / `maxDepth` 过滤、排序，再取 `slice(offset, offset + min(limit, MAX_FILE_PAGE))`，`MAX_FILE_PAGE = 500`，防止调用方一次要走整张表。响应的 `structuredContent.extra.page` 是 `{ offset, total }`，`total` 是过滤之后的总数，调用方据此判断还有没有下一页。不传 `limit` 仍返回全部（`page` 照样带），没有改变不分页的调用方的行为。

### 客户端：已加载的页就是要画的全部行

`codeResult` 把 `extra.page` 解成 `CodeResultView.page`；偏移或总数不是非负整数就当没有。`appendCodeResultPage` 把下一页并到已加载的行后面，总数取最新一页，`raw`（「原始结果」）是最近一次返回的那一页。

面板请求文件列表时带 `limit: CODE_PAGE_SIZE`（100）。结果带 `page` 时，`CodeResultContent` 走 `more`：画全部已加载的行，「显示更多（还有 N 项）」不再在前端切页，而是向面板要下一页；请求中按钮置灰、写「正在加载…」。是否走 `more` 由结果有没有 `page` 决定，不由「还剩多少」决定：最后一页到了，`remaining` 为 0，按钮消失，但行不会退回前端切页（第一版这里写成了「还有剩余才传 `more`」，最后一页追加完列表缩回 100 行，由面板层的测试抓出来）。没有 `page` 的结果（搜索、相关上下文、调用关系，或不带分页信息的旧服务端）仍走上一篇的前端切页。

`loadMoreFiles` 不递增 `queryEpoch`。`queryEpoch` 只由查询 effect 的清理、换项目、刷新、重新可见递增，所以到达时已过期的下一页被丢弃，不会落进别的查询的结果里。请求失败（抛错或 `isError`）时保留已加载的行，错误显示在列表上方，按钮还在，可以重试；成功后清掉错误。索引同步完成触发刷新，列表回到第一页。顶部「N 个结果」用 `page.total`。

两次取页之间索引变了，按 `offset` 接上去会跳行或重复。下一页返回的 `page.total` 和已加载结果的不一样，就判定索引变过，不追加，整个重读（`setStatusVersion`）回到第一页。总数不变但内容变了（一增一减）检测不到。

`changeQuery` / `changeMode` 不再手动递增 `queryEpoch`。查询真的变了，查询 effect 的清理会递增；没变的时候（只敲了空格、空查询下切模式）effect 不重跑，手动递增只会让在途的响应被丢掉而没有新请求顶上，列表卡在「正在查询…」，下一页的按钮卡在「正在加载…」。这是独立审查指出、再用测试复现的（第一页本来就有这个隐患，分页多了一个受害者）。查询 effect 的依赖、请求参数和列表的 `key` 统一用去掉首尾空白的 `queryText`，只敲空格不会重取第一页把已加载的页覆盖掉。

请求中的「正在加载…」按钮用 `aria-disabled`，不用 `disabled`：刚按下的按钮被禁用，键盘用户会丢焦点；也没用 antd 的 `loading`，它的图标带 `aria-label="loading"`，会混进按钮的可访问名。

### 源码预览：超过 1000 行才虚拟化

新增 `CodeSourceLines`，`CodeSourceDetail` 里原来整块的 `<pre>` 换成它。行数 ≤ `VIRTUALIZE_LINE_THRESHOLD`（1000）整块渲染，在预览里整段选中、复制照旧可用；超过则用 virtua 的 `Virtualizer`（`data` + 函数子元素，只为窗口里的行创建元素）。滚动容器仍是 `pre` 自己（`max-height: 520px; overflow: auto`），经 `scrollRef` 交给 `Virtualizer`；行按预览宽度折行、高度不一，由 `Virtualizer` 测量。

跳到某一行统一走 `CodeSourceLines` 的 `scrollToLine(line)`：长文件按下标 `scrollToIndex(line - 1, { align: 'center' })`，因为目标行可能根本没挂在 DOM 里；短文件在预览里找 `[data-source-line="N"]` 调 `scrollIntoView`。行不在文件里就什么都不做。`CodeSourceDetail` 的 `lines` 用 `useMemo` 固定，输入行号时不再每次重新切一遍文件。样式里的行选择器从 `> div` 改成 `[data-source-line]`，两种渲染共用。

涉及文件：

- `electron-agent/electron/agentData/codeRetrievalProtocol.ts`
- `electron-agent/electron/app/codeGraph/codeGraphQuery.ts`
- `electron-agent/src/lib/agentData.ts`（`codegraph_files` 参数类型）
- `electron-agent/src/features/agentData/codeResult.ts`
- `electron-agent/src/features/agentData/CodeRelations.tsx`
- `electron-agent/src/features/agentData/CodeRetrievalPanel.tsx`
- `electron-agent/src/features/agentData/CodeSourceLines.tsx`（新）、`CodeSourceDetail.tsx`、`codeStyles.ts`

## Alternatives considered

- **源码预览始终虚拟化，不设阈值** — 最强的理由：只有一条渲染路径，行为一致，不用维护阈值。否掉：虚拟化后 DOM 里只有窗口附近的行，在预览里全选复制、浏览器页内搜索都只能碰到已挂载的行；绝大多数文件不到 1000 行，没必要为它们付这个代价。阈值以下保持原样，也让原有的源码预览测试不用动。
- **`white-space: pre` 不折行 + 固定行高，自己算窗口** — 最强的理由：定高行不需要测量，不依赖 ResizeObserver，实现最简单。否掉：预览框只有半屏宽，不折行就要横向滚动，而现在的折行（`pre-wrap` + `overflow-wrap: anywhere`）是明确选的；为了好实现改掉显示方式不划算。`Virtualizer` 本来就能测变高的行。
- **每行加 `content-visibility: auto`** — 最强的理由：纯 CSS，不引入虚拟化逻辑。否掉：屏幕外的行只是跳过排版和绘制，DOM 节点还在，React 创建六万个节点的代价和内存都没变，只解决了一半。
- **滚到列表底自动取下一页** — 最强的理由：不用点按钮。否掉：列表是栏内滚动，触底触发要自己接滚动阈值，和记忆页列表尾部「显示更多」的交互也不一致；点击有明确的「正在加载」「失败可重试」状态，滚动触发要另外处理。

## Consequences

- **收益**：打开代码索引页，主进程只返回第一页 100 条，和项目有多少文件无关；12000 行的源码预览 DOM 里只有窗口附近的约 35 行，不是 12000 行，跳到任意行、滚到头尾都正常。
- **代价与已知上限**：
  - 长文件（> 1000 行）的预览里，整段选中复制和浏览器页内搜索只对已挂载的行有效；预览没有「复制全文」按钮，需要时另加。
  - 文件列表一路点到底，已加载的行只增不减，3000 个文件时 DOM 里是 3000 个按钮；没有回收已翻过的页。要的是「不用一次性全画」，不是「永远只画一页」。
  - 分页是 offset 式。两次取页之间索引变了，总数不同就整个重读回到第一页；总数不变但内容变了（一增一减）检测不到，页边界会错位一次，下一次刷新后恢复。每取一页主进程都要重新过滤、排序整张文件表，超大项目里是 O(N log N) 的开销。
  - `codeStyles.fill` 的 `&&` 是预防：同一元素上还有 `workbenchStyles.panel` 的 `min-height: 0`，同优先级规则谁生效取决于样式表插入顺序。没加 `&&` 时 harness 里下限也生效，这条没有失败证据。
  - 「原始结果」只含最近一次返回的那一页。
  - 页面里 virtua 会在控制台打 `ResizeObserver loop completed with undelivered notifications`，这是浏览器对「观察回调里又改了布局」的良性提示，harness 已在 `ignoredPageErrors` 里忽略，聊天列表一直如此。

## Verification

结果：通过。证据在 `.agents/evidence/2026-10-14-code-index-paged-files-and-virtual-source/`。

- 先写测试再改，主进程：`cd electron-agent && npx vitest run electron/agentData/codeRetrievalProtocol.test.ts electron/app/codeGraph/codeGraphQuery.test.ts`，改之前新增的 6 条失败（分页、总数、越界、不传 limit、先过滤再分页、一页最多 500），日志 `vitest-server-red-before-fix.txt`。改之后协议、`codeGraph/`、桥接共 9 个文件 121 条通过，日志 `vitest-server-green.txt`。
- 先写测试再改，渲染层：`npx vitest run src/features/agentData/codeResult.test.ts src/features/agentData/CodeRelations.test.tsx src/features/agentData/CodeRetrievalPanel.workbench.test.tsx src/features/agentData/CodeRetrievalPanel.test.tsx`，改之前 14 条失败（含 3 条改成 `limit: 100` 的旧断言），日志 `vitest-client-red-before-fix.txt`。覆盖：`page` 解码、下一页追加、`more` 画全部已加载的行并向调用方要下一页、请求中不重复发、换查询后晚到的页被丢、失败保留行并可重试、MCP 错误不追加、刷新回到第一页、一路翻到最后一页行数不缩回。`CodeSourceLines.test.tsx` 另有 10 条：短文件整块渲染、长文件交给虚拟化（jsdom 没有布局，真的 `Virtualizer` 一行都不挂，用带窗口的替身）、跳转走 `scrollToIndex` / `scrollIntoView`、越界行不动。
- 全部相关测试：`npx vitest run src/features/agentData src/lib/agentDataCodeBridge.test.ts electron/agentData/codeRetrievalProtocol.test.ts electron/app/codeGraph` 39 个文件 498 条通过，日志 `vitest-final.txt`。`electron/agentData` 目录里另有 10 条失败（`auditViewStore` / `jobCleanup` / `runtime`，报 `wiki.replace` 等管理方法不存在），在没有这次改动的基线上同样失败，与本次无关。
- `npm run ui:check -- code-retrieval-panel`：61 条全部 PASS，日志 `ui-check-code-retrieval-panel.txt`（54 秒，一路点 30 页占大头）。覆盖：文件列表只向主进程要一页、一共 30 次请求每次一页、没有一次返回超过一页、一路点到底 3000 个全在且「显示更多」消失、12000 行大文件窗口约 35 行、索引行居中、跳到第 9000 行居中、折行长注释行高不一且不重叠、滚到头尾都对、矮窗口保住 320px 下限且由外层面板滚动、窄视口仍有上限。把虚拟化阈值临时调到极大（等价于旧的整块渲染）再跑，同一场景 4 条失败（12000 行全在 DOM 里），日志 `ui-check-code-retrieval-panel-virtualization-off.txt`；把 `fill` 的下限拿掉再跑，矮窗口那两条失败（142px），日志 `ui-check-code-retrieval-panel-floor-removed.txt`。只跑了这一个场景。
- 独立审查（另起的 agent，只读，没有被告知我的结论）指出 4 处缺陷，逐条对着代码核实后，用测试复现 5 条（改之前失败，日志 `vitest-review-fixes-red-before-fix.txt`），修复后 `npx vitest run src/features/agentData` 30 个文件 381 条通过，日志 `vitest-agentdata-after-review-fixes.txt`：空查询下切模式、在途请求被丢弃后列表卡在加载中；只敲空格重取第一页并覆盖已加载的页（两条）；请求中按钮 `disabled` 让键盘用户丢焦点；两次取页之间总数变了仍按 offset 追加。审查还提到 `fill` 与 `workbenchStyles.panel` 的同优先级冲突，没能复现，`&&` 作为预防保留。
- 整个渲染层测试：`npx vitest run src` 314 个文件 2473 条通过，日志 `vitest-full-src-before-review-fixes.txt`；这一次在审查修复之前跑的，修复只动了 `agentData` 目录，那个目录改后单独重跑见上一条。
- 渲染层类型检查（临时 tsconfig，只含改动的文件和新场景）：这些文件没有类型错误。抓到过一处 `currentResult.loadingMore` 缺 `?.`，已修；其余报错在 `electron/agentData/wikiEngine`、`agentData.ts` 的 `jobs.create` / `MemoryScope`，不是这次改的。
