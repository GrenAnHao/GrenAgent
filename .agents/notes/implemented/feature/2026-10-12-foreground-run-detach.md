# Agent Note: 前台 run 等待时来了引导消息，还没完成的子代理转到后台

Status: implemented

## Problem

子代理重新设计的决定 8 是「过渡期保留单任务前台阻塞；最终全部非阻塞 + settlement 通知 + `wait_agent`」，见 [2026-10-11-subagent-redesign.md](../architecture/2026-10-11-subagent-redesign.md) 第 8 节。第 2 阶段按用户确认保留了前台阻塞，「最终全部非阻塞」当时留作后续项。

动手前看了两样东西：
- **本机最近 45 天的会话**（只统计调用次数，不看内容）：
  - 模型直接调 `spawn_agent` 340 次：

    | 用法 | 次数 |
    |---|---|
    | 前台单任务 | 186 |
    | 前台并行（中位 2 个，最多 10 个） | 27 |
    | 链式 | 1 |
    | 后台 spawn | 68 |
    | list / status / cancel | 58 |
  - 另有 250 次是在 codemode 脚本里调 `spawn_agent`。
- **离不开阻塞 `run` 的用法**：
  - codemode 脚本写 `await spawn_agent(...)`，要的就是调完拿到结果。
  - `/implement` 等工作流用 `chain` 串步骤，同样要等结果。
  - DSH 去掉前台的同时，也保留了程序调用方 await 结果（`delivery: 'caller'`）。

照原决定把 `run` 去掉，会打断 codemode 编排这一大块用法。阻塞真正的坏处在另一处：父会话卡在 `run` 里时，用户发的消息（steer）要等所有子代理跑完才会被处理，可能要等好几分钟。

## Decision

前台 `run` 照旧阻塞，返回值不变。等待期间来了一条引导消息（steer）时，还没完成的子代理转到后台继续跑，父会话立刻去处理这条消息。用户确认了这个方向，取代决定 8 里「最终全部非阻塞」那一半。

- **触发**：
  - 只认这一轮来的 steer。
    - multi-agent 在 pi 的 `input` 事件里数 `streamingBehavior: "steer"` 的输入。
    - 每轮开始（`turn_start`）和 `agent_end` 时清零：排在这一轮开始之前的 steer，已经在这一轮开头交给模型了。
  - 等待时每 200 ms 看一次：这一轮来过 steer，并且 `ctx.hasPendingMessages()` 为真。被别的扩展的 `input` 钩子拦下的 steer 不进队列，所以不算。
  - 跟进（followUp）不触发，它的意思是「做完再说」。
  - 别的后台子代理的结算通知走 agent 自己的队列（`sendCustomMessage`），不进这两项判断。
  - 这一轮里、`run` 开始之前就来了的 steer，一开始就转后台。
- **谁会发 steer**：
  - 桌面端：对话进行中发送，先落成输入框上的跟进条，在渲染层排队，不进会话。点跟进条的「引导」才发 steer。所以桌面端点了「引导」才转后台，直接回车不会。
  - pi 自己的 TUI、RPC 的 steer。
  - 子代理里：父代理经 `send_message` 发给忙着的子代理的消息走 steer（inbox），同样会让子代理的前台 `run` 转后台。
- **转后台时的返回**：
  - 正文不说是谁发的（「A new message arrived while this run was waiting」），因为子代理里触发它的是父代理。
  - **单任务**：回执形状照后台 spawn，即 `agentId`、`sessionPath`、`status: "running"`、`detached: true`，正文提示模型先处理那条消息。
  - **并行**：已经结束的照常给结果；还在跑（或因并发上限还没轮到）的那几项写 `status: "running"`、`detached: true`，正文写明转到后台。
- **转后台之后**：
  - 还在跑的子代理登记到 `child-runs`，`wait_agent` 等得到；每个结束时各发一条 `subagent-settled` 通知（`continuable: false`，和后台 spawn 一样）。
  - 父会话这一轮被打断（Esc）不再连带取消它们。转后台之前打断，照旧全部取消。
  - 单会话名额占到各自结束为止；注册表、父会话目录照前台的规矩在结束时记账。
  - 记账出错（例如注册表写不进去）不挡结算通知。
  - 流式阶段就开工的并行项也登记进 `inflight`，界面上的取消和卡死回收都够得到它们。原来只有执行阶段起的项登记，转后台以后早开工的那几个谁也停不了。
  - 它们仍是一次性子代理，不能用 `send_message` 追问（用户确认的 3a）。
