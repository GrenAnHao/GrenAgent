# Agent Note: 等待中的引导可以取消，也可以撤回输入框重新编辑

Status: implemented

## Problem

回合执行中发出的引导（steer）在注入当前回合之前停在「正在引导…」，用户发错了或想改措辞时没有任何办法：气泡上的操作栏只有回退 / 编辑 / 复制，而且回退、编辑都依赖 entryId，引导还没落盘，全是禁用的。Pi 的 `AgentSession` 只有整体 `clearQueue()`，没有撤单条的公开接口。

## Decision

- 气泡：`steering && steerState === 'written'` 的用户消息，焦点操作栏（悬停 / 聚焦才浮现的那一排）换成 `取消引导`（X）/ `编辑` / `复制`，没有「更多」菜单。ctx 不带 timestamp / entryId，走 `MessageActionBar` 的基础栏，回合在跑也不会被「忙碌时隐藏」滤掉。已注入（consumed）和改成独立运行（requeued）的引导照旧，没有取消。
- 取消：`store.cancelSteer(messageId)` → `pi.cancelSteer` → IPC `agent_cancel_steer { message, allowSole, targetSessionPath }`。Pi 撤下了才把气泡去掉（返回 `'cancelled'`）；撤不下（已经在注入）返回 `'missed'`，气泡不动，界面提示「这条引导已经在注入当前回合，撤不回来了」。等回执期间切走了会话，就改那份会话的 shadow。
- 编辑：先走取消，撤下成功后经 `composerBridge.loadIntoComposer(text, images)` 把原文和图片放回底部输入框，由人工再发。输入框里已经有草稿时接在后面（空一行），不覆盖；图片进当前草稿的待发附件。撤不下时不回填。
- 主进程 `electron/app/cancelQueuedSteer.ts`：
  - 优先直接改 pi 的两份内部队列：`agent.steeringQueue.messages`（真正会注入的消息，带图片）和 `_steeringMessages`（queue_update 的正文），再调 `_emitQueueUpdate()`。只撤那一条，其余引导的顺序、图片、时间戳都不动，也不会再跑一遍输入处理。
  - 以 agent 队列为准判断能不能撤：agent 循环已经取走、`message_start` 还没发时，`_steeringMessages` 里还有，但 agent 队列里没了，返回 `cancelled: false`。
  - 正文匹配：先全等，再按 trim 比；都对不上时，只有渲染层说「界面只剩这一条未注入的引导」（`allowSole`）且队列也只剩一条才撤它（模板 / 技能展开后正文和气泡对不上的情况，同 `consumeSteer` 的兜底）。
  - 拿不到这两份内部队列（pi 换了实现）时退回公开接口：`clearQueue()` 后把其余引导按正文 `steer` 回去、跟进 `followUp` 回去。这条路会丢掉其余引导的图片，和 `agent_take_steering` 放回跟进的做法一致。
- `agent_cancel_steer` 在 `ROUTED_COMMANDS` 里，带 `targetSessionPath` 时打到停在后台的那份会话；会话已经不在任何 handle 上时返回 `{ cancelled: false }`。

## Alternatives considered

- **只用公开接口：`clearQueue()` 再把其余引导 `steer` 回去**。最强理由：不碰 pi 私有字段，升级不怕改名。不作为主路径：其余引导的图片会丢（`clearQueue` 只返回正文），重新 `steer` 还会再跑一遍扩展的输入处理、换掉时间戳；而且公开接口分不出「已经被 agent 取走、正在注入」，会把在路上的引导当成撤成功。保留为内部队列拿不到时的退路。
- **只在渲染层把气泡去掉，不动 Pi 队列**。最强理由：零后端改动。不用：Pi 仍会把它注入当前回合，界面和模型看到的对不上，比不做还糟。
- **编辑直接打开就地编辑框（像已回复的消息那样）再发**。不用：用户要求「先取消、内容回到输入框、人工发送」；就地编辑框发出去是普通发送，和引导 / 跟进的路由规则（`composerSendBehavior`）不一致，回到输入框由用户决定是引导还是跟进更清楚。
- **回填时覆盖输入框**（和「回退到此」一样用 `setComposerValue`）。不用：引导是在回合进行中发的，用户这时很可能正在输入框里写下一条，覆盖会静默丢字。

## Consequences

- 代价：主路径依赖 pi 1.3.0 的私有字段 `_steeringMessages` / `_emitQueueUpdate` / `agent.steeringQueue.messages`。`cancelQueuedSteer.test.ts` 用真实的 `AgentSession.prototype._queueSteer` 和真实 `Agent` 造队列，pi 升级改了这些名字或形状，这组测试先红；运行时则自动退回公开接口，功能还在、其余引导的图片会丢。
- 代价：退回路径下重新 `steer` 的引导会再跑一遍扩展输入处理。
- 收益：等待中的引导可以撤，撤下前后其余引导完全不受影响；撤不回来时如实告诉用户，不会出现「界面说撤了、模型却收到了」。
- 回填只带正文和图片；正文里的附件块（`<pi:attachment>`）和「回退到此」一样不回填。

## Verification

- `cd electron-agent && npx vitest run electron/app/cancelQueuedSteer.test.ts electron/app/piRuntimeService.test.ts` 通过（73 条）：真实 pi 队列里只撤那一条、其余连同图片留着、发 queue_update；同正文两条只撤一条；已被 agent 取走的撤不回来；`allowSole` 兜底；退回路径按序重排引导和跟进；服务层 `agent_cancel_steer` 走通。
- `npx vitest run src/stores/agent.test.ts` 通过（50 条）：撤下后去掉气泡、`allowSole` 只在唯一一条未注入引导时为 true、Pi 回 false 时气泡不动、普通消息不发撤回。
- `npx vitest run src/features/chat/UserMessage.test.tsx src/features/chat/ChatInput.test.tsx src/features/chat/messageActions src/features/chat/ChatView.test.tsx` 通过：操作栏是取消 / 编辑 / 复制且无「更多」、X 不回填、编辑撤下后回填原文和图片、撤不回来不回填、已引导没有取消；输入框为空时写入、已有草稿时接在后面、图片进待发附件。
- `npm run ui:check -- steer-cancel` 通过（22 条断言，新场景）：真实 `createAgentStore` + `renderMessageBody`，`agent_cancel_steer` 用桩；静止时操作栏透明、悬停浮现，按钮顺序、点 X 只撤这一条且不碰输入框、撤不回来时提示并保留气泡、编辑后原文和 1 张图片回到输入框、已引导没有取消、浅色主题下 X 可见。截图与日志见 `.agents/evidence/2026-10-18-cancel-pending-steer/`。
- 没有在真实 Electron + 真实模型的会话里端到端点过（需要一个正在跑、且引导还没被注入的回合，时机不好人为卡住）；主进程对真实 pi 队列的操作由上面的单测覆盖。
