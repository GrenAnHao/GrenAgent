# Agent Note: send_message 可以不唤醒对方（wake: false）

Status: implemented

## Problem

子代理重新设计的决定 7 是「只有一个 `send_message`，带可选 `wake: false`（只投递、不唤醒空闲子代理）」，见 [2026-10-11-subagent-redesign.md](../architecture/2026-10-11-subagent-redesign.md) 第 4 节。四个迁移阶段没有做这一项，当时留作后续项。

做之前，`send_message` 总是唤醒对方：
- 对方在跑：在下一个 step 边界插进去（steer）。
- 对方空闲：开一轮新的。
- 对方已卸载：冷恢复后开一轮。
- 子代理发给父会话：同样会让父会话开一轮。

这带来两个问题：
- **只想告知时也会开轮**：「这个信息你先记着，现在不用处理」这类消息也会让对方开一轮，白花一轮模型调用。
- **父会话为同一个结果跑两轮**：可续聊子代理的结尾提示（`continuableReturnGuidance`）要求它结束前用 `send_message` 把结果发给父会话，这会唤醒父会话一次。紧接着子代理结算，结算通知（里面已经带着它的最后一条消息）又唤醒一次。

## Decision

`send_message` 加可选参数 `wake`，默认 `true`，行为不变。传 `false` 时，对方不会因此开新的一轮。

### 怎么投递

| 对方的状态 | `wake: false` 怎么投递 |
|---|---|
| 会话在内存里（活着的 Activation，或在驻留池里），不论在跑还是空闲 | 持有会话的那一侧调用 `sendCustomMessage(msg, { triggerTurn: false })`，详见下面三条 |
| 已卸载（进程内或 worker 都一样） | 宿主用 `SessionManager.open(path)` 打开它的 JSONL，追加一条自定义消息条目；不加载会话，也不起 worker |
| 子代理 → 父会话 | 经父会话宿主调用 `sendMessage(msg, { triggerTurn: false })`，跑没跑同样由父会话那一侧判断。父会话不在本进程时照旧报 `PARENT_UNAVAILABLE` |

会话在内存里时：
- **空闲**：立即追加，不开轮。
- **正在跑**：SDK 把它排到这一步的工具结果之后（`turn_end`）再追加，下一次模型调用就能看到。如果这一步正好是最后一步，就等它下次开轮再看到。
- **跑没跑由谁判断**：由持有会话的进程当场判断，不会出现「先查 `isStreaming`、再 steer，结果这一轮刚好结束、steer 变成新开一轮」的情况。
- **驻留池里的会话**：还持有自己的 JSONL，只能经它写，不会绕过它去追加文件。收到消息后刷新它在池里的最近使用时间。
- **worker 子代理**：worker 确认写进会话才算投递成功；worker 已经退出时报错，不会谎称已投递。

其他规则：
- **下次被唤醒时**：追加进去的消息就在上下文里。已卸载的子代理冷恢复后，同样从 JSONL 里读到它。
- **消息本体**：自定义消息 `agent-message`，正文是「Agent X sent a message without waking you:」加一个换行，再接原文。details 里记发送方。代码在 `extensions/multi-agent/activation.ts` 的 `agentMessage` / `deliverWithoutWaking`。
- **并发**：不唤醒投递和冷恢复（`coldResumeAndDeliver`）共用每个子代理的 `childLock`，冷恢复进行中时等它装好会话、再经会话写。目标子代理当时还在内存里时，也把它的会话路径带进锁里，这样锁里发现它刚好结算离开了，就按已卸载追加，不会误报不能续聊。
- **子代理交最终结果、但自己还有没结束的活**（自己派的子代理、后台任务）：它这一轮结束后不会马上结算，父会话也就不会被结算通知叫醒。这种情况下 `wake: false` 改成照常唤醒父会话，回执说明原因（`{ woken: true, reason: "sender-has-live-work" }`）。

### 回执、提示词与界面

- **回执**：
  - 已追加：「delivered without waking it; it will see the message the next time it runs」，details 是 `{ woken: false, delivery: "appended" }`。
  - 对方在跑：details 的 `delivery` 是 `"next-step"`。
- **工具说明**：写明 `wake: false` 的行为，并加一条点名工具的 guideline：「Use send_message with wake: false for information the recipient does not need to act on right away」。
- **子代理的结尾提示**：最终结果用 `send_message` 加 `wake: false` 发给父会话。子代理随后就结算，结算通知会唤醒父会话，所以父会话只为这个结果跑一轮。提示里注明：还有子代理或后台任务在跑时，这条照样会唤醒父会话。中途改变父会话下一步的发现，照旧用默认的唤醒。
- **界面**：
  - `agent-message` 显示成一个提示条「来自 X 的消息（未唤醒）」（`AgentMessagePill`），默认收起，展开看正文。父会话和子代理的对话里都会出现。
  - reducer 原来按正文去重通知（同一条消息的 message_start / message_end 各来一次）。对 `agent-message` 改为按原消息的 timestamp 认同一条，同一个发送方连发两条一模一样的消息，两条都显示。

