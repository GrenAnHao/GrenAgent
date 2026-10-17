# Agent Note: Goal 条按会话路径补拉，不再只靠一次性推送

Status: implemented

## Problem

两个现象，同一个根子：

- 重启后第一次打开一份有未完成 Goal 的会话，输入栏上方没有 Goal 条；切到别的会话再切回来才出现。Goal 事件一直在会话 JSONL 里，没丢。
- 回合跑着的时候发 `/goal <条件>`，Goal 条不出现，要等这一轮结束（或切会话）才出现。

渲染层拿 Goal 只有一条路：扩展在 `session_start` 和每次写事件后 `ctx.ui.setStatus("goal", …)` 推一次。Goal 条（`GoalPill`）再用 `pi.getState(workspace)` 读一次 sessionId，只在 `workspace` / `activeSessionPath` 变化时读，读不到或对不上路径就一直不显示。

- 推送是即发即弃。重启时 agent-host 子进程起 handle、触发 `session_start` 的那一刻，窗口可能还没就绪（`broadcastPiEvent` 对没就绪的 webContents 直接丢弃），会话也可能根本没上 handle（只读了文件）。丢了就没有第二次，直到切会话再触发一次 `session_start`。
- 回合跑着时：真实 SDK + faux 模型实测（`extensions/goal/goal-live.real.test.ts`），工具卡在半路时发 `/goal`，扩展命令当场执行、当场 `setStatus("goal")`，主进程转发也没有排队。卡住的是渲染层：Goal 条的 sessionId 只靠切换会话时那一次 `getState`，没有别的途径能补上。这一条没有在真实应用里逐步复现，修法把两处一次性依赖都去掉了。

## Decision

- 主进程加只读命令 `agent_get_goal`（`targetSessionPath` 指定会话）：会话在某个 handle 上就读 `session.sessionManager.getEntries()`（含还没落盘的条目），不在就 `SessionManager.open` 读会话文件；不起 handle、不触发 `session_start`、不进回合队列，回合跑着也立刻返回。会话文件要属于该项目，否则 `SESSION_WORKSPACE_MISMATCH`。
- 返回的信封和扩展推送是同一份形状，由 `extensions/goal/status.ts` 的 `buildGoalStatus` 生成，扩展的 `pushStatus` 也改用它。
- 武装态（armed / disarmed）仍不落盘，存在 `globalThis[Symbol.for("gren.goal.activations")]`：扩展经 jiti 加载、主进程直接 import，两份模块实例看到同一张表，补拉才能拿到真实的武装态。不在 handle 上的会话一律 disarmed，与重开默认一致。
- 渲染层 `goalStore` 记「会话路径（`sessionControlKey`）→ sessionId」：推送信封带 `sessionPath`，补拉结果也带，都会登记。`GoalPill` 按 `activeSessionPath` 查 sessionId，不再调 `getState`；挂载和每次切换会话都补拉一次；Goal 条、详情抽屉、输入栏 `/goal` 命令返回后再补拉一次。
- `goalStore.setSnapshot` 对同一 goalId 改为只拒更旧的 revision，同 revision 也覆盖：武装 / 解除武装不写事件、不涨 revision，原来的 `<=` 会把只改了 activation 的推送丢掉。
- 解析信封的 `parseGoalStatus` 从 `ExtensionUiHost` 挪到 `features/extensionUi/goalStatus.ts`，推送和补拉共用。

### 涉及文件

- `extensions/goal/status.ts`、`extensions/goal/session.ts`
- `electron-agent/electron/app/piRuntimeService.ts`、`electron-agent/electron/ipc/register.ts`
- `electron-agent/src/lib/pi.ts`、`electron-agent/src/stores/goalStore.ts`
- `electron-agent/src/features/extensionUi/goalStatus.ts`、`ExtensionUiHost.tsx`
- `electron-agent/src/features/chat/input/GoalPill.tsx`、`SessionGoalDrawer.tsx`、`electron-agent/src/features/chat/ChatView.tsx`

## Alternatives considered

- **主进程缓存最后一次 `setStatus("goal")`，窗口就绪后重放**：改动最小，不用碰扩展。不用：会话不在 handle 上（重启后只读了文件）时根本没有推送可缓存；按窗口生命周期重放还要处理多窗口、热重载，和「切会话就该拿到那份会话的 Goal」不是一回事。
- **补拉时让扩展再推一次（主进程替渲染层发 `/goal` 查询）**：复用扩展现成的查询分支。不用：查询会弹回执通知，要走一次 `prompt`，会话不在 handle 上时还得为此起 handle、触发 `session_start`（可能按 `autoContinueOnOpen` 把续跑也拉起来）。
- **照 DSH 把 Goal 做成会话投影，打开会话时随历史快照一起下发**：DSH（`packages/api/session-controller/src/history.ts` 的 `projections`）就是这么做的，最彻底。不用：我们的会话打开流程是 `agent_get_messages` 读消息，没有投影层；单独一条按路径的只读命令能达到同样效果，不用为此搭投影基建。
- **保留 `getState` 取 sessionId，只加补拉**：改动更少。不用：`getState` 只回前景会话，路径对不上就整条不显示，正是回合跑着时不出条的嫌疑点；补拉本身就带回 sessionId。

## Consequences

- Goal 条不再依赖推送是否送达：打开、切换、命令返回都会按路径对一次账，推送只是更快的增量。
- 武装态放进进程级全局表，同一进程里的扩展实例共享它；测试之间要清，用 `__resetGoalActivationsForTest`。
- 补拉响应和推送在同一 revision 上竞争时，后到的覆盖先到的；武装态可能短暂回退，下一次写事件（续跑轮次）会纠正。

## Verification

- 真实 SDK（faux 模型）：`cd extensions && npx vitest run goal/goal-live.real.test.ts` 通过。回合卡在工具里时发 `/goal`，`setStatus("goal")` 在 `isStreaming === true` 时已经推出、快照为 active；空闲时 `/goal` 返回时第一轮已经起来，推送里 `roundsStarted: 1`、armed。
- 扩展：`cd extensions && npx vitest run goal` 通过（12 个文件）。
- 主进程：`cd electron-agent && npx vitest run electron/app/piRuntimeService.test.ts` 通过，新增 `agent_get_goal` 三条：会话在 handle 上读内存条目且不发 prompt、不切前景；不在 handle 上读它自己的文件（重启后首次打开），别的项目读同一文件报 `SESSION_WORKSPACE_MISMATCH`；没有路径返回 null。
- 渲染层：`npx vitest run src/features/chat/input/GoalPill.test.tsx src/stores/goalStore.test.ts src/features/chat/ChatView.test.tsx src/features/chat/input/editor/MessageEditor.test.tsx src/features/extensionUi` 通过。GoalPill 新增：挂载即按路径补拉并显示（重启场景）；回合跑着时推来的信封按路径（大小写、分隔符不同）绑定后立刻出条；别的会话的推送不显示；命令返回后按会话路径再补拉。ChatView 新增：执行中设 `/goal` 立刻 `prompt`、不排进跟进、补拉 Goal。
- 全量：`cd electron-agent && npx vitest run` 部分通过：455 个文件通过，7 个文件 16 条失败（tencentdb、agentData、subagentService、taskViewService）。同样 7 个文件在基线上（stash 掉本次改动）复跑同样失败，与本次改动无关。记录见 `.agents/evidence/2026-10-18-goal-bar-pull-hydration/vitest.txt`。
