# Agent Note: 右侧边栏跟着会话走，不再有跨会话共用的右栏

Status: implemented

## Problem

在会话 A 里打开右侧边栏（点「Panel」出启动页，或从启动页、交付卡、改动行、抓取卡、「项目上下文」打开标签），切到会话 B，右栏原样开着，内容还是 A 打开的那些标签，在 B 里可以继续用；再切到 C 也一样。右栏成了一个独立于会话、在多个会话之间共用的实例。

之前的约定是右栏跟着会话走，2026-10-05 的提交 `18027591` 引入了这套机制：

- `features/dock/useDockSessionSwitch.ts` 的说明：「聊天会话切换时让坞跟着会话走：保存离开会话的激活 tab / 右面板展开态，恢复目标会话的。」
- `DockPanel.test.tsx` 的 `does not carry a subagent tab from session A into session B`，`dockStore.test.ts` 的 `hides A-owned tabs in B, closes the right panel, and restores both when switching back`。

回归的根因是那次绑定只对几种标签生效，其余标签默认全局共享：

- 只有 `openSubAgent` / `openSubAgentLog` / `openVisualDockTab` 给标签写 `ownerSessionPath`。`isDockTabVisible` 把没有归属的标签当成全局标签，在所有会话里可见。
- 其它打开右栏标签的入口都直接走 `addTab` 且不带归属，包括启动页、加号菜单和快捷键（`openLauncherTab`）、交付卡和审查标签的「打开文件」（`openWorkspaceFile`，10-15 新增）、改动行（`openTurnReview`）、抓取卡（`openPage`）、「项目上下文」（`openProjectContext`）、浏览器弹窗。所以这些标签都是全局的。`openPage` / `openProjectContext` 用固定 id，`openTurnReview` 和 `findExisting` 不分会话复用已有标签，B 里的入口会把 A 的标签激活过来。
- `switchSessionView` 只在「上一会话有右栏标签、目标会话没有」时收起，只在「目标会话有带归属的标签」时恢复展开。全局标签在两个会话里都可见，空的启动页又没有标签，这两种情况都不会进分支，展开状态被原样带过去。
- `dockStore.test.ts` 里有一条 `keeps global tabs visible across sessions and leaves the panel open`，把这种共享写成了预期行为，所以测试拦不住。

绑定是按入口逐个加的，新入口不带归属就默认全局。10-05 之后加的入口都没带，右栏就又变回跨会话共用。

## Decision

右区（`region: 'right'`）的标签一律属于某个会话，右面板的展开 / 占满也按会话记。归属在 store 里统一补，不要求每个入口自己记得带。

- `dockStore.addTab` 经 `withRightOwner` 给落到右区、没带归属的标签补上当前会话（`currentDockOwner()`）。`openPage` / `openProjectContext` 新建时同样带归属；`moveTabRegion` 拖进右区时补归属，拖回底部时，非会话类标签（终端等）去掉归属，恢复成全局共享。
- 复用已有标签只在当前会话可见的标签里找：`openPage`（按网址）、`openProjectContext`、`openLauncherTab` 的 `findExisting`、`openTurnReview`、`restoreClosedTab` 的 `findLiveForRestore`。固定 id 被别的会话占着时用 `freeTabId` 另起 `#n`。浏览器弹窗归到打开它的页面所在的会话。
- 关闭快照（`snapshotClosedTab`）对所有带归属的标签都记下归属，恢复回原会话。`DockTabSwitcher` 只列当前会话的关闭项（沿用视觉设计那次的过滤）。`dropSessionTabs` 删会话时一并丢掉它的关闭项。
- `switchSessionView` 离开时记下 `rightOpenBySession` / `rightFillBySession`。进入目标会话时按它离开时的样子恢复，没去过的会话默认收起，不再看上一会话开没开、有没有标签。
- 草稿首发落盘不算换会话：`ChatView` 在 `setActiveSession(新路径)` 之前调 `dockStore.adoptDraftView(workspace, path)`，把草稿名下的标签、关闭项、激活项和展开状态过户给新会话，并标记随后那次「草稿 → 新会话」切换跳过。不过户的话，草稿里打开的文件标签会在第一条消息发出时消失、右栏收起。
- 持久化：右区没有归属的标签（旧版本留下的全局右栏标签）不再写盘，读回时丢掉。带归属的标签照常持久化，重启后仍只在原会话里出现。底部区不变，终端照旧全局共享。
- 切会话不卸载常驻标签：`DockPanel` 的标签条只放当前会话可见的标签，body 用 `mountedRegionTabs` 渲染，范围是可见标签加上别的会话里非会话类的标签（终端、浏览器、文件、网页、审查、项目上下文），后者用 `display: none` 藏起来。当前会话没有标签时 `TabBodyStack` 整块隐藏但不卸载。终端 shell、浏览器页面和文件里没保存的修改，切回原会话时都还在。子代理、视觉设计仍随会话卸载，与原来一致。

### 防范