### 顺手修的

- **auto-title**：进程内的子代理跑在 agent-host 里，没有 `PI_IS_SUBAGENT`，auto-title 会给每个子会话白花一次模型调用起标题，子会话卸载后这个后台任务还可能经旧的会话管理器往它的 JSONL 写一条。现在按会话里有没有 `subagent_meta` 跳过。

## Alternatives considered

- **已卸载的子代理收到 `wake: false` 时直接报错**（原提案的建议）。
  - 最强理由：DSH 没有持久收件箱，不唤醒的消息本来就只对「在内存里」的子代理有意义；报错最简单，也不会有人替会话写 JSONL。
  - 没选（用户选的是追加）：宿主本来就会给已卸载的子会话直接追加条目，拆除时的 `writeTornDown` 就是这样写的；这时没有活着的会话，也就没有第二个写者。追加一条不需要加载会话或起 worker，比报错后让模型改用唤醒更省。
- **对方正在跑时，先查 `isStreaming`，在跑就 steer**（第一版的实现）。
  - 最强理由：消息立刻进入当前这一轮，和唤醒投递完全一样。
  - 没选（代码审查发现）：查和投递之间有空档。worker 的状态是宿主缓存的、会滞后；顶层会话的 prompt 前面还要等配置解析。这一轮在空档里结束的话，steer 会变成新开一轮，正好是 `wake: false` 要避免的事。交给持有会话的一侧用 `triggerTurn: false`，跑没跑当场判断：在跑就排到下一步之前，仍然是这一轮里就能看到（用户确认的方向），只是这一步若是最后一步，就等下次再看到。
- **已卸载时冷恢复会话，追加后再放回驻留池。**
  - 最强理由：写入总经过会话自己的 SessionManager。
  - 没选：为一条不开轮的消息加载整个会话（worker 后端还要起一个进程），会占驻留名额。直接追加的结果和这样做一样，因为下次冷恢复会读到同一条。
- **结尾提示不改。**
  - 最强理由：不改模型的使用习惯。
  - 没选（用户选的是改）：父会话会为同一个结果跑两轮。
- **用现有的「已注入上下文」通用折叠条显示。**
  - 最强理由：不动渲染层。
  - 没选（用户选的是专门的提示条）：通用折叠条看不出是谁发的，也看不出没有唤醒对方。

## Consequences

- **收益**：
  - 告知类的消息不再让对方白跑一轮。
  - 父会话为一个子代理的结果只跑一轮。实跑里 haiku 按新的结尾提示用 `wake: false` 交了结果，父会话在 spawn 之后只有两条助手回复：一条是 STARTED，一条是处理结算通知。
  - 已卸载的子代理也能收「不唤醒」的消息，代价只是一次 JSONL 追加。
  - 子会话不再起标题（省一次模型调用）。
- **代价**：
  - 不唤醒的消息要等对方下次开轮才被读到。没人再唤醒它的话，消息就一直躺在 JSONL 里；子代理自己没有「收到了几条未读」的提示。
  - 正在跑的对方如果正好在最后一步，这条要等它下次开轮才看到。
  - 顺序：一条唤醒投递刚发出、还在预检（还没开始跑）时，紧跟着的不唤醒消息会先写进上下文，排在那条唤醒消息前面。两条在同一轮里都能看到。
  - 宿主直接追加 JSONL 的前提是这时没有别的写者：
    - worker 子代理结算后进程就退出，宿主之后才会走到这条路径；
    - 冷恢复和追加之间靠 `childLock` 串行；
    - auto-title 已经不再写子会话。
- **已知限制，不是这次引入的**：
  - worker 里的子代理发不了 `send_message` 给父会话：它的 Activation 和父会话宿主都在 agent-host 进程里，worker 里查不到，报 `PARENT_UNAVAILABLE`。所以新结尾提示里的最终发送在 worker 子代理上会失败，结果仍经结算通知里的最后一条消息送到。
  - 冷恢复的子代理没有结算通知的退路（`deliverFallback`）。父会话没有登记宿主时（例如 CLI），这种子代理的结算通知会丢。
- **范围外**：界面给子代理发消息（`subagentService`，人类投递）不受影响，仍然唤醒。

## 验证

仓库里没有 `verify-*` skill。证据在 `.agents/evidence/2026-10-12-send-message-without-waking/`，说明见该目录的 `README.md`。结果：通过。

