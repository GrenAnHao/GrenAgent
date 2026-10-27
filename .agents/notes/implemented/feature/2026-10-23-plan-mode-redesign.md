# Agent Note: Plan 模式重设计（一等工件 + 侧栏确认执行）

Status: implemented

## Problem

旧 Plan 模式是 2026-06 前后的卡片化实现，产品侧几乎不用，体验落后于 Codex / Claude Code 的「先产出可审阅 plan → 确认后再执行」。

当时的实现（2026-10-23 摸底）：

- 入口在输入栏模式（`ModeAction` → `pi.setMode(..., 'plan')`），实现并入 `extensions/agent-mode/`，提示词 `extensions/fable-behavior/prompts/modes/plan.md`
- 没有写 plan 的 tool；模型靠自由文本约定 `Plan:` + 编号列表；`agent_end` 用 `extractTodoItems` 抠列表 → `buildPlanCard` / `writePlanFile` → `customType:"agent-plan"`；对不上格式就静默不出卡
- `PlanCard`「View Plan」只读 Modal；步骤经 `cleanStepText` 截到约 50 字；卡状态写死 `draft`；每次规划 `makePlanId()` 新文件，没有同 id 修订
- 执行靠卡上「开始执行」→ `/plan-build`；用户手切 Agent 就能绕过确认

Plan 不是一等工件，而是「解析出来的卡片」：不可编辑、不可再确认，也没有「确认后自动开跑」的主路径。旧设计意图见归档规格 `docs/superpowers/archive/specs/2026-06-17-plan-mode-cards-design.md`，仅作历史，不是实现依据。

## Decision

用户 2026-10-23 拍板的四条（A 侧栏、B `upsert_plan`、C 唯一执行入口是侧栏确认、D 不管旧内容）全部落地，外加「未确认时手切执行模式 → 取消切换并提示」。

### 源真值与投影

- 结构化 `Plan`（`extensions/agent-mode/plan.ts`）：`id / title / goal / steps[{text, done}] / risks / status / rev / createdAt / updatedAt / updatedBy / file`。步骤全文，不截断。
- 每个会话至多绑定一份 Plan，存在扩展闭包里，随 `agent-mode` 会话条目（`{ mode, savedTools, plan, planSeenRev }`）持久化；`session_start` 用 `restorePlan` 读回，只认新形状，旧版 `todos / executing` 一律忽略（D）。
- `.pi/plans/<id>.md` 只是投影（frontmatter + 标题、目标、步骤、风险），每次变更重写；写失败不影响源真值。
- 同一份 Plan 修订不换 id，`rev` +1。`createPlan` / `revisePlan` / `withStatus` 是纯函数。

### 状态机

`（无 Plan）→ drafting → ready → confirmed → executing → done | cancelled`

- `drafting` / `ready` 是「未确认」：步骤为空是 drafting，非空是 ready，由 `upsert_plan` 或侧栏保存决定。
- `ready → confirmed → executing` 只发生在 `/plan-confirm` 里，单一编排：落 `confirmed`（宿主守卫随即放行）→ `applyMode("agent")` 还原完整工具集 → 落 `executing` → `sendMessage(plan-execute, triggerTurn)` 带全文步骤开跑。开跑那一轮不再重复注入剩余步骤（`skipNextExecutionContext`），之后每轮 `before_agent_start` 注入 `plan-execution-context`（剩余步骤全文）。
- 执行进度沿用 `[DONE:n]`：`turn_end` 里 `markDoneFromText` 标完成；`agent_end` 时全部完成 → `done` 并发 `plan-complete`。侧栏可手动「标记完成」（`/plan-finish`）或取消。
- 取消（`/plan-cancel`）在任何未终态都可用，进入 `cancelled` 后宿主守卫不再拦。

### 工具与闸

- `upsert_plan`（`defaultActive: false`）只在 plan 模式激活：`PLAN_TOOLS = ASK_TOOLS + PLAN_ONLY_TOOLS`，`syncTools` 在 plan 模式补上它、其余模式经 `withoutPlanOnlyTools` 去掉；`gateToolCall` 在非 plan 模式拦 `upsert_plan`。plan 模式下执行类工具照旧被白名单 + `isSafeCommand` 拦。
- `upsert_plan` 每次全量覆盖：省略 planId 时修订当前未确认的 Plan，没有就新建；传了对不上的 planId、参数不合法都直接 throw，模型拿到的是显式错误结果，不做静默修补。新建时对话流只发一张摘要卡，修订不再发。
- 规划回合（plan 模式、没被中断、没出错）结束时，本轮没成功调用 `upsert_plan` 且会话没有未终态的 Plan → 发 `agent-plan-missing` 显式失败提示。不回退到解析正文。
- 用户在侧栏改过（`rev !== planSeenRev`）后，下一轮规划经 `plan-edited-context` 把当前版本告诉模型。

