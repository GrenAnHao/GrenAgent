# Agent Note: 文件管理器：改名并支持多文件标签

Status: implemented

## Problem

右侧栏的「文件」标签一次只能看一个文件。点文件树里的另一个文件会替换当前文件，有未保存修改时还要先在「保存 / 放弃 / 取消」里选一个。对照着看两个文件、或者边改边查另一个文件，只能来回切，编辑器的撤销历史和滚动位置每次都丢。用户还要求把这个标签的名字从「文件」改成「文件管理器」。

## Decision

### 改名

- dock 标签名是 `FILE_TAB_TITLE = '文件管理器'`（`stores/dockStore.ts`），`openLauncherTab` 新建文件标签时用它；启动页、加号菜单的入口文字来自 `launcherItems.ts`，同样是「文件管理器」。
- 旧版本持久化下来的 `title: '文件'` 在 `persistDockSnapshot` 里统一改写（`normalizePersistedTab`，读回 merge 和写盘 partialize 都走它，`tabs` 和 `closedTabs` 都改），老用户重启后也看到新名字。
- 文件树面板自己的表头仍写「文件」：它只是树的标题，不是这个标签的名字。

### 文件标签

- 状态模型在 `fileExplorer/fileTabsModel.ts`（纯函数，有单测）：`{ paths, active }`。`openFileTab` 已有同一路径（`pathsEquivalent`，含 `E:\x` / `E:/x`）就切过去，否则追加到末尾；`closeFileTabs` 关掉当前标签时激活右边第一个留下的，没有就左边最近的；`tabsInScope` 给右键菜单算「关闭 / 关闭其他 / 关闭右侧 / 全部关闭」；`fileTabLabels` 给同名文件附最短的可区分上级目录；`sanitizeFileTabs` 清洗持久化读回来的数据。
- 所有「打开文件」入口——点文件树、Markdown 内链、外部打开请求（`fileOpenRequests`）、后退 / 前进——都走 `FileExplorer` 的 `openFile`，也就是 `openFileTab`。打开别的文件不再替换当前文件，所以不再先问未保存修改。不做预览标签（单击临时、双击固定）。
- 每个标签一个 `FileTabPane`，自己调一份 `useOpenFile`，挂载时读盘。当前标签以外的只 `display: none`，不卸载：未保存修改、撤销历史、滚动位置、编辑 / 预览模式都保留。从没激活过的标签（重启后恢复出来的）不挂 `FileTabPane`、不读盘，第一次激活才挂（`visited`）。
- `FileExplorer` 通过 `register` 收集各标签最新的 `OpenFileApi`（每次渲染登记，卸载登记 null），快捷键（Ctrl+S / Ctrl+E / Esc）取当前标签那份；目录监听推来的变更和刷新按钮分发给所有已挂载的标签。文本文件的磁盘核对：事件里的 `paths` 点了名，就只读被点名的文件；`paths` 为空才按父目录回退（有的监听只报目录、不报文件）。监听目录（`useFileTree` 的 `extraWatch`，现在是数组）包括所有已挂载标签的父目录。标签栏要显示的「未保存」由各标签经 `onSummary` 上报，状态没变不触发重渲；传给各标签的 `nav` 用 `useMemo` 稳住，打字只重渲当前标签。编辑器按键先把脏标记亮上，整篇正文最多 200ms 送一次；Ctrl+S 保存前从编辑器读最新正文，不等这次上报。
- 关标签：× 按钮、鼠标中键（`auxclick`，`mousedown` 上拦掉自动滚动）、右键菜单。有未保存修改的标签先切过去再问「保存 / 放弃 / 取消」，取消就停在那里，前面问过的照样关；关完回到原来的当前标签（如果它还开着）。不绑 Ctrl+W：Electron 默认菜单把它给了「关闭窗口」，抢它要先确认菜单配置。
- 关窗口（`registerUnsaved`）和关 dock 标签（`setDockCloseGuard`）前的未保存检查覆盖所有文件标签，按标签顺序逐个切过去问。
- 标签栏（`FileTabBar`）：标签名是文件名，同名时后面灰字附目录；未保存显示圆点，悬停到按钮上换成 ×；当前标签和悬停的标签显示 ×。标签多了横向滚动，不显示滚动条（Windows 上滚动条会占掉标签的高度），纵向滚轮换算成横向；当前标签**变化时**才把它滚进可视区，只改标签栏自己的 `scrollLeft`，不用 `scrollIntoView`（会连外层面板一起滚），用户滚到别处、中键关掉那里的标签时不被拉回。
- 后退 / 前进的历史（`useFileHistory`）仍按「当前看的是哪个文件」记，切标签、关掉当前标签后激活邻居也各算一次；后退到已关掉的文件会重新开一个标签。
- 查找（Ctrl+F）的范围仍是整个文件管理器（dock 标签 id）。只有当前文件标签拿到 `findScope`，查找栏和高亮只出现在看得见的文件里；切标签时新标签拿到范围，同一个查询在新文件里重查，旧标签的驱动被 dispose、高亮清掉。`useFindDriver` 在范围变了时把已有的跳转 nonce 当成旧请求，否则从「无范围」切到有范围的那一刻会多跳一个命中。
- 持久化：打开着的文件和当前文件写进 dock 标签 payload（`FilePayload.openFiles` / `activeFile`，`FileTreeBody` 的 `onTabsChange` 用 `updateTab` 写，内容没变不写），跟着 dock 的 localStorage 落盘；`FileTreeBody` 挂载时读一次作为初始标签。dock 标签本来就按会话归属、切会话不卸载，所以切会话和重启都按上次的样子恢复。

