# Agent Note: 会话归档：主进程登记表 + 侧栏「已归档」弹窗

Status: implemented

## Problem

侧栏里的会话只能置顶、重命名、删除。用完但还想留着的会话要么一直堆在列表里，要么删掉（不可恢复）。缺一个「从列表里拿走、文件和历史都还在、随时能找回来」的操作。

## Decision

- 落盘：主进程 `WorkspaceService` 维护 `~/.pi/agent/archived-sessions.json`（`{ "sessions": [<会话路径>...] }`），读写方式同 `opened-projects.json`。按会话路径记（调用方给的拼法，即列表里的 `path`），比较时用 `normalizePath`。会话 jsonl 原地不动。读不出（不存在、坏 JSON）当作空表。读改写经 `archiveQueue` 排队，并发的归档 / 取消归档 / 清理不会互相覆盖。
- 列表：`list_all_sessions` / `list_pi_sessions` 照旧返回全部会话，归档的带 `archived: true`，没归档的不带这个字段（旧的精确形状断言不受影响）。孤儿对话目录清理、草稿复用判断看到的仍是全部会话，归档对话的目录不会被当成孤儿删掉。全量扫描时，登记表里文件已经不在的路径顺手去掉。
- IPC：`set_sessions_archived { sessionPaths: string[], archived: boolean }`。归档时每个路径必须在 sessions 目录下、是 `.jsonl`、读得出来且不是隐藏会话（子代理 / 系统短调用）；取消归档不校验（文件没了也能清登记）。`deleteSession` 和按工作区删会话（删对话、清空项目、移除项目）都会从登记表去掉对应路径。
- 顺带修了 `isWithin`：原来只按 parent 的长度切掉前缀、不检查前缀是否真是 parent，同长的兄弟路径（如 `<agentDir>/outside.jsonl` 对 `<agentDir>/sessions`）会被当成在 sessions 目录里。`deleteSession`、`setSessionDisplayName` 用的是同一个函数，一起收紧。
- 渲染层：
  - `SessionInfo.archived`；`visibleSessions()`（磁盘 + 乐观占位，去掉乐观删除的和已归档的）供 `useConversations` / `useProjectGroups` 以及删除 / 归档后挑下一个会话用；`archivedSessions()` 供弹窗用。
  - 会话行（对话行和项目会话行都是 `SessionItem`）悬停时，「更多」左边紧挨着一个归档按钮（间距 2px，同 RowActions），点了立即归档、不弹确认、不触发整行打开。回合在跑的行不出这个按钮。
  - 菜单在「重命名」和分隔线之间也有「归档」，同样不弹确认。回合在跑时置灰并写「归档（运行中不可用）」；`archiveSessionPaths` 再按运行态挡一次。
  - `features/sessions/archiveActions.ts`：乐观标记（同时 bump 会话变更代次、作废全量列表缓存）→ 调主进程 → 失败回滚并报错。App 和 ui-harness 场景用同一份。
  - 项目会话按单个路径归档；「对话」一行代表 works 下一个目录，归档时目录下全部会话一起归档，否则次新的那份会顶上来。
  - 归档的是正在看的会话：项目切到同项目最近的可见会话，没有就进新会话草稿；对话切到最近的另一个可见对话，没有就新建对话。
  - `pickAutoSelected` 跳过 pi 恢复出来的已归档会话，改选最新的可见会话；`goToSafeWorkspace` 也跳过已归档的。
  - 侧栏底部「已归档 N」（N 为 0 且弹窗关着时不显示）→ 弹窗按时间倒序列出（标题、所属项目名或「对话」、时间），每行「查看 / 取消归档 / 删除」。查看用 `ReadonlySessionView`（从独立工作区的只读查看抽出来的共用组件，读 JSONL、不起运行时、没有输入框），底部也能取消归档。删除二次确认后走 App 现有的 `handleDeleteSession`。

## Alternatives considered