### 宿主守卫

`extensions/agent-mode/planState.ts` 是按 sessionId 的内存表，扩展写、宿主读（agent-host 进程静态引入扩展，同一份模块）。`piRuntimeService.writeAgentMode` 在写内存 / 落条目 / 写盘之前调 `planBlocksModeSwitch`：会话有未确认 Plan 且目标是能动手的模式（agent / debug / brainstorm）时直接返回 `{ ok: false, blocked: 'PLAN_UNCONFIRMED', mode, message }`，什么都不改。扩展的 `before_agent_start` 再兜一道：live 模式被别的路径改成能动手的模式时拉回 plan 并提示。

### 线上契约

| 方向 | 形状 |
| --- | --- |
| 扩展 → 前端 | `setStatus("agent-plan", JSON.stringify({ plan: Plan \| null, reason: "created" \| "updated" \| "sync" }))`；`created` 时前端自动打开计划面板 |
| 扩展 → 对话流 | `customType: "agent-plan"`，正文 `[plan:<id>] 已生成计划「<title>」…`（短句给模型看，前端按前缀认 planId）；`agent-plan-missing`；`plan-execute` / `plan-complete` |
| 面板 → 扩展 | `pi.runCommand(workspace, "/plan-update <json>" \| "/plan-confirm <id> <rev>" \| "/plan-cancel <id>" \| "/plan-finish <id>", sessionPath)`，走 `agent_prompt` + `targetSessionPath`；pi 对扩展命令即时执行、不算回合；拒绝时只 `ctx.ui.notify` |
| 宿主 → 前端 | `agent_set_mode` 被拦时回 `{ ok: false, blocked: 'PLAN_UNCONFIRMED', mode, message }`；`ModeAction.readBlocked` 退回乐观更新并 toast 原文 |

`/plan-update` 带基准 `rev`，对不上就拒绝（模型同时修订过），面板提示冲突。`/plan-confirm` 同样核对 rev，并在会话非空闲时拒绝。

### 前端

- `src/stores/planStore.ts`：按会话 key（与右坞 `dockSessionKey` 同一套）存 Plan 快照；`ExtensionUiHost` 收 `agent-plan` 写入，归属用 `visualOwnerOf`（与视觉设计相同规则）。
- 侧栏是右坞的会话归属标签 `kind: 'plan'`（`openPlanDockTab`），跟着会话走、不跨重启持久化（重启后 `session_start` 重推快照，从摘要卡重新打开），对齐 [右侧边栏跟会话走](../bug-fix/2026-10-16-right-dock-session-binding.md) 与 [视觉设计按会话归属](../bug-fix/2026-10-16-visual-design-session-binding.md)，没有另起一套侧栏。
- `PlanPanel`：未确认时可改标题 / 目标 / 步骤（改字、上下移、删、加）/ 风险，保存、确认执行、取消计划（二次确认）；有未保存修改、步骤为空、会话在跑时「确认执行」不可点并写原因；草稿对比的是它所基于的那一版，store 推来新版本而本地有改动时显示冲突，「载入最新」才覆盖。执行中只读，显示进度、取消、标记完成。
- `PlanSummaryCard`：只显示标题、状态、步数 / 进度和「打开计划面板」，没有执行按钮；会话里的 Plan 已换成别的 id 时写「已被新的计划取代」。旧版 JSON 卡片不渲染（D）。`PlanCard.tsx` 与 `/plan-build` 已删除。
- 提示词 `plan.md` 改为驱动 `upsert_plan`，不再要求 `Plan:` 列表。

## Alternatives considered

- **小修旧 PlanCard / 解析路径** — 最强理由：改动面小，已有「点开始执行才放行」骨架。不用：解析脆、不可编辑是结构问题，小修达不到「可审阅、可改、确认即开跑」。
- **模型纯结构化消息（无 tool）再解析** — 最强理由：少注册一个 tool，提示词约定 JSON / frontmatter 即可。不用：与旧路径同类的二次解析失败模式，没有 schema 校验与显式失败态，同 id 修订边界不清。
- **确认交互放在卡内按钮 / 模态工作区** — 最强理由：少一个侧栏面、路径短。不用：用户要更大的阅读编辑面积，已定侧栏。
- **未确认手切 Agent：丢弃或挂起带回** — 最强理由：少打扰、允许先去 Agent 干别的。不用：会变成绕过确认的第二入口；已定为取消切换并提示。
- **守卫只拦 Agent（字面要求）** — 最强理由：Debug / Brainstorm 是不同用途，用户可能就想先调试。不用：两者都有完整工具集，手切进去同样绕过确认；所以按「能不能动手」拦 agent / debug / brainstorm，只读的 Ask 放行。
- **旧 `.pi/plans` 自动导入 / 只读兼容一版** — 最强理由：不丢历史计划文件。不用：用户明确不管旧内容。
- **面板回写走新的主进程 IPC（如 `agent_plan_update`）** — 最强理由：有类型、不和 prompt 队列共用通道、可以直接回结果。不用：Plan 的源真值和副作用（`appendEntry`、`setActiveTools`、`sendMessage` 开跑）都在扩展闭包里，IPC 还得再桥回扩展；pi 的扩展命令本来就即时执行、即使在流式中也不排队，宿主也不把 `/` 开头的输入记成回合，`targetSessionPath` 解决了路由。代价是结果只能经 notify / 状态推送回来，面板用 4 秒超时放开按钮。
- **执行进度另加一个 `update_plan_progress` 工具** — 最强理由：结构化、不靠正文标记。不用：`[DONE:n]` 已经可用，多一个工具就多一份 promptGuidelines 和执行模式下的工具噪音；漏标时侧栏可手动标记完成。

