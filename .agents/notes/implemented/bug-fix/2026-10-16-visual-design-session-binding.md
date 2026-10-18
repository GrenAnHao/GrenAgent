# Agent Note: 视觉设计跨会话时预览错位、确认无响应；选项与「补充」

Status: implemented

## Problem

会话 A 发起视觉设计（`show_visual` + `read_visual_choice`），不结束就切到会话 B；在 B 里从右侧标签入口打开预览，看到的标签挂在 B 名下，点「确定」没有任何反应，A 里的 `read_visual_choice` 一直等到超时。单会话内一切正常。

根因是视觉设计的状态没有会话归属，只有一份全局的：

- `visualStore` 是单例 `{ html, mode, pending, requestId, sessionId }`。`ExtensionUiHost` 收到 `setStatus('visual')` 和 `__visualChoice` 哨兵时不看信封里的 `sessionPath`，后台会话的页面和请求 id 直接盖掉当前的；A、B 同时有视觉设计时只剩最后一个。
- `App.tsx` 的 `RightPanelColumn` 在全局 `html` / `mode` 变化时调 `openVisualDockTab`。后者用 `currentDockOwner()`（当前画面上的会话）给标签盖归属，且标签 id 固定为 `visual:panel`：A 在后台发起时标签挂到 B 名下，或已存在的标签被 B 接管。
- 标签关闭后进「最近关闭」，`restoreClosedTab` 恢复出的是没有 owner 的全局标签，在任何会话里都可见，渲染的却是全局 store 里别人的页面。
- `VisualPanel` / `VisualCard` 回写用的是 `useAgentStoreContext().workspace`（当前画面的项目），不是发起会话的项目。A、B 在不同项目时，`respondUi(workspace=B, id=A 的请求)` 在主进程 `uiOwner` 里找不到持有者，落到 B 的前景 handle，`ui.respond` 因没有这条 pending 而静默丢弃，表现为点击无响应。同项目时 `uiOwner` 按 `hasPending(requestId)` 能找到 A 的 handle，所以同项目大多还能成功；只有请求 id 被另一个会话覆盖后才失败。

选项部分：确认条在页面有 `data-choice` 时必须先选一项才可点（`refreshConfirm` 把按钮置灰、`submitSelection` 无选中直接返回），没有地方写补充说明。

## Decision

视觉设计按发起会话记账，面板、标签、回写全部绑到那条记录，不读「当前画面」。

- `visualStore` 改成 `entries: Record<key, VisualEntry>`。key 是 `dockSessionKey({ sessionPath, workspace })`（与右坞归属同一套规范化）；条目含 `html / mode / rev / pending / requestId` 以及发起会话的 `sessionPath / workspace`。`rev` 全局递增，代替旧的 `sessionId` 做 iframe 的 key 和已提交标记。`setVisual` 不动 `pending / requestId`；请求先于页面到达时 `setPending` 先占位。
- `ExtensionUiHost` 的 `visualOwnerOf(envelope)`：取 `envelope.sessionPath`，没有则取该工作区 store 当前加载的会话（与 `backgroundSessionPathOf` 对「没带 sessionPath」的判断一致）。页面和哨兵都写进这个 owner 的条目。后台会话的哨兵也要记，否则切回去时按钮是死的。
- 标签 id 是 `visual:panel:<key>`，每个会话一个；`VisualPayload` 带 `visualKey`，`TabBodyRenderer` 把它交给 `VisualPanel`，面板只读这条条目。`openVisualDockTab(entry)` 的 owner 取自条目。发起会话在后台时只把标签记在它名下，同时写 `activeBySession[key].right` 和 `rightOpenBySession[key]=true`，不展开右面板、不改当前激活项，切回时由 `switchSessionView` 恢复。
- `submitVisualChoice(entry, message)` 是唯一的回写点：`extensionUiRespond(entry.workspace, { id: entry.requestId, … })`，成功后 `markSubmitted(entry.rev)` 并把该条目 `pending` 置 false。面板与内联卡片共用，先到的提交，后到的看到已提交就丢弃。面板用 `submittedIds` 判断已提交并锁住 iframe，重新挂载后不会出现一个看似可点、实际没人收的确认条。
- 关标签：条目还在 `pending`（agent 仍在等）就保留条目，可从「最近关闭」恢复；否则清掉条目并删掉关闭记录。关闭记录里的 visual 项带 owner，恢复时仍归原会话；`DockTabSwitcher` 只在归属会话里列出它，别的会话里恢复得到的是看不见的标签，不列。
- 选项默认可选：无选中直接确认时回传 `choice: ''`、`text: '未选择（已跳过）'`。只有页面在选项容器上写 `data-required`（可带 `data-required-reason`）才强制：缺选时按钮置灰，提示「必选：<原因>」。
- 「补充」：确认条上加「补充」按钮，展开一个绝对定位在条上方的文本框（确认条本身保持单行、不超过 64px 预留区）；内容放在回传的 `supplement` 字段，空白则不带。
- `show_visual` / `read_visual_choice` 的说明同步：选项默认可选、`data-required` 的用法与必须说明原因、返回 JSON 的 `choice / text / supplement`。

