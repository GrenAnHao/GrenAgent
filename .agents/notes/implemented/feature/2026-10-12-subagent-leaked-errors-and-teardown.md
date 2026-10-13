# Agent Note: 子代理的漏网错误归属与释放边界

Status: implemented

## Problem

[子代理重新设计](../architecture/2026-10-11-subagent-redesign.md)第 3 节核查过错误的去向：工具异常在 SDK 里都会转成错误结果，或者在整轮边界结算。漏网的只有不被 await 的异步工作（定时器、事件回调、fire-and-forget promise）抛出的错误，它们落到进程级的 `uncaughtException` / `unhandledRejection`。第 3 节对此提了两条建议（1、2），用户确认过，当时留作后续项。动手前查到的现状：

- **agent-host**（`electron-agent/electron/agentProcess/hostEntry.ts`）的两个全局处理器只打日志、不退出。出错的子代理不知道是谁，也不会结算，一直显示「运行中」。
- **worker 进程**（`cli/src/pi-worker.ts`）的全局处理器只在 EPIPE 时退出，别的错误连日志都没有，悄悄吞掉。
- **释放路径**没有逐步收：
  - 一次性运行收尾时 `session.dispose()` 或删派生配置抛错，子代理的真实结果被换成一条错误，输出丢失。
  - 可续聊子代理结算时 `dispose` 抛错，结算停在半路：Activation 不删、父会话收不到通知、`wait_agent` 一直等、名额不还。结算监视是不等结果调用的，还会再变成一个漏网的 rejection。
  - `disposeActivation` 逐个关自己的子代理，中间一个抛错，后面的都不关。
  - 注册表写失败时，后台运行和可续聊子代理的名额不还。
- **不等结果的 promise** 有几处没挂 `.catch`：
  - `deliverToChild`；
  - inbox 里的 `session.prompt`（worker 已退出时会拒绝；消息没送到，子代理还会一直等它忙起来）；
  - `cancel.ts` 的 `disposeActivation`；
  - 几处 `session.abort()`；
  - 后台运行的结算链。

## Decision

用户确认的 4 个选择：

1. 漏网错误归到某个在跑的子代理，就中断它这一轮，按 error 结算；已经结算的只记日志。
2. worker 里的错误转给 agent-host，按同一套结算。
3. 释放步骤出错不改结算结果，只记日志。
4. 归属用自己的 AsyncLocalStorage，不等另一条修复。

### 归属：`extensions/_shared/leak-owner.ts`

- **单独一个 AsyncLocalStorage**，只存子代理 id。放在 `_shared/`，因为 MCP 扩展也要用它（见下面「共用资源」）。
  - 不复用 `WorkspaceContext`：那份管配置；而且子代理去唤起别的会话时要离开子代理身份，时机和配置上下文不一样。
  - 另一条还没合入的修复（续聊回合跑在子代理自己的配置上下文里）改的就是 `WorkspaceContext`。两边改的是同一批入口，合并时要手工对一下。
- **在子代理每一轮开始的地方进入 `runAsChild(childId)`**：
  - 一次性运行（`runEmbeddedSubagent`）；
  - 可续聊子代理的第一轮（`startContinuableEmbedded`）；
  - `deliverToChild` 里的投递（父代理 `send_message`、主进程唤起的轮次也算子代理的）；
  - 冷恢复（`coldResumeAndDeliver`，含重建会话）；
  - 子代理作为父会话的宿主收到的 `sendMessage` / `prompt`。
- **离开**：
  - 父会话宿主登记表（`registerParentSessionHost`）把每个宿主的 `sendMessage` / `prompt` 包在 `outsideChild` 里。子代理唤起父会话时，父会话这一轮的错误不算子代理的；父会话自己是子代理时，它的宿主再进入它自己的身份。
  - 退回扩展 API 投递结算通知（父会话没有宿主时）：调 `spawn_agent` 时记下调用方自己的子代理身份。它是子代理就进入它的身份（例如一次性子代理又派了后台孙代理），否则离开。
- **共用资源**：MCP 管理器是整个工作区共用的。建连接（`realConnect`）和开配置监听（`start`）放进 `outsideChild`，否则子代理的会话先碰到它时，传输层以后的回调都带着那个子代理的身份。
- **实测**：Electron 38（Node 22.22）和 Node 25 里，定时器里抛错、裸 reject、`await` 之后的 reject，进程级处理器里都读得到出错那一刻的 ALS。
- **agent-host**：
  - `uncaughtException` 马上交给归属到的子代理。
  - `unhandledRejection` 等 1 秒（`LATE_HANDLE_GRACE_MS`），期间收到 `rejectionHandled` 就撤销。常见写法是先起一个 promise、等别的、再 await 它，Node 会先报 `unhandledRejection`、接住时再报 `rejectionHandled`，这不是漏网错误。归属在报出来的那一刻取。
  - 日志里写上子代理 id，已经结算的写「already settled」。进程照旧不退出。
