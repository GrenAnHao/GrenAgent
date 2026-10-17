# Agent Note: Goal 每一轮续跑在对话里有卡片，设目标不在对话里留命令行

Status: implemented

## Problem

- Goal 每一轮续跑发给模型的正文是 `customType: "goal-round"`、`display: false` 的自定义消息。渲染层只把 `display: true` 的自定义消息画成通知，实时（`applyCustomMessage`）和历史（`messagesFromAgent`）都把它丢掉，对话里看不出「第 N 轮开始了」，只能去 Goal 详情抽屉的操作记录里翻。
- 输入栏发 `/goal <条件>` 后，对话里会插一行本地的 `/goal` 命令胶囊（`commandInputStore`），Goal 条本身已经是回执，这一行是重复的，用户要求去掉。

## Decision

- 渲染层对 `goal-round` 例外：虽然是 `display: false`，实时和历史都还原成 `notice`（`agentReducer.ts` 的 `SHOWN_HIDDEN_CUSTOM_TYPES`）。其他 `display: false` 消息照旧不显示。
- 卡片是 `GoalRoundPill`（复用 `NoticeSplitPill`）：标题把首行 `Goal Round 4/256。` 换成「目标续跑 · 第 4 轮」，不写轮次预算（与 Goal 条一致），默认收起，展开看这一轮模型收到的完整条件与要求。
- 扩展仍按 `display: false` 发（TUI 不刷屏）、正文格式不变；卡片按 `extensions/goal/prompt.ts` 的首行格式取轮次，测试直接用 `buildGoalRoundPrompt` 造正文，格式一改测试就红。
- 输入栏 `/goal …` 走执行性命令分支时不再写 `commandInputStore`、不弹「已执行 /goal」，只补拉一次 Goal（见 `2026-10-18-goal-bar-pull-hydration.md`）。其他执行性命令（`/compact` 等）的命令行照旧。失败仍由扩展 `notify` 报错。

## Alternatives considered

- **扩展改成 `display: true` 发续跑消息**：渲染层不用加例外，通用 `NoticePill` 直接显示。不用：已有会话里的历史轮次都是 `display: false`，渲染层无论如何要认它；而且通用提示条写的是「已注入上下文」，看不出是第几轮。
- **照 DSH 把续跑当成 `user` 消息（`source.kind === "goal"`）入列**：DSH 的 `goal-round-driver` 就是 `createUserMessage` + `agent.followup`。不用：要改扩展的消息角色和历史格式，`user` 消息还会被当成真人输入，影响 Goal 工具的「本轮有真人消息」授权判断（`extensions/goal/auth.ts`）。
- **只去掉 `/goal` 的 toast，保留命令行**：命令行能标出设目标的时间点。不用：用户明确要求设目标只出 Goal 条；时间点在详情抽屉的操作记录里有。

## Consequences

- 每一轮续跑在对话里占一行收起的卡片，长 Goal（几十上百轮）会多出同样多的行；正文默认不展开。
- `groupMessages.mergeCommandInputs` 仍在，只是 `/goal` 不再产生命令行。

## Verification

- `cd electron-agent && npx vitest run src/stores/agentReducer.test.ts` 通过：`goal-round` 实时 start + end 每轮只出一条、两轮两条；历史还原出卡片；其他 `display: false` 仍被忽略。
- `npx vitest run src/features/chat/GoalRoundPill.test.tsx` 通过：标题取轮次、不写预算；用真实 `buildGoalRoundPrompt` 正文，收起不露条件、展开露出条件。
- `npx vitest run src/features/chat/ChatView.test.tsx` 通过：执行中设 `/goal` 不写命令行、不进对话。
- `npm run ui:check -- goal-round-card` 通过（13 条断言）：历史两轮两张卡片、别的 display:false 不显示、标题「目标续跑 · 第 N 轮」不写 256、展开 / 收起、实时第 6 轮只出一张、浅色可见。截图见 `.agents/evidence/2026-10-18-goal-round-cards-and-silent-create/`。
