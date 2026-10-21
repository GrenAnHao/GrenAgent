# Agent Note: 会话注意状态：侧栏角标、应用内提示、系统通知与任务栏

Status: implemented

## Problem

侧栏会话行的行尾格（`SessionItem.tsx`）只会画运行中的黄色转圈。离开画面的会话出了什么事，用户只能一个个点进去看：

- 后台会话跑完，转圈熄灭，什么也不留，看不出哪些跑完了还没看。
- 后台会话弹了要用户处理的卡（ask_user 富卡、审批 confirm / select / input、视觉设计 `read_visual_choice`），卡片只暂存在 `backgroundUiRequests`（同项目的后台会话）或别的工作区的 `uiPromptStore` 里，侧栏上没有任何标记。回合就一直挂着等，用户不知道。`SessionItem` 原来有个 `waiting` 属性会把转圈换成手掌，但没有调用方传过。
- Goal 变成 `blocked`、回合以 `stopReason: 'error'` 结束，也只有点进会话才看得到。
- 窗口不在前台时，以上情况完全没有提醒。主进程没有系统通知、任务栏闪烁或角标代码，也没调过 `app.setAppUserModelId`（Windows 不调就不弹系统通知）。

## Decision

### 状态与优先级

每个会话同一时间只显示一个状态，按下表从上往下取第一个（`attentionView.resolveRowStatus`）：

| 状态 | 样式 | 出现 | 消失 |
| --- | --- | --- | --- |
| 等待批准 `approval` | 橙色 `Hand`（`cssVar.orange`） | confirm / select / 普通 input 审批卡，含子代理经它发来的 | 答复、宿主 dismiss、回合结束（子代理审批按 `dropStashedUiRequests` 的规则保留） |
| 需要你选择 `choice` | 蓝色 `MessageCircleQuestion`（`colorInfo`），呼吸动画 | ask_user 富卡（live 和 restored）；`read_visual_choice` 等待中 | 答复；视觉设计另在宿主 dismiss 或该会话回合结束时清 |
| 运行中 `running` | 黄色转圈（`colorWarning`） | `agent_start` | 结束 |
| 失败 `failed` | 红色 `CircleX`（`colorError`） | 回合结束且最后一条助手消息 `stopReason: 'error'` | 打开这个会话；下一轮结束时被新结果替换 |
| 任务受阻 `blocked` | 紫色 `OctagonPause`（`cssVar.purple`） | 该会话的 Goal 快照变成 `blocked` | 打开这个会话；Goal 离开 `blocked` |
| 完成未读 `done` | 8px 绿色实心圆点（`colorSuccess`） | 回合结束后 1.5 秒内没有新一轮 `agent_start` | 打开这个会话；新一轮开始 |

