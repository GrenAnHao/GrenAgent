# Agent Note: 文件管理器：普通对话也有、Markdown 链接不再跳走应用、链接走内置浏览器、显示路径

Status: implemented

## Problem

四件事绑在同一个「文件」标签上：

1. 右侧栏的「文件」标签只对项目会话开放。`launcherItems` / `canOpenLauncherKind` 把「普通对话」（工作目录在 `worksDir` 下的临时会话）当成 casual，只给浏览器和终端；agent 在对话目录里生成了文件也没地方看。
2. 在文件管理器里预览 Markdown 点链接，浏览器默认行为生效：`<a href>` 按应用页面的地址补全，整个应用窗口被导航走（或 `target=_blank` 弹出新的 Electron 窗口）。主窗口没有 `will-navigate` / `setWindowOpenHandler`，渲染进程里也没人拦。
3. 对话消息里的链接同理，而且「在内置浏览器里看」这件事应用早就有（右侧栏浏览器标签、`persist:gren-browser` 分区），只是没有入口把链接交给它。
4. 文件管理器只在内容区工具栏有一条面包屑，窄栏里被裁掉，不能悬停看全、不能复制，文件树里悬停某一行也看不到它的路径。

## Decision

### 1. 普通对话也有「文件」标签

- casual 会话的启动项是 浏览器、终端、文件（`launcherItems.ts`）；仍然没有「审查」（普通对话没有 git 仓库）。`canOpenLauncherKind` 只对 casual 拦 `review`。没有目录（`workspace` 为空）时「文件」置灰。
- 文件标签、Ctrl+P、`openWorkspaceFile` 都走原来的 `openLauncherTab`，没有为 casual 另写一套：标签的 `workspace` 就是对话自己的目录，主进程 `safeWorkspacePath` 以它为沙箱根。
- 文件浏览器仍然只有一份实现（`FileExplorer`）。同一会话、同一 region、同一工作区只有一个标签（`findExisting` 去重）；右栏标签各会话一份（见 [右侧边栏跟会话走](../bug-fix/2026-10-16-right-dock-session-binding.md)），所以选中项、展开状态、目录**不需要也不会**在标签之间同步：每个标签有自己的 `useFileTree` / `useOpenFile`，互不影响。外部入口（交付卡、审查、对话里的文件链接）只经 `fileOpenRequests` 把一个路径交给已有标签。

### 2. Markdown 预览里的链接

- `MarkdownPreview` 在容器上用 `onClickCapture` / `onAuxClickCapture` 拦所有 `a[href]` 并 `preventDefault`，所以应用不会跳转。读的是 `getAttribute('href')` 原文，不是补全后的 `a.href`。
- 分类放在 `lib/hrefKinds.ts` 的 `classifyHref`（对话和预览共用）：`anchor` / `external` / `path` / `unsupported`。`resolveMarkdownLink` 在此之上把相对路径落到项目内：以当前文件所在目录为基准处理 `./`、`../`、`%20`（解码）、`?query`（丢弃）、`#hash`（跨文件时丢弃）、反斜杠、盘符、`/` 开头（项目内绝对路径原样用，否则当相对项目根）；越过项目根返回 `unsupported`。
- 落地：
  - 锚点：在预览容器内滚动（先按 id / name，再按标题文字的 GitHub 风格 slug 匹配），找不到弹「文档里没有找到锚点」。
  - 项目内文件：`findProjectEntry` 列父目录确认存在（不读文件内容，大小写不敏感回退），再走和点文件树同一条 `useOpenFile.open`（未保存询问、同文件不重载都在里面），并用 `revealInTree` 展开祖先。`revealInTree` 也取代了外部打开请求里原来内联的那段，两处共用。
  - 指向目录：只在树里展开，提示「是目录」。
  - 不存在：提示「找不到链接指向的文件」，不动当前文档。
  - 网页：`openInAppBrowser`；Ctrl / ⌘ 点击改用系统浏览器。
  - 其余协议（mailto、javascript、file:、data: …）：提示「暂不支持 xxx: 链接」。