- **不转后台的情况**：
  - codemode 脚本里的调用：嵌套调用的 `tool_call` 事件带 `parentToolCallId`，multi-agent 在同一个 `tool_call` 钩子里记下这些调用 id。被拦下、没走到 execute 的 id 在 `agent_end` 清掉。
  - `chain`。
  - 并行 run 判定转后台的那一刻其实都已经结束、只差收尾：照常等完，返回完整结果。
- **代码**：
  - `extensions/multi-agent/detach.ts`：`SteerWatch`、`waitOrDetach`、`ForegroundRun`、`detachableSignal`。
  - `manager.ts`：抽出 `settleOneShot` / `settleInBackground`，后台 spawn 和转后台共用。
  - 流式阶段就开工的并行项（`parallel-early.ts`）经 `EarlyBatch.onSettled` 接上同一套。
- **界面**：
  - 单任务回执本来就会被识别成后台子代理，卡片跟着注册表走，不用改。
  - 并行组卡片：
    - 转后台的那项画成运行中（原来工具结束后没有 `ok` 的项一律画成出错），右坞详情按后台子代理跟注册表。
    - 组头写「N 个在后台运行」，有这种项时继续轮询注册表，结束后按注册表画终态。
    - 转后台时还没轮到、没有 agentId 的项，按任务文字跟注册表里最新的那一行。
    - 转后台的项在注册表里找不到（被删，或被同一会话更新的 50 行挤出列表），画「已中断」，不算失败、不算在后台，和单任务后台卡片一致。
    - 「找不到」要等工具返回之后再读一次注册表确认。store 里那份可能是这些行建出来之前读的：`run` 一开始就转后台时，下一次轮询还没到。不确认的话，这一项是最后一个在跑的行时，轮询会停掉，它就一直画成已中断。
- **提示词**：`spawn_agent` 的说明加了一句：`run` 等待时来了引导消息，还没完成的会转到后台、各自用通知交回；codemode 脚本里的调用和 `chain` 始终等结果。Fable 的 delegation 不改。

## Alternatives considered

- **照原决定：模型直接调用时默认改成后台 spawn，`run` 只留给 codemode 和 chain。**
  - 最强理由：交付方式只剩一种，和 DSH 一致，父会话从来不会卡住。
  - 没选（用户选的是现在这个方向）：模型要学会用 `wait_agent`，一个子任务至少多两次往返（spawn、等结果）；前台单任务一直是最常见的用法（45 天 186 次）。
- **不做，把「最终全部非阻塞」改记为「不做」。**
  - 最强理由：零改动。
  - 没选：用户长时间等不到父会话回应的问题仍在。
- **卡片上另加「转到后台」按钮。**
  - 最强理由：用户不发话也能让父会话继续。
  - 没选（用户选的是只在发话时）：要改渲染层和主进程命令；用户想让父会话做别的事时，本来就会发话。
- **转后台的子代理变成可续聊。**
  - 最强理由：转后台之后也能追问。
  - 没选（用户选的是一次性）：要把前台路径整个换成 Activation（续聊、驻留、名额都跟着变），动静大；需要续聊的场合模型本来就会用后台 spawn。
- **触发只看 `ctx.hasPendingMessages()`（第一版的做法）。**
  - 最强理由：和 `wait_agent` 同一个判断，不用另记状态。
  - 没选（代码审查指出）：
    - 它把跟进也算在内。一条早就排着的跟进（TUI 的跟进、IM 网关发来的跟进、恢复会话时补回去的跟进）会让之后每次 `run` 一开始就转后台。
    - 跟进本来就是「做完再说」，不该打断 `run`。

## Consequences