- 实跑 `.agents/evidence/2026-10-12-send-message-without-waking/real-run.mjs`（真实 agent-host 加 `custom-muqywnc8/claude-haiku-5-5`，代码审查后的修正重新构建后复跑）：20 项全部通过。日志：`.agents/evidence/2026-10-12-send-message-without-waking/real-run.txt`。
  - **驻留池里的子代理**：`wake: false`「记住暗号 BANANA」。
    - 回执是 `{ woken: false, delivery: "appended" }`，20 秒内没有新的结算通知，JSONL 多了一条 `agent-message`，没有新的助手回复。
    - 默认唤醒问暗号，结算通知带回 BANANA。
  - **重启 agent-host 后（子代理已卸载）**：`wake: false`「暗号改成 CHERRY」。
    - 诊断采样里 `active=0`、`resident=0`，说明没有加载会话。同样没有被唤醒，JSONL 多一条。
    - 唤醒后带回 CHERRY。
  - **worker 后端**：子代理结算、worker 退出后，`wake: false`「暗号是 DATE」没有起 worker 进程，JSONL 多一条；唤醒后冷恢复回 worker，带回 DATE。
  - **子代理交最终结果**（只记录，不判定）：父会话收到 1 条 `agent-message`，spawn 之后父会话只有 2 条助手回复（STARTED 和处理结算通知）。
  - 「子代理还有活时改成唤醒」没有实跑：临时 HOME 里 bash 起不来（没有沙箱 helper），造不出在跑的后台任务。这条由单元测试覆盖。
- `cd electron-agent && npm run ui:check -- agent-message`：14 项全部通过。日志：`.agents/evidence/2026-10-12-send-message-without-waking/ui-check-agent-message.txt`，截图在同目录的 `shots/`。
  - 覆盖：标题写出发送方、不是「已注入上下文」、默认收起、展开看到 markdown 正文、再点收起、普通注入通知不受影响、实时推来的一条（走 reducer 的 message_start / message_end）只显示一次、同样正文再发一次也显示、浅色主题。
  - `--changed --dry-run` 显示 `ChatMessageItems` 的改动波及 `chat-follow`、`panel-resize`、`subagent-conversation`、`subagent-history`。没有跑：它们不渲染 `agent-message`，新增的只是一个分支；reducer 对其他通知的去重不变。
- `cd extensions && npx vitest run multi-agent auto-title prompt-metadata`：490 个通过 / 2 个跳过。日志：`.agents/evidence/2026-10-12-send-message-without-waking/vitest-multi-agent.txt`。
  - `activation.test.ts` 新增 8 个：
    - 在跑时交给 SDK 排到下一步、不 prompt；
    - 空闲 Activation 追加不开轮；
    - 驻留的追加后仍在池里；
    - 驻留会话没有消息通道时拒绝、不绕过它写文件；
    - 已卸载的只追加 JSONL、不加载会话；
    - 不能续聊的报 `NOT_RESUMABLE`；
    - 冷恢复进行中时等它装好会话再经会话写；
    - 「还有没结束的活」的判断。
  - `adjacent-tools.test.ts` 新增 5 个，并按新的结尾提示改了锁定原文的那个用例。
  - `auto-title` 新增「进程内子代理也跳过」。
- `cd extensions && npx vitest run`（全量）：1921 个通过，1 个失败，是已知的 `deleteSemantics`。日志：`.agents/evidence/2026-10-12-send-message-without-waking/vitest-extensions-full.txt`。
- `cd electron-agent && npx vitest run src/features/chat src/stores`：1149 个通过（含新增的 `AgentMessagePill.test.tsx` 和 reducer 的连发用例）。日志：`.agents/evidence/2026-10-12-send-message-without-waking/vitest-renderer.txt`。
- `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts`：16/16 通过。日志：`.agents/evidence/2026-10-12-send-message-without-waking/cli-tests.txt`。
- `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit`：154 条，和之前逐条一致。记录：`.agents/evidence/2026-10-12-send-message-without-waking/tsc-compare.txt`。
- agent-host 冒烟（入口用 `out/send-quiet`）：15 项全部通过。日志：`.agents/evidence/2026-10-12-send-message-without-waking/agent-host-smoke.txt`。
- 代码审查（只读的子代理审查）没有发现死锁，找出 1 个 HIGH、3 个 MEDIUM、4 个 LOW，上面的数字都是改正后的：
  - 改了：
    - HIGH：子代理还有活时，`wake: false` 交结果会让父会话一直睡着。
    - 先查再 steer 的空档。
    - 目标刚好离开内存时误报不能续聊。
    - 投递不等结果、worker 丢消息不报错。
    - auto-title 写子会话。
    - 驻留会话没有消息通道时绕过它写文件。
    - reducer 吞掉正文相同的连发消息。
  - 没改，记进「代价」：唤醒消息还在预检时的顺序问题。
