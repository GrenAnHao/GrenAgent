# Agent Note: 会话卡在「执行中」、停止点了没反应

Status: implemented

## Problem

用户报告侧栏有一行一直转圈，点停止没有任何可见效果，也不能重新发起。现场是 `D:/OneDrive/Project Files/Pi` 项目第一行会话（`2026-11-03T09-04-33-205Z_01a1a0a7-…jsonl`，17:04 创建「推送到 GitHub 并编译…」）。

取证结论（真实数据，非推断）：

- 该会话 JSONL 最后一条是 19:11:50 的 assistant（`stopReason: "stop"`，正文「四路 job 全绿」），之后没有任何日志；对应 UI 历史最后一条也是同一时刻的 assistant，没有 trailing 的 running 工具卡。所以「还在跑」只存在于界面状态里，后端早就不跑了。
- `%APPDATA%/electron-agent/logs/runtime-diag.jsonl` 里 11:17:45 与 12:08:47 两次 `agent_abort` 各在 2–4ms 内返回（那两次确实把回合收掉了），但代码路径上没有任何超时上限：SDK 的 `abort()` 是 `agent.abort()` 后 `await waitForIdle()`，回合卡在不响应中止的等待里时这个 await 永不返回，`ChatView.handleAbort` 的 `await pi.abort(...)` 之后的 takeSteering、收尾、界面状态更新全都不会执行 —— 表现就是「点了没反应」。
- 目标会话已不在任何 handle 上时 `agent_abort` 直接 `return undefined`（`electron/app/piRuntimeService.ts` 的 ROUTED_COMMANDS 分支），渲染层拿不到任何可据以收敛的回执，只能继续显示停止按钮。
- `agent-data.db` 的 `turns` 表里同样留着尾巴：5 条 `status='running'` 且 `completed_at` 已写，另有 1 条 `queued` 永久不动（今天 19:17 那条「依旧失败的很」）。这印证「没有终态事件 = 永远在跑」不只影响界面。

根因是三条彼此独立的收敛缺口叠加：

1. **停止没有收口上限。** 前端与后端都把它挂在「SDK 必然闲下来」上。
2. **运行态只认事件。** 侧栏按 `agent_start` 点亮、`agent_end` / `agent_settled` / `pi://exit` 熄灭，没有第二条熄灭入口；用户点停止也不投递任何运行态事件。
3. **快照对账以项目为单位保留。** `reconcileRunningSessions` 用「等待快照期间这个 workspace 有没有新事件」决定整份快照是否作废。同项目里 A 跑完丢了终态事件、B 又开始跑，项目级纪元一变，A 的陈旧条目就永远躲过对账。

## Decision

只收敛状态，不改执行语义。四处改动：

- **后端 `agent_abort` 有收口上限。** 新增 `abortSession()`：`Promise.race([session.abort(), 10s])`。正常返回 `{ stopped: true, aborted: true }`；到点仍未 idle 返回 `{ stopped: true, aborted: true, reason: 'timeout', isStreaming }`，中止请求本身已经发出，后台继续等 SDK 闲下来，闲下来后照常发终态事件。目标是「用户看到它停」而不是「假装 SDK 停了」，所以超时也回报 `stopped`，但如实带 `reason`。
- **会话不在任何 handle 上时的停止回报「已停」。** 没有承载它的 handle 就没有在跑的回合，返回 `{ stopped: true, aborted: false }` 而不是 `undefined`，渲染层据此收掉运行态。
- **`agent_settled` 兜底收口回合登记。** 以前 `adaptPiEvent` 不为 `agent_settled` 产出投影，函数到那里就 `return`，`activeTurns` 只能靠 `agent_end` 清。`agent_end` 一旦丢（拆除 handle 时不再转发、订阅器报错丢单条），`listRunningTurns()` 就会把已结束的会话继续报成在跑，渲染层重载后侧栏又亮、停止又没有可停的回合。现在 `agent_end` 与 `agent_settled` 共用 `settleTurn()`，后者只在登记还在时兜底，并保留 `releaseIdleParked`。
- **前端停止是确定的、可观察的。**
  - 点下去立刻置 `isStreaming/runActive/awaitingResponse = false`，并 `markSessionStopped(path)` 熄灭侧栏那一行，不等后端终态事件。
  - `pi.abort` 与 `takeSteering` 都套 `withTimeout`（12s），后端卡住也不会把停止按钮永久挂住；超时/回执 `reason: 'timeout'` 时保留不再显示「在跑」，并用错误条如实说明「已请求停止，但这一轮还没有结束」。
  - 并发入口（停止按钮、重试条的「取消」、错误条）共用一次 `abortInFlightRef` 收尾，连点只发一次 abort、只算一次引导。
  - 超时路径不丢数据：已经从后端取出的引导放回跟进队列，不因为这一轮没停下就被吞掉。
- **快照对账改成按会话。** 纪元拆成两层：会话级键（`runningSessionKey`，JSON 数组，路径按 `pathsEquivalent` 规则归一）与项目级键（只有「没有路径的 pi://exit」才 bump）。对账时 `keepPaths` 里的会话由实时事件决定、快照不覆盖；其余会话严格按快照熄灭。同项目里另一个会话开始时只改它自己的会话纪元，不再让整份快照作废，丢掉终态事件的条目因此能被清掉。

## Shared callers