## Alternatives considered

- **预览标签（单击临时替换、双击或编辑后固定）**。最强理由：浏览文件树时不堆标签，VS Code 用户熟悉。不用：多一种标签状态（斜体、何时固定）要解释，也多一套测试；先做「每个文件一个标签」，标签多了用右键「关闭其他」。真堆得难受再加。
- **单个查看器 + 标签只是快捷列表（切标签时重新读盘）**。最强理由：DOM 里永远只有一份编辑器，内存省，现有 probe 的选择器不用改。不用：切走就丢未保存修改或要先问，等于没解决「对照着改」的问题；撤销历史和滚动位置也丢。这次优化没有改这条：标签仍然常驻，只是同目录里没被点名的文件不再整份重读，编辑器按键也不再每次把整篇送进 React。
- **同目录任一变化就重读该目录下所有打开的文本**。最强理由：有的文件监听只报目录、不报文件名，重读能兜住漏报。不用：事件的 `paths` 已经点名时，没被点名的文件不必读上来；`paths` 为空才按父目录回退。
- **把每个打开的文件做成单独的 dock 标签**。最强理由：dock 已经有标签栏、拖拽、关闭、恢复。不用：文件树、路径栏、目录监听都要跟着复制或改成共享，和其他右栏标签（浏览器、审查）混在一起也难找；用户要的是文件管理器里面的标签栏。
- **标签栏显示细滚动条**。最强理由：鼠标用户一眼能看出还有更多标签、可以拖。不用：Windows 上滚动条画在 34px 的标签栏里面，实测把标签文字顶到上沿（截图对照过）；滚轮横滚加上当前标签自动滚进可视区已经够用。

## Consequences

- 收益：可以同时开多个文件来回切，未保存修改、撤销历史、滚动位置都在；打开别的文件不再被「保存 / 放弃」对话框打断；重启后标签还在。
- 代价 / 已知限制：
  - 每个激活过的文件都挂着一份预览或 CodeMirror，开很多大文件会占内存；没有上限，也没有把长时间不看的标签卸掉。同目录里别的文件变化时，只要事件点了具体路径，就不再把每个打开的文本文件整份读上来。
  - 标签不能拖拽排序，没有键盘切标签（Ctrl+Tab）和 Ctrl+W 关闭。
  - 标签栏没有滚动条，靠滚轮和自动滚动；只有触控板横滑和滚轮能翻到看不见的标签。
  - 「打开时不再询问未保存修改」是行为变化：以前切文件就会被要求先处理，现在修改可以在后台标签里一直挂着，直到关标签、关 dock 标签或关窗口才问。
  - 持久化的 `openFiles` 是绝对路径；文件被删了，恢复后那个标签第一次激活时显示「打不开这个文件」和重试。
