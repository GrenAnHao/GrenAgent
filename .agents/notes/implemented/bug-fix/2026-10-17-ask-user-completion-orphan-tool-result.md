# Agent Note: 提问卡补写把会话写死

Status: implemented

## Problem

一个真实会话（`--E--linghoumiaohui-kefu-extract--/2026-10-16T13-01-17-244Z_01a144cd-….jsonl`）从某一刻起每次发送都 400，换模型、换供应商都一样：

- Anthropic：`messages.20.content.5: unexpected tool_use_id found in tool_result blocks … Each tool_result block must have a corresponding tool_use block in the previous message`
- OpenAI 兼容端：`[code=upstream_error] Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`

时间线（会话文件里的条目）：

1. `12:18:50` assistant `c864388a` 带一个未作答的 `ask_user` 工具调用落盘，`stopReason: "aborted"`——提问卡还开着时用户中断了回合。
2. `12:19:39` 用户点了卡片上的取消，走 `agent_complete_ask_user` → `completeAskUser`（`electron-agent/electron/agent/completeAskUser.ts`）。会话已经 idle，于是它往历史里补写了一条 `ask_user` 的 `toolResult` 并 `agent.continue()`。
3. `12:19:41` 第一次 400，之后每一次请求都 400。

根因在跨层契约：pi-ai 的 `transform-messages.js` 在发请求前**整条丢掉** `stopReason` 为 `error` / `aborted` 的 assistant 消息（理由是中断回合可能只有半截内容，重放会触发 API 报错），工具调用跟着消失；而我们在它后面补的 `toolResult` 还在，于是成了孤儿 `tool_result`。这条孤儿留在上下文里，会话从此再也发不出去——不是某次请求失败，是永久写死。

## Decision

- `completeAskUser` **must** 先用 `findAskUserCallOwner` 找到这次 `toolCallId` 所属的 assistant 消息。该消息 `stopReason` 为 `aborted` / `error`（下称「已死回合」）时 **never** 再补写 `toolResult`。
- 已死回合下用户作答：走 `session.prompt()`（pi 自己的用户输入通道，会落盘、发事件、起回合），文本前缀「（上一轮已中断，这是我在那张提问卡上的选择）」。模型看不到卡片原文——它已被 pi-ai 丢掉——但看得到用户选了什么，界面上也立刻出现这条用户消息。
- 已死回合下用户取消：不写历史、不发请求，返回 `ok`，只收卡片。
- `findPendingAskUser`（`electron-agent/src/features/chat/pendingAskUser.ts`）收窄为「只有最后一个 assistant 回合能留下待答卡」：从尾往前扫，`toolResult` 记作已答，遇到的第一条 assistant 决定结果，先遇到 user 消息判无，其余角色跳过。没有这条规则，转达答案后那张卡会在下次载入时复活，用户对着已答过的卡再答一遍。
- 活着的回合（`isStreaming`，卡片经 `ctx.ui.input` 阻塞等待）不受影响，仍走 `handle.ui.respond`；回合健在时的补写路径也与改动前完全一致。

### 已经写坏的那个会话

手工把 assistant `c864388a` 的 `stopReason` 从 `aborted` 改回 `toolUse`、删掉 `errorMessage`（thinking、正文、工具调用、工具结果都完整，这样改是如实的），原文件备份为同目录 `*.jsonl.bak-orphan-toolresult`。修完全盘 831 个会话文件重扫，孤儿 `tool_result` 为 0。**这是一次性手工修复，不是代码路径**：SessionManager 是 append-only，程序里绕过它改文件，内存里那份不会跟着变，pi 某些路径还会把内存条目整体写回、把修复覆盖掉。

## Alternatives considered

- **改 pi-ai：丢弃已死 assistant 时连带丢掉它的 `toolResult`。** 最彻底——上游那条规则本身缺了一半，丢调用不丢结果产出的消息序列必然非法，任何写回工具结果的宿主都会踩。但要 patch `node_modules`（仓库没有 pnpm patch 基建），每次升级 pi-ai 都要重打，而我们自己有不制造孤儿的办法。等上游修或引入 patch 基建时再提。
- **把已死 assistant 的 `stopReason` 改回 `toolUse`，让这一对正常重放。** 手工救会话用的就是这招；作为代码路径不成立，理由见上。
- **补写 `toolResult` 后再 `appendContextEdit(entryId, null)` 把它排除出上下文。** 用的是 pi 自己的机制，但被排除的条目不进 `buildSessionContext`，下次载入 `findPendingAskUser` 又看不见它，卡片照样复活；要让两边一致得再改一遍恢复逻辑，比不写更绕。
- **已死回合里补一条合成 assistant 消息重发同一个工具调用，再接 `toolResult`。** 模型能同时看到问题和答案（问题就在调用参数里），但同一个 `toolCallId` 在历史里出现两次，工具卡渲染要连带改、还要加 ui-harness 场景，代价超出这次修复。
- **让中断回合的提问卡根本不复活（直接显示成已中断）。** 用户选了最小修复，这条留作后续：要动 `interruptPendingToolCards` 对 ask_user 的豁免和对应的 ui-harness 场景。

## Consequences

- **收益**：提问卡补写不再能把会话写死。中断回合里的答案仍然送得到模型，而且以用户消息的形态立刻出现在界面上。
- **代价**：已死回合的答案进上下文时没有问题原文，模型可能要用户补一句上下文；已死回合取消后不写任何东西，若用户什么都不发就重载会话，那张卡会再出现一次（发任何新消息后不再出现）。
- **代价**：`findPendingAskUser` 收窄后，ask_user 调用后面意外多出一条 assistant 消息的边角场景不再出卡。判无只是卡片不显示、调用显示成已中断，不会写坏会话。
- **重访信号**：又出现「某个会话每次发送都 400、换模型没用」，或者提问卡答过之后还反复出现。
- 扫描依据：本机 831 个会话文件里当前**没有**任何未作答的 ask_user 调用，说明恢复卡片这条路走得很少，收窄的实际影响面小。

## Verification

- `cd electron-agent && npx vitest run electron/agent/completeAskUser.test.ts src/features/chat/pendingAskUser.test.ts src/stores/pendingAskUserLoad.test.ts src/stores/agentReducer.test.ts src/stores/agent.test.ts src/features/chat/InlineQuestionCard.test.tsx src/features/chat/input/overlayPrompt.test.ts` → 7 文件 / 181 用例全绿（含新增：已死回合作答走 `prompt`、已死回合取消不写不发、老回合仍补 `toolResult`；`findPendingAskUser` 的「后面有用户消息 / 新 assistant 判无」「同回合其他工具已答仍判有」）。
- `cd electron-agent && npx vitest run`（全量）：失败项与本改动无关（`electron/app/taskViewService.test.ts` 等，工作区里本来就有其他在改的功能）。
- 会话文件扫描脚本（临时）：修复前 831 个会话命中 1 个孤儿 `tool_result`，修复后为 0。
- 没有真机跑一遍「中断回合→答卡→模型继续」：`verify: n/a` 需要人工在界面上中断一个真实回合，本次以单测 + 会话扫描为证据。