- 被链接包住的图片（徽章）点图片和点文字一样。

### 3. 链接走内置浏览器

- 承载形态：右侧栏的浏览器标签（已有的 `BrowserBody`，不新做模态）。地址栏、后退、前进、刷新、关闭（标签的 ×）都是现成的；加载失败进 `browserErrorPageUrl` 的错误页并可重试；登录状态在 `persist:gren-browser` 分区里跨标签保留，站点自己的登录页直接在标签里完成。
- `openInAppBrowser(url)`：只认 http(s)；当前会话已有同地址的浏览器标签就切过去，否则新开一个标签（标题是主机名），标签归属当前会话。新开而不是覆盖，避免丢掉正在看的页面；同地址不重开，避免堆标签。
- 全局兜底 `AppLinkGuard`（`App.tsx` 挂一份）：document 冒泡阶段接手所有没被别人 `preventDefault` 的 `a[href]`，由 `routeAppLink` 分流：网页→内置浏览器；项目内文件路径→`resolveSessionFile` + `openWorkspaceFile`（右侧「文件」标签）；锚点→静默吞掉；其余→提示。冒泡而不是捕获，是为了让「先处理的人说了算」：文件预览自己的处理、带自有 `onClick` 的链接都不会被重复处理。
- 主进程第二道防线 `electron/mainWindowNavigation.ts`：主窗口 `will-navigate` 到非应用页面一律拦下、`setWindowOpenHandler` 一律 `deny`；网页链接经已有的 `browser-open-url` 事件转给渲染进程开内置标签，其它协议丢弃。`isSameAppPage` 只比协议、主机、路径，hash / query 变化（应用内路由）不算离开。
- 「在系统浏览器中打开」的次要入口：Ctrl / ⌘ 点击链接（和内置浏览器里页面链接的既有约定一致）；`BrowserBody` 工具栏新增「在系统浏览器中打开」按钮（空白页置灰）；页面里右键「在外部浏览器打开链接」本来就有。

### 4. 路径展示

- 位置：文件树面板底部的路径栏 `FilePathBar`（树面板里，不占内容区）。悬停行优先，没有悬停显示选中项（当前查看的文件）；都没有给提示语。
- 默认相对项目根（`/` 连接，项目根自己写 `.`），可用栏上的「相对 / 绝对」按钮切到绝对路径，偏好记在 `filePathModeStore`（localStorage `pi-file-path-mode`），所有文件标签共用。不在项目根下的路径永远给绝对路径。
- 窄栏：省略号只吃目录部分，文件名始终完整；完整值在悬停提示里；复制按钮复制「栏里当前这一行」，复制后图标变对勾 1.5 秒，剪贴板不可用时弹错误提示。
- 悬停状态由面板 `onPointerLeave` 清，不由行清：鼠标从某一行移到路径栏时仍保留那一项，所以目录也能悬停后复制。
- 多选：文件树目前是单选（选中跟着打开的文件走，目录不会被选中）。`summarizePaths` 已按多项设计：栏里写「已选 N 项」，提示列前 10 项，复制一行一个；现在只会传入 0 或 1 项。
- 内容区工具栏的面包屑改为紧凑型（见下），完整路径由路径栏负责。

### 工具栏：面包屑紧凑 + 后退 / 前进 / 刷新

