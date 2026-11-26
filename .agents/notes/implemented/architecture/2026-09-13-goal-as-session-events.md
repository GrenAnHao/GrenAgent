# Agent Note: Goal 的权威源是会话 JSONL 事件，拆除 AgentData Goal 领域

Status: implemented

当前边界：JSONL 权威源、单写者和本会话自报继续有效。最终异常收口、批次预算、不可变回合授权与可信控制回执由[生命周期修复](../bug-fix/2026-11-17-visual-review-and-goal-lifecycle.md)补充；不恢复 AgentData Goal 或独立裁判。

## Problem

Goal 原设计（`docs/superpowers/specs/2026-09-06-session-goal-design.md`，af51de67 落地）把 Goal 存在 AgentData：schema v3 + CAS 更新 + 回合租约、独立完成裁判、Coordinator 自动派发、headless Goal worker。规格 `docs/superpowers/specs/2026-09-13-goal-on-session-design.md` 取代了其权威源与调度。

## Decision

- Goal 绑在当前 Pi 会话。每次变更经 `pi.appendEntry("goal", event)` 追加 `customType: "goal"` 条目（`kind`：create / edit / pause / resume / restart / complete / blocked / clear / round；不进 LLM 上下文），`session_start` 与每次写入后按 `revision` 折成快照；续跑正文走 `customType: "goal-round"`。
- 完成由本会话工作模型通过 `update_goal(complete|blocked)` 自报，并校验不可变工作归属与 CAS，没有独立裁判；模型控制工具仍受真人回合约束，人暂停过的模型不能 `resume`。人工命令／UI 使用可信控制服务，开启新批次不以 session 级 human mark 授权。
- 重开 / fork 默认 `disarmed`；仅当 `goal.autoContinueOnOpen === "true"` 且阶段为 `active` 时武装。
- AgentData Goal 表、RPC、Coordinator、GoalHost、Goal worker 删除（34fc14fa、9f675ff0）；旧 AgentData Goal 不迁移。
- 单写者假设：同一会话文件同一时刻只由一个进程续写。

### 涉及文件

- `extensions/goal/`
- `electron-agent/src/features/chat/`

### 来源

- d11741a1
- 490521ad
- 34fc14fa
- 9f675ff0
- `docs/superpowers/specs/2026-09-13-goal-on-session-design.md`

## Alternatives considered

- **AgentData + Coordinator + headless worker + 独立裁判（原设计）**：跨会话可见、裁判独立于工作模型。被取代：旧 Goal 不够强大，参考 Codex 与 dsh 的设计重新设计（用户说明）。

## Consequences

- Goal 状态随会话文件走：fork / 回退天然带上；跨会话的 live Goal 页面不存在。
- 渲染层的 Goal 条按会话路径补拉（主进程 `agent_get_goal`），推送只是增量，见 [Goal 条按会话路径补拉](../bug-fix/2026-10-18-goal-bar-pull-hydration.md)；续跑轮次在对话里的卡片见 [续跑卡片](../feature/2026-10-18-goal-round-cards-and-silent-create.md)。
- 两进程并发写同一会话的 Goal 事件不受支持（规格 §8）。

## Verification

verify: n/a 回填的历史决定，规格与提交未记录验证结果
