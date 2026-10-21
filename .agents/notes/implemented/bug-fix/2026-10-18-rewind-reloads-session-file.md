# Agent Note: 回退 / 重新生成 / 删除截断会话后，内存里的会话按新文件重读

Status: implemented

## Problem

「回退到此」之后，下一轮模型照样能读到被回退掉的回复。同一条路径上的「重新生成」（keep-target 截断再发）和「删除」、编辑后发送也一样：界面上的消息没了，模型上下文里还在。

原因在主进程 `PiRuntimeService.truncateSessionTo`：它把截断后的行写回会话文件，然后调 `handle.reload()`，以为这样内存会跟着文件走。但 pi 的 `AgentSession.reload()` 只重载设置、资源和扩展（`session_shutdown` → 重建运行时 → `session_start`），不重读会话文件。于是：

- `agent.state.messages`（下一轮发给模型的上下文）还是截断前的完整历史；
- `SessionManager` 的条目和 leaf 还停在被删掉的最后一条，下一条消息以已经不在文件里的旧 leaf 为 `parentId` 追加，文件里留下断链的条目。

原有单测把 `handle.reload` 换成了桩，只断言文件内容和「调过 reload」，测不到内存上下文。

## Decision

- 截断写盘后、`handle.reload()` 之前，先 `syncSessionFromDisk(session, sessionFile)`（`electron/app/syncSessionFromDisk.ts`）：
  - `sessionManager.setSessionFile(sessionFile)` 重读条目，leaf 落到截断后的最后一条（pi 自己 resume / 换文件就是这么做的）；
  - 再调 `AgentSession._refreshFinalizedContext()` 用新投影重建 `agent.state.messages` 和 entry id 映射，这是 pi 每次条目变化后自己用的方法；拿不到这个私有方法时按它的实现直接写 `agent.state.messages = sessionManager.buildSessionProjection().messages`。
- 然后照旧 `handle.reload()`：扩展的 `session_start(reason: reload)` 这时读到的已经是截断后的条目，按新条目重建自己的状态（Goal、todo 等）。
- 同步和 reload 放在同一个重试块里，失败一次再试一次；两次都失败仍抛「truncated on disk but in-memory session reload failed」。

## Alternatives considered

- **改用 pi 的 `navigateTree` / `branch()` 移动 leaf，不改写文件**。最强理由：完全走公开接口，pi 自己保证内存和文件一致。不用：被回退的条目会作为旁支留在文件里，`truncateSessionLines` 对有旁支的会话直接拒绝（`branched`），后续回退全部失效；界面「删除」的语义也是真删。
- **截断后用 `switchSession(sessionFile)` 重新打开同一个文件**。最强理由：公开接口，会话对象整份重建。不用：会替换 handle 持有的 session 实例、触发 `session_shutdown`，后台任务、子代理、MCP 连接都会跟着收口，代价远大于重读一份条目。
- **只改 `agent.state.messages`，不动 SessionManager**。不用：leaf 还指向被删的条目，下一条消息的 `parentId` 断链，重启后从文件恢复的历史会对不上。

## Consequences

- 收益：回退、重新生成、删除、编辑后发送之后，模型看到的上下文和文件、界面一致；新条目接在截断点后面。
- 代价：依赖 pi 1.3.0 的私有方法 `_refreshFinalizedContext`；退路依赖公开的 `buildSessionProjection`。`syncSessionFromDisk.test.ts` 用真实 `SessionManager`、真实 `Agent` 和 `AgentSession.prototype._refreshFinalizedContext` 测，pi 改了这些会先红。
- 已知未改：`handle.reload()` 仍会走一遍扩展的 shutdown / start，开销和原来一样。

## Verification

- 先写回归测试再修：`cd electron-agent && npx vitest run electron/app/piRuntimeService.test.ts -t "回退到此截断后"`，在去掉同步调用的代码上失败（模型上下文里仍有「被回退掉的回复」），日志 `.agents/evidence/2026-10-18-rewind-reloads-session-file/vitest-red-before-fix.txt`；修好后通过。
- `npx vitest run electron/app/piRuntimeService.test.ts electron/app/syncSessionFromDisk.test.ts electron/app/cancelQueuedSteer.test.ts` 通过（79 条），日志 `vitest-green.txt`。覆盖：drop-target 后上下文只剩截断点之前；新消息的 `parentId` 是截断点而不是被删的旧 leaf；keep-target 后上下文停在那条用户消息；没有私有方法时按投影写回；会话管理器不能重读时报错进入重试。
- 同目录下 `electron/app` 其余失败（`subagentService`、`taskViewService`、`electron/agentData/*`）不引用改动的文件，是已有失败，不在本次范围。
- 没有在真实 Electron 会话里配真实模型点一遍回退再问（需要真实模型请求）；内存上下文的断言由上面用真实 pi 对象的测试覆盖。