- 面包屑原来 `flex: 1` 铺满整行，把模式 / 保存挤到边上。现在只占自己需要的宽度（`flex: 0 1 auto`），只显示末尾两级，再前面折成 `…`（悬停提示给完整路径），每级有宽度上限、超长省略；右侧按钮组 `margin-inline-start: auto` 靠右，窄面板一行放不下时折到下一行（`flex-wrap`），不再被裁掉。
- 后退 / 前进 / 刷新三个按钮在工具栏最左，快捷键 Alt+← / Alt+→ / F5（只在文件标签里生效；不占 Ctrl+R，避免和应用重载冲突；Alt+← / → 已被 CodeMirror 处理（`defaultPrevented`）时不当导航）。没有打开文件（空闲 / 加载中 / 打开失败）时工具栏也在，否则打开了缺失文件就退不回去。
- 鼠标侧键和键盘的浏览器前进 / 后退键也绑定到这两个动作。两条通路：① 渲染进程在文件浏览器根元素上接 `mouseup` 的 button 3（后退）/ 4（前进），并在 mousedown / mouseup / auxclick 上 `preventDefault`；② Windows / Linux 上侧键和键盘的浏览器前进后退键以 `app-command` 送到主窗口（`forwardAppCommands`），主进程经 `app-nav` 事件转给渲染进程，`fileNavBus.routeNavigation` 按「鼠标正悬停 → 键盘焦点所在」的顺序找一个看得见的文件浏览器认领，没人认领（侧键按在对话区、浏览器标签上）就什么都不做。同一次按键可能两条通路都送达，同方向 250ms 内只认一次（`triggerNavigation`）。因为没有在真实 Windows 窗口里用真实鼠标验证过「两条通路是否真的同时到达」，去重是保险而不是已知事实；代价是快于 250ms 的连续两次同方向侧键会被当成一次。macOS 上没有 `app-command`，只有第①条。
- 历史（`useFileHistory`）：监听「当前打开的是哪个文件」，变了就记一条，点文件树 / md 内链 / 外部请求都算；前进后退走和点文件树同一条 `open`。有了文件标签以后，这条 `open` 是「切到或新开标签」，不再替换当前文件、也不再问未保存修改，切标签也记入历史，见 [文件管理器：改名并支持多文件标签](./2026-10-23-file-manager-tabs.md)。在中间打开新文件截掉前进栈，最多 50 条，只放内存、随文件标签消失。历史只记文件，不记滚动位置。
- `useOpenFile.open` 的返回值由 `void` 改为 `boolean`（true：现在打开的就是这个路径；false：未保存询问被取消或被后来的 open 顶掉）。原因：历史最初用「open 结束就清 pending」判断是否切过去，单测里发现 open 先于渲染返回时，后退会被误当成新打开、前进栈被截掉；现在 effect 和 open 的返回值两边都能落定指针（幂等）。
- 刷新：把文件树里已列出的目录重新列一遍（根列不出来就重试根），并把当前文件交给已有的 `onFilesChanged`：没改过就什么都不变，没有本地修改就静默换新，有本地修改就出「磁盘上被改过」冲突提示（不会惄惄丢掉编辑），打开失败的文件会重试。没有另写「强制重读」，避免和监听路径两套行为。刷新按钮转圈 0.6 秒。

### 窄面板布局

右侧栏最小 320px（`RIGHT_PANEL_MIN_WIDTH`）。文件树最小 160px、内容区最小 240px，合计 400px：面板窄于 400px 时（`NARROW_WIDTH`）一次只显示一个——打开着文件时显示内容区，文件树收成 32px 边条；点边条切到文件树（占满整行、没有拖拽分隔条、路径栏仍在），点文件或再点按钮切回内容。内容区只是 `display: none`、不卸载，编辑器里未保存的修改和撤销历史保留。宽于 400px 沿用原来的并排：文件树可拖宽（`MIN_TREE_WIDTH` 到 总宽 − 240）、可收起为边条，宽度和收起状态记在 localStorage。

## Alternatives considered