- 完成宽限 `DONE_GRACE_MS = 1500`：`agent_end`（`stop`，不重试）起计时，`agent_settled` 重新起算，期间来 `agent_start` 就取消。Goal 续跑在 `agent_settled` 里同会话重入（`extensions/goal/index.ts`），不等的话每一轮都冒一次「完成」。
- 用户中断（`aborted`）不写结果，也不改已有结果。`env.source` 为 `goal` / `subagent` 的事件、没有 `sessionPath` 的事件不参与，与 `runningSessions.handleRunningEvent` 一致。只处理 `agent_start` / `agent_end` / `agent_settled`，流式事件直接返回。
- 「打开这个会话」= 它是 `activeSessionPath` 且主窗口在前台（store 里的 `visibleKey`）。事件到来时已经满足就不记未读；窗口在后台时记下，拿回焦点且它仍在画面上时清掉。
- 失败和完成共用一格「上一轮结果」（`outcome`，带递增的 `seq`）。新一轮开始时完成清掉、失败保留，显示被转圈盖住；这一轮结束时由新结果替换。受阻是单独一格。
- 任务栏待处理数、分组头计数按状态算（`needsAction`：等待中的请求、上一轮失败、受阻），不按显示算；只数侧栏列表里看得见的会话（`listedSessionKeys`，去掉归档和乐观删除中的）。会话删除时 `forgetSessionAttention` 把它的未读和完成计时一起丢掉。
- 会话路径一律用 `sessionControlKey` 作键（主进程用同一种归一 `attentionSessionKey`，含 `\\?\` 前缀）。从提示或系统通知打开会话时，先用 `resolveSessionTarget` 换成列表里的写法，侧栏才能按严格相等高亮当前行。

### 侧栏

- `SessionItem` 多了 `attention?: { kind, tooltip }`（去掉了没人用的 `waiting`）。行尾格加 `data-attention`，有角标时和运行中一样常显，悬停时角标在原位让给「更多」，规则同转圈。角标是 `<span data-testid="session-attention" data-kind aria-label>`，图标由新组件 `AttentionIcon`（行与分组头共用）画。
- 整行外面常驻一个 antd `Tooltip`（`placement="right"`、`mouseEnterDelay={0.4}`，没有状态时 title 为 undefined）。不条件包裹：状态一变整行重挂会丢掉悬停状态。文案见 `attentionTooltip`：「等待批准：<标题>」「等待你选择：<标题>」「失败：<报错，超过 60 字截断加 …>」「Goal 受阻：<原因>」「已完成，未查看」，缺细节时有兜底文案。
- `GroupSessionRow` / `ConversationRow` 调 `useSessionAttention(path, running)`：只用返回原始值（kind、tooltip）的 selector，再 `useMemo` 拼对象，转圈压过角标时返回 undefined。
- 折叠的项目分组头（`ProjectItem` 的 `attention`，`ProjectHeaderRow` 调 `useGroupAttention(paths, running, !expanded)`）和整区收起的「置顶 / 对话 / 项目」区头（`SidebarSectionHeader`，`useSidebarItems` 给收起的区带上 `sessionPaths`）显示组内最高优先级的图标，后面跟需要处理的会话数；只有完成时只显示绿点、不写数字。

### 数据来源：`src/stores/sessionAttention.ts`

- `useAttentionStore`：`unread`（按键记 `UnreadEntry`）、`pending`（派生）、`focused`、`visibleKey`。
- 未读来自 `onPiEvent`（`handleAttentionEvent`）和 `goalStore` 订阅（`applyGoalState`，用 `sessionIdByPath` 反查键）。Goal 受阻按 sessionId 记转变；对不上会话时不记，会话列表变化时再对一次。
- 等待中的请求由 `attentionPending.derivePending` 从 `uiPromptStore`（显示中 + 排队）、`inlineQuestionStore`、`visualStore` 的 pending、`backgroundUiRequests` 的暂存派生，同一会话里审批压过选择。暂存补了 `useStashedUiRequestsVersion`（每次改动加一，放回画面之后才加）和 `listStashedUiRequests`。请求没带 `sessionPath` 时归到 `workspaceSessionPaths[workspace]`。
- 视觉设计的 pending 原来只有提交时才改回 false。现在 `ExtensionUiHost` 收到 `dismiss` 时按 requestId 清（`visualStore.dismissRequest`），收到该会话不重试的 `agent_end` / `agent_settled` 时清（`settleVisualOnTurnEnd`）：`read_visual_choice` 是回合内的阻塞工具，回合结束说明它已经返回。
- 窗口焦点以主进程为准，经 `pi://window-focus` 推送，启动时问一次 `attention_window_focused`。
- 未读只在内存里，重启清空。`startSessionAttention()` 由 `AttentionHost` 挂载时调，幂等。

### 提示与通知

渲染层 `features/attention/attentionNotifier.ts` 用 `diffAttention` 算状态转变：pending 出现或换了种类、`outcome.seq` 变大、blocked 出现时各算一次。会话在画面上就跳过，否则调 `attention_notify { kind, workspace, sessionPath, title: "<会话名> · <状态名>", body }`，正文截到 200 字。主进程 `AttentionService` 按设置和窗口焦点回答：