- `electron/app/piRuntimeService.ts`：`agent_abort` 的返回契约变了（从 `undefined` 变成 `AbortResult`）。调用方是渲染层停止按钮、Ctrl+Enter 中断发送、错误条取消；`mainBindings` / `runtimeGraph` 只是转发，不解析返回值。删除会话前的 abort（`releaseSessions`）走的是 `session.abort()` 本身，不经过这个分支。`agent_settled` 分支新增兜底收口，所有交互回合与 goal 回合都会经过（`source === 'goal'` 的事件本来就在入口被过滤，行为不变）。
- `src/features/chat/ChatView.tsx`：`handleAbort` 拆成 `abortOnce` + 并发去重外壳，对外签名不变；影响所有「点停止」场景（正常中断、空轮中断、失败等待中断、带排队跟进的中断）。
- `src/stores/runningSessions.ts` / `src/stores/restoreRunningTurns.ts`：`reconcileRunningSessions` 新增第三个参数 `keepPaths`（向后兼容，默认空集）；`workspacesMovedSince` 语义收窄为「整个项目退出」；新增 `sessionsMovedSince` / `runningSessionKey` / `markSessionStopped`。影响侧栏运行态、归档禁用、Plan 面板的运行判断。
- `src/lib/pathUtils.ts`：新增 `pathKey`（与 `pathsEquivalent` 同一套归一规则），纯新增。

## Alternatives considered

- **只在前端收掉状态，不动后端。** 改动最小，但后端回合仍在跑、`listRunningTurns` 仍会把它报成运行，重载或切回后侧栏又亮；而且不会触发 `releaseIdleParked`，停靠的 handle 泄漏。不够。
- **超时后在主进程强制 dispose handle。** 能保证「确实不跑了」，但会把句柄里还在跑的子代理、后台任务、未落盘的回合一起杀掉，属于把状态问题升级成数据丢失。不采用；保留后台等 SDK 自己闲下来。
- **让停止也发一条运行态事件（复用 `agent_end` 形状）。** 收口干脆，但会往事件流里注入假终态：`adaptPiEvent` 会据此把 `turns` 记成 completed/cancelled，而 SDK 那边可能还在跑；一旦真终态随后到达，就成了两次收尾。改成「单独一条 `markSessionStopped` 只影响侧栏 + 后端如实回执」，状态和事实分开。
- **对账时按 timeout 强制清空所有运行态。** 简单粗暴，但会把真正在跑的会话也熄灭，用户会看到停止按钮消失而实际还在跑。改成会话级对账，只清「快照里没有且自己没动」的条目。

## Consequences

- **收益**：停止在任何情况下都有可见结果；侧栏与内容区不会因为丢失终态事件而永久停在「执行中」；`listRunningTurns` 不再把已结束的会话报成在跑，重启/重载后也不会复活；`turns` 表不会再因为 `agent_settled` 兜底而永久停在 running（历史遗留行仍是脏数据，需另行清理）。
- **代价**：停止的上限是写死的 10s / 12s。真正「慢但会结束」的中止（例如一个必须等外部进程退出的工具）现在会被判成 timeout：界面先收起，稍后 SDK 闲下来再补终态。这里选择优先保证用户可见的确定性，而不是等它自己好。
- **代价**：`workspacesMovedSince` 的语义收窄，只有整个项目 runtime 退出才置位。若将来有别的场景需要「项目级」保护，需要显式调用 `bumpProject`。
- **重访信号**：停止后很快又出现「在跑」（说明 timeout 太短或后端仍在跑）；或者真有会话在跑却被对账熄灭（说明会话级 keep 漏了某个事件路径）。

## Verification

- `cd electron-agent && npx tsc -p tsconfig.json --noEmit`：通过。
- `cd electron-agent && npx vitest run src/stores electron/app/piRuntimeService.test.ts src/features/chat/ChatView.test.tsx`：42 个文件 654 条全过。新增覆盖：
  - `agent_abort` 按时收口回报 `{ stopped: true, aborted: true }`；
  - abort 卡在 `waitForIdle` 上时（永不 resolve），推进 10s 后回报 `reason: 'timeout'`；
  - `agent_settled` 单独到达（`agent_end` 丢失）也把回合登记与 `turns` 收掉，之后迟到的 `agent_end` 不重复收口；
  - 目标会话不在任何 handle 上时 abort 回 `{ stopped: true, aborted: false }` 且不落到别的会话；
  - 同项目另一个会话开始时不清掉陈旧条目的保护、不误熄真正在跑的会话；
  - 停止在等待期间自己收尾时不被过期快照重新点亮；
  - 用户点停止立刻熄灭侧栏那一行，不等终态事件；
  - 后端回执 `reason: 'timeout'` 时本地运行态仍收起并如实提示；
  - 连点三次停止只发一次 abort、只取一次引导；
  - 空闲时点停止不残留运行标记；
  - 超时时已取出的引导回到跟进队列。
- 未跑 `npm run ui:check`：改动不在渲染组件与样式，运行态由 store 驱动，单元测试已覆盖；`session-row` 场景只验证转圈与「更多」的几何关系，本次未改。
- 现场那一行（`01a1a0a7`）是历史数据，代码修好后再打开时 `restoreRunningTurns` 会按快照判它已结束并熄灭；`turns` 表里的 5 条历史脏行不在本次改动范围（属数据清理），未顺手改。