- **worker**：`worker-host.ts` 在 subagent 模式另装处理器，同样的 1 秒等待。
  - 先按本进程的归属：归到 worker 里的进程内孙代理的，交给孙代理（它已经结算就只记日志），不转给宿主。
  - 归不到就记 stderr，再发 RPC 事件 `leaked` 给宿主。
  - 宿主侧 `WorkerSessionProxy` 按它托管的子代理 id 交给同一套处理，并记一行日志（worker 的 stderr 宿主只留尾巴）。
  - 正在关的 worker 报上来的只记日志：同一个子代理可能刚冷恢复出新的激活。
  - 冷恢复时子代理 id 由 `coldResumeAndDeliver` 直接传进来。

### 结算

- **一次性运行**：建会话之前就登记处理器，扩展初始化时漏出来的也算。
  - 收到错误就记下原因、中断会话；建会话时就出错的不再开跑。
  - 错误到在 prompt 的 preflight 期间时，那时的中断会被起跑重置，所以起跑后再中断一次。
  - 结果为 `ok: false`、`stopReason: "error"`、`error: "uncaught error: <消息>"`、`exitCode: 1`，已经写出的部分保留为 partial。前台回给模型，后台照常发结算通知。
- **可续聊子代理**：Activation 存续期间登记处理器（撤销放在 `unlinkFromParent`）。建会话期间的错误先记着，装上 Activation 后交给它。
  - 收到错误时记下 `failure`；会话在跑就中断这一轮，并叫醒等待方。
  - 会话看着空闲、其实有消息还在 preflight：结算监视接着等，等它跑起来再中断（开始监视时也查一次）。否则它会在结算之后跑在驻留的会话上。
  - 出错之后不再收消息：`deliverToChild` 报 `ACTIVATION_FAILED`，让发送方等结算通知后再发。
  - 结算时排着的消息不会再被处理（SDK 的 `abort()` 不清队列）：用 `clearQueue` 清掉，诊断里写明丢了几条。worker 会话没有这个方法，它结算即退出，排着的消息随进程没了。
  - 结算时按 error，通知的 Diagnostic 写原因；`onSettled` 带上 `diagnostic`，注册表的 error 字段记它。
  - 照 DSH 不销毁：结算后照常进驻留池，之后还能续聊，下一次激活重新算。孙代理还在跑时照旧等它们。
- **消息没送到**（inbox 的 `session.prompt` 被拒）：按同样的方式失败，诊断写 `message delivery failed: …`。原来子代理会一直等它忙起来。
  - inbox 投递一律带 `streamingBehavior`（SDK 只在会话正在跑时用它）。空闲时连发两条，第二条要等第一条的 preflight 走完、开始跑之后才走到那道检查，原来会报「Agent is already processing」被悄悄丢掉；有了上一条，它还会让子代理失败。
- **结算监视本身出错**（例如等空闲被拒）：在子代理锁里强制按 error 结算，诊断写 `settlement failed: …`。

### 释放边界：`extensions/multi-agent/teardown.ts`

- 每一步单独 try/catch，失败的步骤汇总成一行日志：`[multi-agent] sub-agent <id> teardown failed: <步骤>: <原因>; …`。结算结果仍按子代理自己的结果。
- 覆盖的地方：
  - 一次性运行收尾（撤归属、停事件转发、清定时器、解绑中断信号、销毁会话、删派生配置）；
  - 可续聊子代理的结算 `settleNow`：释放会话（驻留或销毁）、撤归属、撤宿主登记、撤审批路由、叫醒父 Activation、通知父会话、`markChildSettled`、记账；
  - `disposeActivation`：每个孙代理单独 try/catch，子先父后；
  - 可续聊启动失败的回滚；
  - `cancelSubAgent`；
  - 后台运行和可续聊子代理的记账：注册表写失败也照样摘 inflight、还名额。
- 不等结果的 promise 补上 `.catch`：
  - `deliverToChild`；
  - inbox 的 `prompt`；
  - 结算监视；
  - `cancel` 后的 `disposeActivation`；
  - 后台运行的结算链；
  - 各处 `abort`（`abortQuietly`）。

## Alternatives considered