- 契约变化：`FilePayload` 多两个可选字段；`useFileTree` 第三个参数从 `string | null` 改为 `readonly string[]`（唯一调用方是 `FileExplorer`）；`FileExplorer` 多 `initialTabs` / `onTabsChange` 两个可选 props；`useFindDriver` 跟踪范围变化。主进程、IPC、`lib/files.ts` 都没改。新增依赖：无。
- 和 [文件管理器：普通对话也有、Markdown 链接、显示路径](./2026-10-23-file-explorer-casual-links-and-paths.md) 部分重叠：那篇的「历史 / 后退前进走 `useOpenFile.open`、未保存询问沿用」已被本篇取代（现在走 `openFileTab`），那篇已就地改了这一处事实并链到这里。

## Verification

- `cd electron-agent && npx vitest run src/features/fileExplorer src/features/dock src/stores src/features/find src/features/links`：74 个文件 710 条通过（日志 `.agents/evidence/2026-10-23-file-manager-tabs/vitest.log`）。新增 / 改写的用例：`fileTabsModel.test.ts`（开 / 去重 / 关后激活邻居 / 右键范围 / 持久化清洗 / 同名标签）；`FileTreeBody.test.tsx`（打开别的文件新开标签不问、切回同一个编辑器且不重读盘、关脏标签先问取消不关放弃不写盘、关 dock 标签先问、中键关闭、按 payload 恢复且只读当前标签、变化写回 payload、外部请求新开标签不动旧标签的修改）；`FileTreeBody.links.test.tsx`（后退 / 前进 / Alt+方向键 / 侧键 / app-command 都是切标签不重读盘、后退到关掉的文件重新开标签）；`dockStore.test.ts`（旧「文件」标题读回改名、payload 保留）；`launcherItems.test.ts`（入口文字）。
- `npm run ui:check -- file-explorer`：211 条通过、0 失败（`.agents/evidence/2026-10-23-file-manager-tabs/ui-check-file-explorer.log`，截图在同目录 `shots/`）。真实鼠标键盘事件下：三个文件三个标签按打开顺序、打开别的文件不弹询问、脏标签圆点、点标签切回修改还在且不重读盘、点 × 关脏标签弹询问 / 取消不关 / 保存后圆点消失 / 放弃后关掉并激活右边的且不写盘、外部重复请求同一文件不重复标签不重复视图、只有当前标签的查看器可见、同名 guide.md 附目录、标签多时横向滚动且没有滚动条占高度、新开的标签滚进可视区、滚轮横滚回开头、中键关别的标签当前标签和滚动位置都不变、右键菜单四项、「关闭其他」「全部关闭」、全部关闭后回到空提示且树里无选中、深 / 浅色下当前标签与标签栏底色不同且和内容区同色；原有的预览 / 编辑 / 保存 / 外部改动 / 链接 / 后退前进 / 刷新 / 路径栏 / 窄面板 / Ctrl+F（含开着查找栏切标签重查）全部仍通过。日志里那一条 `MISS … find-count … '1 / 1'` 是 probe 里故意忽略结果的等待（原来就有）。
- `node ui-harness/check.mjs dock-session-binding panel-resize`：18 条通过；`dock-session-binding` 新加的两条（启动页入口、dock 标签条都写「文件管理器」）通过（日志同目录）。
- 未跑：打包后的真实应用里重启恢复标签（只有 `FileTreeBody.test.tsx` 按 payload 恢复的单测和 `dockStore.test.ts` 的 merge 单测）；全量 `npx vitest run` 和其余 29 个 ui-harness 场景（工作区里有大量与本次无关的未提交改动，`--changed` 会退回全部场景，没有跑）。
- 热路径（2026-10-26）：同目录未点名的文件不再整份重读；编辑器按键先亮脏标记，保存前直接读编辑器正文。`npx vitest run src/features/find src/features/fileExplorer src/features/chat` 131 个文件、980 条通过。`npm run ui:check -- chat-find file-explorer` 230 条通过、0 失败（126.7s），其中文件里改字、未保存圆点、Ctrl+S 写盘仍通过。