## Alternatives considered

- 保持全局单例，只在 `ExtensionUiHost` 里丢掉后台会话的视觉设计（对照 `backgroundUiRequests` 的暂存/恢复）。最强理由：改动最小，沿用已有的暂存模式，一次只可能有一个视觉设计。不用：后台会话的 `read_visual_choice` 仍在等，丢掉就永远收不到回答；暂存再放回要在每次切换会话时搬运全局状态，而这里的页面、请求、标签都天然有 owner，直接按 owner 分开存更简单。
- 回写时让主进程按 `requestId` 在所有工作区里找持有者，渲染层继续传当前 workspace。最强理由：渲染层不必知道 owner。不用：`uiOwner` 的回退逻辑已经够多，改成跨工作区搜索会让别的审批/询问也受影响；渲染层本来就有发起会话的 workspace（信封里带着），传对更直接。
- 视觉设计标签做成全局可见（不设 owner），内容靠 `visualKey` 绑定。最强理由：用户在任意会话都能从标签列表打开 A 的预览，字面上满足「无论在哪个会话都打开原会话的预览」。不用：与现有会话归属标签（子代理、视觉设计）的约定冲突，且每个会话的右面板里都会出现别的会话的设计；需要的话以后可以单独加一个「跳到发起会话」的入口，而不是改可见性。这一条是否符合预期留给用户确认。
- 「补充」做成单行输入框放进确认条同一行。最强理由：没有浮层，布局不变。不用：确认条在窄面板里已经只剩提示、一个按钮的宽度，多一个输入框会把提示挤没；补充说明常常多行。
- 选项一律改为必填/可选由模型传参控制（`show_visual` 新增参数）。最强理由：契约显式。不用：页面是模型写的 HTML，`data-required` 放在选项容器上与 `data-choice` 同一个层级，模型不必多记一个参数，且能逐组控制。

## Consequences

- 收益：多个会话（含不同项目）的视觉设计并存、互不覆盖；后台会话发起时不再抢当前画面；确认一定回到发起会话的项目和请求；面板重新挂载后不会再出现假的可点状态。选项和「补充」都可以跳过，必选需要页面显式声明并给原因。
- 代价：`visualStore`、`VisualPayload`、`openVisualDockTab`、`closeVisualDockTab` 的签名变了；`ClosedDockTab` 多了可选的 owner 字段。每个有视觉设计的会话在 dock 里多一个标签。
- 单会话场景：行为不变，除了确认条多了「补充」、无选中也能提交；`App.tsx` 的开关标签逻辑由单值改为按 key 的集合。
- 残留：用户关掉标签但 agent 仍在等时，条目保留；若 `read_visual_choice` 超时，条目的 `pending` 不会自动清（没有 dismiss 信号），表现为「最近关闭」里还有一个点了没有效果的项。会话被删除时条目不随 `dropSessionTabs` 一起清，体积很小，未处理。
- 旧的 `data-choice` 页面没有 `data-required`，现在默认可以空选提交；依赖「必须选一个」的页面要补上 `data-required`。

## 验证

verify: n/a 真实启动应用并在两个会话间切换：仓库当前没有 `verify-*` skill，且需要两个活着的 agent 会话；用单测 + ui-harness 代替。

- `cd electron-agent && npx vitest run src/stores/visualStore.test.ts src/features/visual src/features/extensionUi src/features/dock`：31 个文件、212 个用例通过。新增/重写：`visualStore.test.ts`（两会话并存含不同工作区、路径写法归一、占位后补页、只清自己的条目）、`openVisualDockTab.test.ts`（每会话一标签、后台会话静默打开并在切回时恢复、关闭后恢复仍归原会话、关闭不留空壳）、`submitVisualChoice.test.ts`（回写用条目的工作区和请求 id、另一会话的等待不受影响、supplement、空 choice）、`ExtensionUiHost.test.tsx`（后台会话的页面和哨兵记到自己名下）、`frameAssets.test.ts`（空选可提交、补充随选择回传、`data-required` 阻止确认并说明原因）。
- `cd electron-agent && npx vitest run src/stores/dock src/stores/backgroundUi src/features/chat`：119 个文件、877 个用例通过。
- `cd extensions && npx vitest run visual-companion prompt-metadata.test.ts`：3 个文件、12 个用例通过。
- `cd electron-agent && npm run ui:check -- visual-panel`：38 项通过（确认条几何、点选只选中、点确认回写；新增：没选方案确认按钮可点、「补充」与确认在同一行、回写目标是发起会话的工作区而非当前画面的、只写补充不选方案提交得到 `choice: ''` 加 `supplement`）。只跑了这一个场景，其余 17 个没跑。
- 改动文件的类型检查（临时 tsconfig）无新增报错；`frameAssets.test.ts` 里两处 `win.eval` 的类型报错是改动前就有的。