- **在左侧会话栏里再做一个文件树（会话 / 文件切换）**。最强理由：入口最显眼，不依赖右栏展开。不用：用户明确指右侧栏；而且右栏已经有完整实现，再做一份要么只能做阉割版的树、要么复制 `useFileTree` / 选中同步，正是「两份行为不一致」的来源。
- **预览不拦链接，只靠主进程 `will-navigate` 兜底**。最强理由：改动最小，只有一处。不用：兜底只能决定「去不去」，不知道相对路径该落到哪个项目文件，也没法在原地滚动锚点；主进程那一刀会把内链全部变成「什么都没发生」。
- **全局捕获阶段统一处理所有链接，预览不自己拦**。最强理由：只有一处逻辑。不用：全局处理拿不到「当前预览的是哪个文件」，相对链接无法解析；捕获阶段还会抢在带自有 `onClick` 的链接前面造成重复处理。
- **链接覆盖当前浏览器标签（单一「链接标签」）**。最强理由：不堆标签。不用：用户可能正在看别的页面，被悄悄覆盖是破坏性的；同地址去重已经解决了堆标签的主要来源。
- **新做模态 / 抽屉承载内置浏览器**。最强理由：不占右栏。不用：`BrowserBody` 已有地址栏、前进后退、错误页、历史建议和登录分区，模态要么重做一遍要么嵌同一个组件；右栏标签还能和别的标签并存、拖拽。
- **路径只用绝对路径 / 只用相对路径，不给切换**。最强理由：栏里没有按钮、更干净。不用：相对路径适合读和贴进对话，绝对路径适合贴进终端或别的程序，两种都是高频；一个偏好开关的成本很低。
- **窄面板里压缩而不是切换（保持并排，内容区压到很窄）**。最强理由：不需要新状态。不用：面板 320px 时内容区只剩约 80px，代码和 Markdown 都不可读。

## Consequences

- 收益：普通对话里 agent 生成的文件可以直接看；Markdown 里的相对链接能跳到对应文件；任何地方的链接都不会再把应用窗口导航走；网页链接统一进内置浏览器；窄栏里路径可读、可复制。
- 代价 / 已知限制：
  - 相对图片（`![](./a.png)`）在预览里仍不渲染：`LazyMarkdown` 的 `stripInlineImages` 会剥掉本地 / 相对路径图片（对话正文的既有规则，预览与对话共用同一个组件），本期没有为预览单独放开。http(s) 图片照常。
  - 跨文件的 `#hash`（`other.md#section`）只打开文件，不定位到标题。
  - 链接指向目录只展开不进入；`mailto:`、`file:`、`javascript:`、`data:` 等协议不支持，只提示。
  - 键盘在文件树里移动焦点时不更新路径栏（只认悬停和选中）。
  - 一个窗口里 casual 会话的「文件」标签以对话目录为根；对话里的文件链接解析用会话工作区，不含会话 `working_directory` 切换后的目录。
  - 对话里点项目内文件链接会展开右栏，在窄窗口下布局解析器可能因此收起左侧会话栏（既有的「谁被操作谁优先」规则）。
  - 新窗口弹出（`window.open`、`target=_blank`）在主窗口一律被拒，原先会弹出的 Electron 子窗口不再出现。
- `lib/files.ts` 的契约、IPC、主进程文件服务都没有改。新增依赖：无。
- 共享代码的影响面：`treeModel.ts` 多导出 `relativeSegments` / `joinUnder`（只加不改）；`FileTree` 多一个可选 `onHoverPath`（唯一使用方是 `FileExplorer`）；`FileViewer` / `MarkdownPreview` 多可选 props；`launcherItems` 的 casual 分支变化影响 `DockLauncher`、`DockStripAddMenu`、Ctrl+P 三处，对应单测已更新。

## Verification

计划与结果（都已实跑）：