## Consequences

- 收益：Plan 是结构化工件，全文步骤从模型到侧栏、执行提示一致；进入执行只有侧栏确认一条路，手切被宿主在写任何状态之前拦下；规划回合没有工件时用户看得到失败。
- 代价：面板操作的失败只能经 toast 回来，没有同步返回值；扩展命令和 prompt 共用 `agent_prompt` 通道，前面有排队的 prompt 时命令也会排在后面（面板在会话运行时禁用确认，扩展再查一次 `isIdle`）。
- `upsert_plan` 漏调时不会救场，提示词与 promptGuidelines 是唯一驱动；模型不调就只看到 `agent-plan-missing`。
- 进度依赖模型写 `[DONE:n]`；不写时停在执行中，要用户手动标记完成或取消。
- 计划标签不跨重启持久化；重启后从摘要卡重新打开。
- 回滚：去掉 `upsert_plan` 注册与 `writeAgentMode` 守卫即退回「只有模式、没有计划工件」；因 D 不承诺恢复旧卡行为。
- 没用真实模型跑过一次完整规划 → 确认 → 执行；模型是否稳定调用 `upsert_plan` 要靠后续使用观察。

## 验证

- `cd extensions/agent-mode && npx vitest run`：6 个文件 81 条通过（`plan.test.ts` 覆盖校验、同 id 修订、全文不截断、`[DONE:n]`、投影；`planFlow.test.ts` 覆盖 `upsert_plan` 激活与报错、摘要卡只发一次、侧栏保存与 rev 冲突、确认切 Agent 并带全文开跑、执行进度到 done、取消、缺工件显式失败、会话条目读回且忽略旧卡数据、`before_agent_start` 兜底拉回 plan）。
- `cd extensions && npx vitest run agent-mode prompt-metadata.test.ts fable-behavior`：11 个文件 112 条通过（日志 `.agents/evidence/2026-10-23-plan-mode-redesign/vitest-extensions.log`）。全量 `npx vitest run` 另有 `multi-agent/runner.test.ts` 一条失败（`resolveSubagentModel` 读到本机 runtime config 的 `SUBAGENT_MODEL`），与本次改动无关。
- `cd electron-agent && npx vitest run electron/app/piRuntimeService.test.ts src/stores/planStore.test.ts src/features/chat/input/commandUtils.test.ts src/features/extensionUi`：5 个文件 116 条通过（含新增「未确认的计划在场时手切到 Agent 被取消：不动内存、不落条目、不写盘」；日志 `.agents/evidence/2026-10-23-plan-mode-redesign/vitest-electron.log`）。另跑了 `src/features/extensionUi src/features/chat/input src/stores/dockStore src/features/dock src/features/chat/ChatMessageItems`：86 个文件 681 条通过。
- `npm run ui:check -- plan-panel`：新场景全部通过（自动开面板、全文步骤、改字 / 下移 / 加步骤后保存为第 2 版且 `/plan-update` 带同 planId 与基准 rev、模型修订时冲突与载入最新、手切 Agent 被拦后选择器退回 Plan 并 toast 原文、确认后 Agent + 执行中 + 进度、标记完成、新计划使旧卡显示已被取代、取消二次确认、浅色主题）。日志与截图在 `.agents/evidence/2026-10-23-plan-mode-redesign/`。
- `node ui-harness/check.mjs dock-session-binding subagent-approval plan-panel`：3 个场景通过（改了 `dockStore` / `TabBodyRenderer` / `ExtensionUiHost` 这些共用代码，`--changed --dry-run` 列出的受影响场景里挑了行为可能变的两个；日志 `.agents/evidence/2026-10-23-plan-mode-redesign/ui-check-related.log`）。
- 部分通过：没有用真实模型在桌面端跑一遍完整的规划 → 侧栏编辑 → 确认执行；本仓库没有可用的 `verify-*` skill。