- 该类开关关着 → `off`（侧栏角标照常）。
- 窗口在前台 → `in-app`。通知器回来后再确认一次状态还成立（审批可能已秒答），才用 antd notification 弹「会话名 · 状态」+ 正文 +「前往」：每个会话一个 key、新的替换旧的；完成 / 失败 `duration: 8`，选择 / 批准 / 受阻 `duration: false`，状态清掉或会话被打开时收起；`sound` 为真时 `playChime()`（Web Audio 合成 880→660Hz、0.18 秒）。
- 窗口不在前台 → 系统 `Notification`（`silent: !sound`），同一会话的旧通知先 `close()`；完成以外的四类在 `notify.taskbar` 开着时 `flashFrame(true)`，窗口 focus 时 `flashFrame(false)`。点通知：最小化的先还原，`show()` + `focus()`，再经 `pi://attention-open` 交给 App 的 `handleOpenSourceSession`（经 `openSessionBridge`）。
- 通知对象按会话一直持有，不在 `close` 事件上丢：Windows 横幅超时进行动中心时就会发 close，通知还在、还能被点，丢了引用会被 GC、点击无效。只在同会话新通知替换、被点击、或渲染层调 `attention_clear`（发过系统通知的那个会话状态清掉或被打开）时关闭并丢掉。
- 「需要选择」开关同时管 `choice` 和 `approval`；完成、受阻、失败各一个开关。完成的正文写「这一轮已经跑完」，不重复标题里的「已完成」。

### 任务栏

- 待处理数变化时调 `attention_badge { count, overlayDataUrl? }`；通知器启动时一定先发一次，渲染层重载后旧图标会被清掉。
- Windows：渲染层 canvas 画 32×32 红底白字（`badgeText`：超过 9 写 9+），主进程 `nativeImage.createFromDataURL` 后 `setOverlayIcon`，0 时清掉。其他平台 `app.setBadgeCount`。`notify.taskbar` 关着等同 0。读设置后只应用最新一次调用，乱序完成的旧调用丢弃。
- `main.ts` 在 `whenReady` 开头调 `app.setAppUserModelId`：打包后是 `com.rxstudio.grenagent`（同 `electron-builder.yml` 的 appId），开发态是 `process.execPath`。

### 设置

「核心」组在「外观」后面新增「通知」分类，`effect: 'instant'`，主进程每次提醒时现读（`notifyEnabled`，空值取默认）：

| 键 | 标签 | 默认 |
| --- | --- | --- |
| `notify.done` | 会话完成 | `0` |
| `notify.choice` | 需要选择或批准 | `1` |
| `notify.blocked` | 任务受阻 | `1` |
| `notify.failed` | 失败 | `1` |
| `notify.sound` | 提示音 | `1` |
| `notify.taskbar` | 任务栏闪烁与待处理数 | `1` |

默认值只有一份，在 `electron/app/attentionContract.ts` 的 `NOTIFY_SETTING_DEFAULTS`。设置页和 `lib/pi.ts` 直接从这个文件 import 值，这是渲染层第一次从 `electron/` 导入值而不只是类型，所以文件头写明只能是纯 TS、禁止引入 node / electron 依赖。

### IPC 契约

| 命令 / 事件 | 载荷 | 返回 |
| --- | --- | --- |
| `attention_notify` | `{ kind, workspace, sessionPath, title, body }`，kind 不在五种里、路径为空时报错 | `{ route: 'off' \| 'in-app' \| 'os', sound }` |
| `attention_badge` | `{ count: 非负整数, overlayDataUrl? }` | — |
| `attention_clear` | `{ sessionPath }` | — |
| `attention_window_focused` | — | `boolean` |
| `pi://window-focus` | `{ focused }` | 主进程推 |
| `pi://attention-open` | `{ workspace, sessionPath }` | 主进程推 |

### 不做