- **收益**：
  - 用户在前台子代理跑着时引导，父会话马上能回应。实跑里从发话到 `spawn_agent` 返回 37～95 ms，然后父会话先回复用户，慢的子代理结束时再发通知。
  - codemode 编排和工作流照旧拿到完整结果。
- **代价**：
  - 转后台的子代理不能追问。
  - 模型看到的结果分两次到：先是部分结果，后是通知。
  - 转后台之前就已经结束的项随回执返回，之后结束的各发一条通知，所以一次并行 run 可能带来多条通知。
  - 桌面端直接回车只会排成跟进条，不转后台；要点跟进条的「引导」。
  - 这一轮开始前的那一刻才到的 steer（上一轮刚取完队列、这一轮的 `turn_start` 还没发）会被清零，那条 steer 要等这一轮结束才处理。窗口很小，没有专门处理。
- **界面的边界情况**：
  - 没有 agentId 的项按任务文字匹配。同一会话之前跑过同样文字的任务、而这一项还没在后台起来时，会先画成那一行的状态。
  - 注册表列表只给同一会话最新的 50 行。很久以前转后台的项，打开历史时会画「已中断」，和单任务后台卡片一样。
- **子代理里的 run**：子代理自己卡在前台 `run` 里时，父会话用 `send_message` 发来的消息，同样会让它的孙代理转后台。孙代理的通知发给子代理。
- **codemode 的真实路径没有实跑**：这次实跑环境的会话里没有 codemode 工具，模型直接调了 `spawn_agent`。嵌套调用不转后台由单元测试覆盖。

## 验证

仓库里没有 `verify-*` skill。证据在 `.agents/evidence/2026-10-12-foreground-run-detach/`，说明见该目录的 `README.md`。结果：通过。下面的结果都是代码审查修正之后重跑的。

**代码审查之后的修正**（第一版实跑、场景都通过之后做的审查）：

| 级别 | 问题 | 修正 |
|---|---|---|
| 高 | 流式阶段就开工的并行项没登记进 `inflight`，转后台以后界面取消、卡死回收都停不了它 | `launchEarly` 登记，结束时删 |
| 高 | 组卡片里转后台的项在注册表里找不到（被删、被挤出 50 行、没有 agentId）时一直转圈、一直轮询 | 有 agentId 的确认找不到后画「已中断」；没有 agentId 的按任务文字跟最新一行 |
| 中 | 触发条件把跟进、更早排着的消息也算进去；回执写「The user sent」，子代理里其实是父代理 | 只认这一轮的 steer（`SteerWatch`）；回执措辞改成中性 |
| 低 | 注册表写失败会让 `runOne` / `launchEarly` 的 Promise 失败，转后台的项发不出通知，`all.finally` 还会留下未处理的 rejection | 写注册表包一层，通知放进 finally；转后台路径用 `all.then(release, release)` |
| 低 | 判定转后台那一刻其实都已经结束，仍返回「转到后台」 | 照常等完返回完整结果 |
| 低 | 被拦下、没走到 execute 的嵌套调用 id 一直留在集合里 | 改成每个会话一份，`agent_end` 时清空 |

组卡片的「找不到」第一版直接按 store 里那份判断。写场景时发现这份可能早于行的创建，于是改成工具返回之后再读一次确认，见 Decision 的「界面」。

- 实跑 `.agents/evidence/2026-10-12-foreground-run-detach/real-run.mjs`：12 项全部通过。日志：`.agents/evidence/2026-10-12-foreground-run-detach/real-run.txt`。
  - 环境：真实 agent-host 加 `custom-muqywnc8/claude-haiku-5-5`，脚本扮演主进程，用户发话 = 父会话在跑时发一条 steer。
  - **并行**：一个快、一个慢（写 1～1000），等快的结束、慢的还在跑时发话。
    - `spawn_agent` 95 ms 后返回：快的带回 FAST，慢的写明转后台并带 agentId。
    - 父会话先回复了用户（HERE）。慢的结束时，父会话收到它的结算通知（带回 SLOW_DONE）。
  - **单任务**：子代理起来后发话，回执是 `status: running` / `detached`。随后打断父会话这一轮（`agent_abort`），子代理没有被取消，照样跑完并发来 completed 的通知。
  - **跟进不转后台**（审查修正后新增）：
    - 子代理起来后用 `agent_follow_up` 发一条跟进，它直接进会话的 followUp 队列。
    - 发出后 `run` 又等了 10478 ms，返回完整结果（MEDIUM_DONE），没有结算通知。
    - 跟进在工具结果之后才处理。
  - **codemode 对照**：没有判定，只记录。会话里没有 codemode 工具，模型直接调了 `spawn_agent`。
  - 第一版第一次完整跑时，慢任务只写到 300，在发话之前就结束了，所以没有转后台（脚本时序问题）。改成写到 1000、并且等到「快的结束、慢的还在跑」那一刻再发话。