- **复用 `WorkspaceContext`，加一个子代理 id 字段。**
  - 最强理由：现成的 ALS，工具本来就在它里面跑，不多一套。
  - 没选（用户选 4a）：
    - 续聊回合目前跑在调用方的 `WorkspaceContext` 里（另一条修复还没合入），子代理第二轮的错误会算到调用它的父代理头上，可能把父代理的这一轮误杀。
    - 子代理唤起父会话时要离开子代理身份，但父会话的配置上下文由它自己的宿主决定，两件事揉在一起不好改。
- **漏网错误只在日志里写明是哪个子代理，不中断、不结算。**
  - 最强理由：零误伤。原来只记日志就过去的小错误（某个扩展忘了挂 `.catch`），不会让子代理失败。
  - 没选（用户选 1a）：出错的子代理会一直显示「运行中」，父会话和 `wait_agent` 一直等。
- **`unhandledRejection` 一报出来就算（第一版的做法）。**
  - 最强理由：反应最快，不用记 promise、不用等。
  - 没选（代码审查指出，实跑复现）：先起一个 promise、等别的、再 await 并接住，Node 会先报 `unhandledRejection`，接住时再报 `rejectionHandled`。实跑第 4 项在第一版的构建上，把这样一个好好的子代理判成了 `uncaught error: CAUGHT_LATER`。
- **照 DSH，漏网错误让进程退出（fail-loud）。**
  - 最强理由：不带着坏状态继续跑。
  - 没选（设计第 3 节已定）：agent-host 里有所有工作区，一个子代理出错不该停掉全部。
- **释放失败一律按 error 结算，诊断写失败的步骤（DSH 的 `ACTIVATION_TEARDOWN_FAILED`）。**
  - 最强理由：父会话能看到释放出了问题。
  - 没选（用户选 3a）：活已经干完，结果有效；释放失败模型也处理不了，写进通知只会干扰它。

## Consequences

- **收益**：
  - 子代理里漏出来的错误不再让它一直「运行中」：按 error 结算，旁边的子代理不受影响，agent-host 不退出。
  - worker 里的错误第一次有了日志。
  - 释放时一步出错，不再丢结果、不再卡住结算、不再占着名额。
- **代价**：
  - 原来只记日志就过去的小错误（某个扩展忘了挂 `.catch`），现在会让子代理以失败结束。1 秒内接住的 rejection 不算。
  - 出过错的子代理在结算前不再收消息，排着的消息被丢掉（诊断里写明条数）。
  - 漏网 rejection 的中断晚 1 秒。
  - MCP 之外，子代理轮次里首次建出来、之后被别处共用的资源，它后来的错误仍会算到那个子代理头上：
    - 子代理还在跑，就会被误判失败；
    - 已经结算的只是日志里标错 id。
    - 现在只有 MCP 管理器是这样建的，已经放进 `outsideChild`。
  - 不在任何子代理身份里产生的错误（模块加载时起的定时器、主会话）照旧只记日志。
- **约束**：
  - 以后新增「让子会话开始新一轮」的入口，**must** 进入 `runAsChild`。
  - 新增「子代理去唤起别的会话」的出口，**must** 经父会话宿主登记表或 `outsideChild`。
  - 新增整个进程共用、会在子代理轮次里懒建的资源，**must** 在 `outsideChild` 里建。
- **没有处理的相邻问题**（审查时发现，不是本次引入）：取消可续聊子代理时不调 `onSettled`，派生配置不删、单会话名额不还，`openEmbeddedChildSession` 登记的审批路由也不撤。worktree `adoring-payne` / `heuristic-wu` 里有一条还没合入的「取消也结算」修复在改这一块，这里没动。

## 验证

仓库里没有 `verify-*` skill。证据在 `.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/`，说明见该目录的 `README.md`。结果：通过。下面的结果都是代码审查修正之后跑的。

**代码审查之后的修正**（第一版的测试和实跑都通过之后做的审查）：

| 级别 | 问题 | 修正 |
|---|---|---|
| 高 | 迟一点才接住的 rejection（先起 promise、等别的、再 await）也会被当成漏网错误，把好好的子代理判失败 | `unhandledRejection` 等 1 秒，期间 `rejectionHandled` 就撤销；`uncaughtException` 照旧马上算 |
| 高 | 给空闲的可续聊子代理连发两条消息：第二条报「Agent is already processing」，第一版会因此让子代理失败 | inbox 投递一律带 `streamingBehavior` |
| 中 | worker 里已经结算的孙代理的错误被转给宿主，算到 worker 托管的子代理头上 | 本进程归属到谁就交给谁，不再转发 |
| 中 | 子代理的会话先碰到共用的 MCP 管理器时，连接以后的回调一直带着它的身份 | 建连接、开配置监听放进 `outsideChild` |
| 中 | 出错之后仍收消息：在跑的会话里它会排着随会话进驻留池；空闲时还在 preflight 的消息会在结算后跑在驻留的会话上 | 出错后 `deliverToChild` 报 `ACTIVATION_FAILED`；结算前清掉排着的消息并写进诊断；监视等在 preflight 的消息跑起来再中断 |
| 低 | 错误到在 preflight 期间，中断被起跑重置，整轮白跑完 | 起跑后再中断一次（一次性运行、可续聊都是） |
| 低 | 正在关的 worker 报上来的错误可能算到同一个子代理刚恢复的新激活头上；冷恢复时子代理 id 设得晚 | 关闭中的只记日志；id 由 `coldResumeAndDeliver` 直接传进来 |
| 低 | 退回扩展 API 投递结算通知时一律离开身份，一次性子代理被唤起的那一轮没有归属；建会话期间的错误被记成「already settled」 | spawn 时记下调用方的身份再进入；建会话之前就登记处理器 |