- 未读不落盘。
- 子代理、Goal worker 不单独发通知（子代理的审批经父会话出现，算父会话的 `approval`）。
- 按项目或按会话静音。
- 会话进程意外退出单独当一种失败（`pi://exit` 在删会话、关项目时也会来，区分不可靠）。

## Alternatives considered

- **主进程订阅 pi 事件流自己判断（方案 B）**。最强理由：渲染层卡住或刷新时通知照样能发，主进程本来就是事件的转发者。不用：主进程不知道哪个会话在画面上、哪张卡已经答复、视觉设计是否还在等。这些状态全在渲染层的几个 store 里，搬到主进程等于再维护一份；ask_user、审批、视觉设计的答复路径都要重新接一遍。
- **渲染层直接用 HTML5 `new Notification()`（方案 C）**。最强理由：省一条 IPC，主进程不改。不用：Windows 上点通知拉不起窗口，任务栏闪烁和覆盖图标做不了，AppUserModelId 的问题一样要在主进程处理。
- **等待中的请求按请求 id 在 `ExtensionUiHost` 里单独记账**。最强理由：入口集中，一处加、`dismiss` 时一处删，不用订阅四个 store。不用：请求的消失还有答复（几张卡各自回包）、回合结束丢弃暂存、切会话暂存再放回、子代理审批跨回合保留这些分支，已经由那几个 store 处理好了；单独记账要把每条分支再抄一遍，漏一条角标就一直亮着。视觉设计正好是那几个 store 自己漏了的一条（pending 没人清），修在 `visualStore` / `ExtensionUiHost`，不在派生里打补丁。
- **「需要选择」和「等待批准」合成一种颜色**。最强理由：少一种状态，用户只需知道「要处理」。用户选了分开：审批通常几秒内要回（子代理审批有倒计时），选择题可以慢慢想。
- **状态说明放在角标的 Tooltip 上**。最强理由：指哪说明哪，最直观。不用：行尾格悬停会换成归档与「更多」按钮，角标在悬停时是隐藏的。
- **完成不等宽限、按 `agent_settled` 立即判**。最强理由：简单，`agent_settled` 语义上已经是「重试、压缩、排队续跑都不再发生」。不用：Goal 扩展正是在 `agent_settled` 里开下一轮，事件到渲染层时下一轮还没 `agent_start`，每轮都会误报一次完成。
- **主进程在通知 `close` 事件上丢引用**。最强理由：Map 不会留着已经消失的通知，写法也最直观。不用：Windows 横幅超时进行动中心时就发 close，之后在行动中心点它，回调已经随对象被 GC；同会话的新通知也拿不到旧对象去关，行动中心越堆越多。

## Consequences

- 收益：后台会话跑完、出错、受阻、等人处理，在侧栏、折叠分组头、收起的区头、应用内提示、系统通知、任务栏上都看得到，打开会话就清；默认只打扰需要处理的三类。
- 收益：等待中的请求从现有 store 派生，答复、撤回、回合结束、切会话暂存这些路径不需要再写一遍。
- 代价：派生依赖四个 store 的形状，以后哪个 store 改了暂存方式，角标可能漏亮或不灭。`attentionPending.test.ts` / `sessionAttention.test.ts` 锁住了派生输入。
- 代价：1.5 秒宽限是经验值。pi 在 `agent_settled` 之后还要跑 `_prepareRun`（自动压缩、`before_agent_start` 扩展）才发 `agent_start`，这段超过 1.5 秒时仍会误报一次完成。
- 代价：Windows 开发态下 AppUserModelId 指向 electron.exe，通知标题可能显示「Electron」。
- 代价：应用内提示和系统通知按「会话一个」去重，并行跑很多会话时仍可能一下弹多条。
- 已知没做（审查列为 Minor、延后）：`stopReason: 'length'` 的回合不留结果；归档会话的未读在取消归档后重新出现、删除整个对话目录时不清未读；切换 `notify.taskbar` 要等计数变化才生效；折叠的项目头把已提到置顶区的会话也算进计数、「显示更多」里藏着的会话没有指示；角标 span 没有 `role="img"`；打包的 AppUserModelId 和 `electron-builder.yml` 各写一份。
- 侧栏行尾格同时承载转圈、注意角标、归档与「更多」按钮，和同日的 [会话归档](./2026-10-19-session-archive.md) 共用。请求来源参见 [子代理审批经父会话](./2026-10-12-subagent-approvals-via-parent.md)（`uiPromptStore` 队列）与 [视觉设计按会话绑定](../bug-fix/2026-10-16-visual-design-session-binding.md)（`visualStore` 按 owner 存 pending）；区头汇总接在 [侧栏分区折叠](./2026-10-19-sidebar-section-collapse.md) 的 `SidebarSectionHeader` 上。