- **渲染层 localStorage（和置顶同一个 `sidebarPrefsStore`）**。最强理由：零后端改动，置顶就是这么做的。不用：归档是「这份会话不在主列表」的事实，主进程的自动选中、以后别的入口都可能要知道；放在 localStorage 里，清缓存就全回来，主进程也拿不到。
- **把 jsonl 挪到单独的 archive 目录**。最强理由：物理分开，扫描天然不列它。不用：子代理会话的 `parentSession`、置顶、UI 历史 key、停靠标签都按路径关联，挪一次要全部改写；被 handle 持有的会话挪走后 SDK 还会往原路径 append。
- **往会话 jsonl 里追加一条归档条目（像 `session_info` 那样）**。最强理由：状态跟着文件走。不用：自定义条目要接进 pi 的条目树（id / parentId），绕过 SessionManager 直接 append 有破坏会话树的风险；取消归档还得再追加一条。
- **允许归档运行中的会话（先停掉回合再归档）**。最强理由：少一个置灰状态。不用：停回合是破坏性的，归档不该顺带打断工作；用户选了「运行中不能归档」。
- **已归档列表放进设置页 / 侧栏末尾的折叠分区**。用户选了侧栏底部入口 + 弹窗：不占主列表，也不用离开对话界面。

## Consequences

- 收益：归档可逆、不碰会话文件；重启后状态保留；删除会话时登记表跟着清。
- 代价：登记表按路径记。有人在外部挪动会话文件，归档状态会丢，会话重新出现在侧栏（不丢数据）。
- 代价：主进程不校验运行态，只靠渲染层的运行态判断。判断不准时可能归档一个刚开始跑的会话，它会在后台跑完，结果仍可在已归档弹窗里查看。
- 记忆详情等「打开来源会话」的入口仍可以打开已归档会话（显式导航，没有拦）；这时会话区显示它，侧栏里没有对应行。
- 所有项目会话都归档、且项目没登记在 `opened-projects.json` 时，项目组会从侧栏消失（和没有会话的未登记项目一样）。

## Verification

- `cd electron-agent && npx vitest run electron/app/workspaceService.test.ts src/features/sessions src/lib/sessionSelect.test.ts src/lib/mergeSessions.test.ts src/features/isolatedWorkspace`：14 个文件 105 条通过。新增：两种列表都标归档且重启后保留、分隔符 / 大小写不同的拼法也能取消归档、重复不记两次、并发写排队、sessions 目录外 / 隐藏会话 / 不存在的文件拒绝归档、删除时清登记、全量扫描去掉失效路径、孤儿清理保留归档对话目录、坏登记表当空表；`visibleSessions` / `archivedSessions`；菜单项位置与置灰；右键归档不弹确认、运行中点了不触发；弹窗计数、倒序、所属位置、最后一条取消后显示空状态、删除先确认；`pickAutoSelected` 跳过已归档。日志：`.agents/evidence/2026-10-19-session-archive/vitest.log`。
- `node ui-harness/check.mjs session-archive session-row`（加行内归档按钮后复跑）：47 + 28 条通过。新增断言：静止时按钮不可见、只有悬停那一行出现、紧挨「更多」左边且同宽同高、点得到、点了不弹确认也不触发整行点击、运行中的行悬停没有按钮。日志 `ui-check-archive-button.log`，截图 `session-archive-hover-archive-button.png`。
- `npm run ui:check -- session-archive`（新场景，真实 Sidebar + 真实 archiveActions，主进程两个命令用桩）：首次 39 条断言全部通过。覆盖运行中置灰且不发请求、归档后行消失与计数、对话两份一起归档、弹窗倒序与位置文案、查看只读（正文加载、无输入框）、取消归档回到侧栏、删除取消 / 确认、浅色主题、Esc 关闭。截图与日志在 `.agents/evidence/2026-10-19-session-archive/`。
- 改了 `IsolatedWorkspaceDialogs`（只读查看抽成共用组件）和 `SessionItem`，加跑 `node ui-harness/check.mjs isolated-workspace session-row`：53 + 28 条通过。
- 没有在真实 Electron 主窗口里端到端点过（仓库没有 verify-* skill）；App 里「归档当前会话后切走」的分支没有自动化覆盖，靠复用现有的 `handleOpenSession` / `handleNewSession` / `handleNewConversation`。