- `cd electron-agent && npx vitest run src/features/dock/launcherItems.test.ts src/features/dock/useDockLauncherHotkeys.test.ts src/features/dock/DockStripAddMenu.test.tsx src/features/dock/DockLauncher.test.tsx`：4 个文件 通过（casual 有文件、无审查；无目录时文件置灰；Ctrl+P 在 casual 会话开出以对话目录为根的文件标签）。
- `npx vitest run src/lib/hrefKinds.test.ts src/features/fileExplorer/markdownLinks.test.ts src/features/fileExplorer/filePathDisplay.test.ts electron/mainWindowNavigation.test.ts src/features/dock/browser/openInAppBrowser.test.ts`：5 个文件 29 条通过。
- `npx vitest run src/features/dock/FileTreeBody.links.test.tsx src/features/dock/FileTreeBody.test.tsx src/features/links src/features/dock/browser`：覆盖相对 / 含空格 / 图片包裹 / 目录 / 缺失 / 项目外 / 不支持协议 / 外链与 Ctrl 点击 / 锚点与缺失锚点，路径栏的悬停、切换、复制，全局链接兜底的各分支；全部通过，原有 `FileTreeBody.test.tsx` 没有回归。
- `npm run ui:check -- file-explorer`：118 条通过、0 失败（`.agents/evidence/2026-10-23-file-explorer-casual-links-and-paths/ui-check-file-explorer.log`，截图在同目录 `shots/`）。真实鼠标 / 键盘事件下：点 md 内链打开对应文件并选中、`../` 与含空格 / query / hash 的链接、外链进内置浏览器标签且重复点击不重复开、Ctrl 点击走系统浏览器、缺失 / 项目外 / mailto / 目录的提示、锚点把标题滚到预览顶部，以上每条之后应用页面地址和页面状态都没变；路径栏悬停 / 绝对相对切换 / 复制（剪贴板内容与栏一致）、窄栏长路径只截目录并在悬停时显示完整值、窗口缩到 380px 时一次只显示文件树或内容、恢复后并排。
- 工具栏改动后复跑：`npx vitest run src/features/fileExplorer src/features/dock src/features/links` 34 个文件 228 条通过（含 `useFileHistory.test.ts`：后退再前进、中间打开新文件截掉前进栈、询问里取消指针不动、同文件不重复；`FileTreeBody.links.test.tsx` 的面包屑折叠、后退 / 前进 / Alt+方向键、打开失败后可退回、刷新和 F5）。`npm run ui:check -- file-explorer` 再跑 136 条通过：面包屑宽度不铺满、按钮靠右、后退 / 前进 / Alt+←→、磁盘静默改动后点刷新 / F5 才看得到、380px 窄面板工具栏按钮都在栏内（截图 `shots/file-explorer-narrow-toolbar.png`）。
- 侧键：`npx vitest run src/features/fileExplorer src/features/dock electron/mainWindowNavigation.test.ts` 35 个文件 238 条通过（`fileNavBus.test.ts`：悬停 / 焦点认领、隐藏的不认领、去重；`mainWindowNavigation.test.ts`：app-command 转发；`FileTreeBody.links.test.tsx`：button 3 / 4 后退 / 前进并阻止默认行为、左中右键不触发、app-nav 按焦点认领）。`npm run ui:check -- file-explorer` 139 条通过。不足：harness 的 `sendInputEvent` 发不出侧键，场景里是派发等价 DOM 事件；真实 Windows 鼠标侧键、真实 `app-command` 从系统到主窗口的链路**没有实机验证**。
- 全量 `npx vitest run`（工具栏改动前跑的，没有重跑）：483 个文件通过，8 个失败（19 条），全部在 `electron/agentData`、`electron/tencentdb`、`electron/app/{subagentService,taskViewService,codeGraph}`，与本次改动无关（如 `electron/tencentdb/runtime.test.ts` 缺 `./runtime` 模块）；没有在改动前的提交上复跑对照。摘要见同目录 `vitest-full-summary.log`。
- 未实跑：打包后的 `file:` 页面里 `will-navigate` / `setWindowOpenHandler` 的真实行为（只有 `mainWindowNavigation.test.ts` 的单测，没有起真实 Electron 主窗口点链接）。