## Verification

结果：部分通过。自动化全部通过；真实应用里的 Windows 系统通知、任务栏闪烁与覆盖图标、行动中心点击没有实跑。

- `cd electron-agent && npx vitest run electron/app/attentionService.test.ts electron/ipc src/features/settings src/stores src/features/sessions src/features/attention src/features/extensionUi src/features/visual`（加上所有引用 ExtensionUiHost / visualStore / 侧栏条目的测试文件）：701 条通过。覆盖优先级、宽限与 Goal 续跑（含 settled 晚到）、source 过滤、中断不改结果、异写路径认成同一会话、受阻转变与延迟对上会话、派生四个 store、视觉设计 dismiss 与回合结束清 pending、通知器开关分流 / 同会话替换 / IPC 往返期间状态已清 / 系统通知收回 / 启动清旧图标 / 计数、主进程路由 / 行动中心引用 / clear / 乱序 badge / 覆盖图标 / 闪烁 / 点击还原窗口、IPC 校验、设置默认值、分区收起的会话路径。日志在 `.agents/evidence/2026-10-19-session-attention-badges-and-notifications/vitest-final.log`；终审修复轮加了 19 条先 RED 后 GREEN 的用例，修复前的一轮是同目录的 `vitest.log`（556 条）。
- `node ui-harness/check.mjs session-row`：68 条通过（五种角标的图标与颜色对照主题 token、审批压过转圈、选择在呼吸、悬停让位给「更多」、400ms Tooltip 与截断、折叠分组头与收起区头的汇总、浅色主题）。`node ui-harness/check.mjs attention-toast`（新场景）：27 条通过，连跑三次稳定（Goal 续跑不冒完成、完成 10 秒内收起、失败「前往」打开会话、审批 9 秒后仍在且答复后收起、计数 1 → 0、当前会话不提示、深浅主题浮层色）。渲染真实侧栏的 `session-archive` 47、`isolated-workspace` 53、`sidebar-sections` 59 条通过。日志是证据目录的 `ui-check-after-review.log`、`ui-check-session-row-final.log`，截图是同目录的 `session-row-attention-*.png`、`attention-toast-*.png`。
- 类型：临时 tsconfig 覆盖本次改动的渲染层文件、`tsconfig.node.json` 覆盖主进程，改动文件没有报错。
- 没有实跑的原因：这个检出能起的 Electron 实例只有正在承载这次会话的 GrenAgent 开发版（`out/` 被它占着），重启会打断会话；另起一个实例会和它共用 `~/.pi/agent` 与 userData。重启应用后按下面四步手动核对，有不符就开 bug-fix 笔记：
  1. 开两个会话，让 B 跑一个要几十秒的任务后切到 A；B 跑完后侧栏出绿点，点开消失。
  2. 设置里打开「会话完成」，重复 1：出现应用内提示，「前往」打开 B。
  3. 让 B 调 ask_user 后切走窗口：出现 Windows 系统通知、任务栏图标闪烁并显示数字 1；等横幅收进行动中心后从行动中心点它，窗口拉起并打开 B；答完数字消失、行动中心那条也被收掉。
  4. 关掉「需要选择或批准」，重复 3：只有侧栏蓝色角标，没有通知、不闪烁。