- 实跑 `.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/real-run.mjs`：4 项、15 项检查全部通过。日志：`.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/real-run.txt`。
  - 环境：真实 agent-host 加 `custom-muqywnc8/claude-haiku-5-5`，脚本扮演主进程。临时目录里的测试扩展提供两个工具：`leak_probe` 制造漏网 rejection，`late_catch_probe` 迟一点才接住 rejection。
  - **1. 进程内一次性并行 run**：调了 `leak_probe` 的子代理按 error 结束（`uncaught error: LEAK_PROBE A1`），旁边那个照常带回 FINE；agent-host 日志里标着出错子代理的 id。
  - **2. 进程内可续聊**：结算通知 `stopReason: error`，Diagnostic 是 `uncaught error: LEAK_PROBE B2`。
  - **3. worker 后端**：worker 里的错误经 RPC 交给 agent-host，这次 run 按 error 结束。
  - **4. 迟一点才接住的 rejection**：子代理照常完成，只回 SURVIVED，日志里没有这条。同一项在修正前的构建上失败，被判成 `uncaught error: CAUGHT_LATER`。日志：`.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/real-run-case4-before-fix.txt`。
  - 每一项之后 agent-host 都还在，照常答话。
  - haiku 偶尔说测试工具不可用、不去调（诊断行显示工具都在激活清单里）。脚本按工具写到 stderr 的标记判断它有没有跑，没跑的那一次不算，最多试三次。这次第 2 项第一次没调、第二次调了。
- `cd extensions && npx vitest run multi-agent mcp _shared/leak-owner.test.ts prompt-metadata`：699 个通过 / 2 个跳过。日志：`.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/vitest-multi-agent-mcp.txt`。新增的测试：
  - `_shared/leak-owner.test.ts`（8 个）：
    - 身份跟进定时器和 await，里层优先，`outsideChild` 离开；
    - 分派、已结算只上报、处理器出错不外抛、撤销只撤自己；
    - 1 秒内接住的不算；
    - `Teardown` 汇总、`abortQuietly`。
  - `activation.test.ts` 新增 9 个：
    - 在跑时漏网 → 中断、按 error 结算、之后的只上报；
    - 别人唤起的轮次归子代理；
    - 唤起父会话时离开身份；
    - 消息没送到 → 按 error 结算；
    - 结算时 dispose 抛错仍通知、记账；
    - 一个孙代理释放失败不挡别的；
    - 监视出错强制结算；
    - 出错后不收消息、清队列写进诊断；
    - preflight 中的消息等它跑起来再中断。
  - `embedded-runner.run.test.ts` 新增 4 个：
    - 一次运行漏网、旁边那次不受影响；
    - dispose 抛错不换掉结果；
    - 建会话时漏网就不开跑；
    - preflight 期间的错误起跑后再中断。
  - `worker-session.test.ts` 新增 2 个：worker 转来的错误交给它托管的子代理；关闭中的 worker 只记日志。
  - `inbox.test.ts` 改 1 个、新增 1 个：空闲时也带 `followUp`；被拒的 prompt 交给回调、不再算在途。
- `cd extensions && npx vitest run`（全量）：1969 个通过，1 个失败，是已知的 `deleteSemantics`。日志：`.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/vitest-extensions-full.txt`。
- `cd electron-agent && npx vitest run electron/agentProcess`：52 个通过。日志：`.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/vitest-agent-process.txt`。
- `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts`：16/16 通过。日志：`.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/cli-tests.txt`。
- `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit`：154 条，和基线逐条一致。记录：`.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/tsc-compare.txt`。
- agent-host 冒烟 `cd electron-agent && node scripts/agent-host-smoke.mjs --entry out/run-leak/main/agent-host.js`：15 项全部通过。日志：`.agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/agent-host-smoke.txt`。
- 不改界面，没有跑 ui-harness。