- 打开右栏标签的入口不用再自己写归属，`addTab` 统一兜底。要加新的「打开到右栏」入口时走 `addTab` 或现有的 `open*`；不要直接 `setState` 往 `tabs` 里塞标签，`openVisualDockTab` 的后台分支是唯一例外，它显式带了归属。
- 复用已有标签时要按 `isDockTabVisible(t, currentDockView())` 过滤，不能按 id 或类型全局找。
- 新增把草稿变成会话的路径时，要在 `setActiveSession` 之前调 `adoptDraftView`。
- `dockStore.test.ts` 的会话归属组、`DockPanel.test.tsx` 和 ui-harness 场景 `dock-session-binding` 守住这些约定。全局共享右栏的测试已经改写。

## Alternatives considered

- 维持按入口绑定，只给这次漏掉的 6 个入口补上归属。最强理由：改动面最小，只碰那几处调用，不动 store 的默认行为。不用：根因就是「默认全局、靠入口自觉」，10-05 之后的新入口全部漏了。下一个新入口还会漏，同一个回归会再出现一次。
- 每个会话一个独立的坞（按会话 key 重挂 `DockPanel`，或给每个会话一份 dock store）。最强理由：结构上不可能共享，也不需要归属字段。不用：切会话就卸载整个右栏，终端 shell 被停、浏览器页面重载、文件里没保存的修改丢失；持久化格式和所有 `useDockStore` 调用方都要改，远超修回归的范围。
- 浏览器、终端这类「工具型」标签保持全局，只绑定和会话内容有关的文件、审查、网页。最强理由：同一个项目里开一个浏览器给所有会话用，看起来顺手。不用：用户要求不允许出现跨会话使用的右栏实例；而且空的启动页、右栏展开状态本身也在跨会话泄漏，只绑内容型标签修不掉这一半。
- 切会话时卸载别的会话的全部 body（只渲染可见标签，与原来的子代理标签一样）。最强理由：实现最简单，内存只随当前会话。不用：原来全局的终端、浏览器、文件标签切会话不会卸载，改成卸载会让终端在切会话时被停掉、未保存修改丢失，这是新的回归。

## Consequences

- 收益：右栏的内容、激活项、展开 / 占满都跟着会话，A 打开的右栏不会出现在 B。新入口默认就是会话归属，不会再因为漏写而回到全局。
- 代价：同一项目的多个会话各开一个「文件」标签时，后台会话那份隐藏着继续挂着，目录监听、浏览器 webview 的开销随打开过右栏的会话数增长。没去过的会话第一次进入右栏是收起的。
- 升级时旧版本持久化的全局右栏标签（如「文件」标签）丢一次。底部终端不受影响。
- `ChatView` 多了一条对 dock 的跨模块约定（首发前 `adoptDraftView`）。
- 新建草稿仍按工作区共用一个草稿 key（`d:<workspace>`），同一项目里放弃的草稿留下的右栏状态，会出现在下一个草稿里。这是原来的语义，这次没改。
- 与 [视觉设计跨会话](2026-10-16-visual-design-session-binding.md) 互补：那篇让视觉设计标签按发起会话归属，后台会话写 `rightOpenBySession` 的做法在这里的严格恢复下照常生效。

## 验证

verify: n/a 真实启动应用并在多个活会话间切换：仓库当前没有 `verify-*` skill；用 ui-harness 的真实组件 + 真实点击加单测代替，证据在 `.agents/evidence/2026-10-16-right-dock-session-binding/`。

- `cd electron-agent && npm run ui:check -- dock-session-binding`：23 项全部通过（`ui-check-fixed.log`，截图 `a-restored` / `b-own-launcher` / `b-collapsed`）。覆盖的路径：A 打开右栏和文件标签 → 切到 B，右栏收起 → B 打开只看到自己的空启动页 → 切回 A 按原样展开，且是同一个 body 实例 → B 开自己的文件标签，两份并存、各显各的 → B 收起后 A 不受影响，回到 B 仍收起。
- 同一场景跑在还原的旧逻辑上（`addTab` 不补归属、旧的 `switchSessionView` 收起 / 恢复分支）：12 项失败，第一条是「B：右栏收起」，宽度读到 481（`ui-check-old-behavior.log`），复现了用户报告的问题。跑完已还原代码。
- `cd electron-agent && npx vitest run src`：317 个文件、2538 个用例全部通过（`vitest-src-summary.txt`）。新增和改写的用例：`dockStore.test.ts` 的会话归属组（各入口都记归属、切走收起切回恢复、空启动页不跟到 B、占满按会话记、同网址 / 项目上下文各会话一份、终端拖进右栏再拖回、关闭项带归属恢复且不抢别的会话的同 id 标签、草稿首发过户、删会话连关闭项一起删、旧版无归属右栏标签读回丢弃）；`DockPanel.test.tsx` 的启动页标签不进 B、常驻 body 切会话不重建；`WorkspaceBar.test.tsx` 的会话 store 桩补了 `getState`。
- 同样还原旧逻辑后，`dockStore.test.ts` 和 `DockPanel.test.tsx` 有 5 条新用例失败，确认这些用例能拦住回归。
- 改动文件的类型检查（临时 tsconfig）没有新增报错。`ChatView.tsx:284` 的 `beforeCount` 报错在改动前就存在，与本次无关。
- 只跑了 `dock-session-binding` 一个场景，其余 18 个没跑：它们都不渲染 `DockPanel`，也不调用 dock 的打开 / 切换动作。