- `cd electron-agent && npm run ui:check -- subagent-detached`：23 项全部通过。日志：`.agents/evidence/2026-10-12-foreground-run-detach/ui-check-detached.txt`，截图在同目录的 `shots/`。
  - 第一版第一次跑时发现：转后台的那项都结束后，组卡片停掉轮询，store 清空，行退回「运行中」，又把轮询拉起来，来回抖到页面卡死。改成卡片记住注册表的最后一份之后通过。
  - 审查修正后加了三行：
    - 晚到的（卡片第一次读注册表时还没建出来）；
    - 丢失的（注册表里一直没有）；
    - 排队的（没有 agentId）。
  - 反向验证：临时把卡片改回「store 里找不到就算已中断」，「晚到的任务从挂载起一次也没画成已中断」这一条 FAIL。日志：`.agents/evidence/2026-10-12-foreground-run-detach/ui-check-detached-red.txt`。
    - 只看最终状态抓不到它：别的行还在轮询，下一次读到就改回运行中。所以场景从挂载起盯着这一行。
  - 组卡片也被 `subagent-history`、`subagent-conversation` 用到：
    - `subagent-history`：10 项通过。日志：`.agents/evidence/2026-10-12-foreground-run-detach/ui-check-group.txt`。
    - `subagent-conversation`：33 项通过。日志：`.agents/evidence/2026-10-12-foreground-run-detach/ui-check-conv.txt`。
- `cd extensions && npx vitest run multi-agent prompt-metadata`：495 个通过 / 2 个跳过。日志：`.agents/evidence/2026-10-12-foreground-run-detach/vitest-multi-agent.txt`。
  - `detach.test.ts` 12 个，含 `SteerWatch` 的 2 个。
  - `index.test.ts` 新增 12 个：
    - 单任务转后台后的通知、注册表和 `wait_agent` 登记；
    - Esc 在转后台前后的区别；
    - codemode 嵌套调用不转；
    - chain 不转；
    - 并行时部分完成、部分转后台；
    - 名额占到结束；
    - 排着的跟进不转；
    - 这一轮之前的 steer 不算；
    - 没进队列的 steer 不算；
    - `agent_end` 清掉没走到 execute 的嵌套调用；
    - 注册表写失败时转后台的项仍发通知；
    - 早开工的项登记进 `inflight`、结束时删掉。
- `cd electron-agent && npx vitest run src/features/chat src/features/panels src/features/dock src/stores`：1362 个通过（含 `subagentUtils.test.ts` 新增的 3 个）。日志：`.agents/evidence/2026-10-12-foreground-run-detach/vitest-renderer.txt`。
- `cd extensions && npx vitest run`（全量）：1945 个通过，1 个失败，是已知的 `deleteSemantics`。日志：`.agents/evidence/2026-10-12-foreground-run-detach/vitest-extensions-full.txt`。
- `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts`：16/16 通过。日志：`.agents/evidence/2026-10-12-foreground-run-detach/cli-tests.txt`。
- `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit`：154 条，和之前逐条一致。记录：`.agents/evidence/2026-10-12-foreground-run-detach/tsc-compare.txt`。
- agent-host 冒烟 `cd electron-agent && node scripts/agent-host-smoke.mjs --entry out/run-detach/main/agent-host.js`：15 项全部通过。日志：`.agents/evidence/2026-10-12-foreground-run-detach/agent-host-smoke.txt`。
