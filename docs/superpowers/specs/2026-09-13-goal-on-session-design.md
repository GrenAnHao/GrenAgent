# Goal 回到 Pi 会话（脱离 AgentData）

- 日期：2026-09-13
- 状态：设计已确认，待审阅书面规格
- 主题：Goal 的权威源迁回当前 Pi 会话事件流；拆除 AgentData Goal 领域；完成由工作模型自报，续跑只在本会话。

本规格取代 `docs/superpowers/specs/2026-09-06-session-goal-design.md` 的权威源与调度（AgentData + Coordinator + headless worker + 独立裁判）。条的视觉与 `CHAT_CONTENT_WIDTH` 仍以 `docs/superpowers/specs/2026-09-13-goal-bar-and-chat-width-design.md` 为准，但其中 CAS `edit`、project 通道放行、`judging`、AgentData 历史等条款作废，改按本文。

## 1. 目标

Goal 是绑在**当前 Pi 会话**上的长期完成条件。`/goal`、条、模型工具、自动续跑读写同一份会话投影。不把 Goal 存进 AgentData，不另开 Goal worker。

成功标准：

1. `/goal` 与条能创建、查询、编辑、暂停、恢复、清除；不进模型轮次。
2. 工作模型在真人回合或当前 Goal Round 里可 `complete` / `blocked`；创建 / 编辑 / 暂停 / 恢复必须本轮有真人消息。人暂停过的，模型不能 `resume`。
3. `active` 且进程内 `armed` 时，一轮自然结束后在**同一会话**重入，并注入 Codex 式完成审计提示词。
4. 重开 / fork 默认 `disarmed`。应用设置「Goal 重开后自动继续」默认关；打开后仅 `active` 在 `session_start` 打成 `armed`。
5. AgentData 上的 Goal 表、RPC、Coordinator、GoalHost 删除。旧 AgentData Goal **不迁**，打开即视为无目标。

## 2. 领域

### 2.1 存储

权威源是当前会话 JSONL。每次获准变更追加一条 `type: "custom"`、`customType: "goal"` 的事件，字段至少：

```ts
{
  kind: 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'blocked' | 'clear' | 'round';
  goalId: string;
  revision: number;
  at: string; // ISO
  payload: Record<string, unknown>;
}
```

`session_start` 与每次写入后按 `revision` 升序折成当前快照。没有第二份库，没有跨会话 CAS。`revision` 只在本会话事件流里单调加一。

`clear` 之后投影为「当前无 Goal」；此前事件留在日志里供抽屉历史。新的 `create` 使用新 `goalId`，revision 从 1 起。

不迁 AgentData 快照。会话里没有 Goal 事件就是没有 Goal。

### 2.2 持久阶段与进程激活

持久阶段只有：`active` | `paused` | `blocked` | `complete`。没有 `judging`、`error`、持久 `disarmed`。

`activation` 为 `armed` | `disarmed`，只存在本进程，不写 JSONL。

| 时机 | activation |
| --- | --- |
| `create` | `armed` |
| 人 `pause`（写事件） | `disarmed` |
| 人把 `paused` / `blocked` `resume`（写事件，阶段回 `active`） | `armed` |
| 阶段已是 `active`，只是重开后未激活 | 不写事件；`/goal resume` 或条上恢复只把 activation 打成 `armed` |
| `session_start` / 进程起来 / fork 后的新进程 | 默认 `disarmed`；若设置 `goal.autoContinueOnOpen === true` 且阶段为 `active`，则为 `armed` |
| `complete` / `clear` | 无续跑 |

设置键写死为 `goal.autoContinueOnOpen`，布尔，默认 `false`，**应用级一项**。Electron 写进现有设置并经 ALS / `getConfig` 注入扩展；CLI 读同一配置键。所有会话共用。

### 2.3 快照

```ts
interface GoalSnapshot {
  goalId: string;
  revision: number;
  condition: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  roundsStarted: number;
  maxRounds: number; // 默认 256；首版不提供独立改上限命令
  createdAt: string;
  updatedAt: string;
  activation: 'armed' | 'disarmed';
  blockedReason?: { code: string; message: string };
}
```

`blocked` 的 `code` 固定为 `model-reported`。条和 `/goal` 回执不展示 `goalId` / `revision`；工具结果要带，供下一次 CAS。

### 2.4 事件载荷

| kind | 阶段变化 | payload |
| --- | --- | --- |
| `create` | → `active` | `condition`，可选 `maxRounds` |
| `edit` | 不变 | `condition`（trim 后 1..4000，否则拒绝） |
| `pause` | `active` → `paused` | 可选 `reason` |
| `resume` | `paused` / `blocked` → `active` | 无 |
| `complete` | → `complete` | 可选 `summary` |
| `blocked` | → `blocked` | `message`（非空） |
| `clear` | 投影清空 | 无 |
| `round` | 不变 | `round`（新的 `roundsStarted`） |

`complete` 仅来自 `active`。`edit` 允许 `active` / `paused` / `blocked` / `complete`（complete 只改文案，不重新激活）。`clear` 任意未清空投影都可。`round` 仅在扩展接纳下一次本会话重入时由扩展自己写，模型不能直接写 `round`。

## 3. 命令与工具

### 3.1 `/goal`

扩展注册 `goal`。桌面把它标成执行性命令：不进模型、不 `awaitingResponse`；对话列表可插本地 `{ kind: 'command-input'; id; command: '/goal'; rest }`，按 `sessionId` 内存索引，不写 JSONL，切会话或重载消失。`ChatView` 既有「已执行 /goal」toast 保留，与 `ctx.ui.notify` 并存。

解析（`args.trim()` 后，控制词大小写不敏感的整段相等用小写比较）：

| 输入 | 结果 |
| --- | --- |
| 空 | 查询回执；无 Goal 则提示没有目标 |
| 整段 `pause` / `resume` / `clear` / `reset` | 对应动作 |
| 整段 `edit` | 错误：缺条件 |
| `edit` + 条件但无 Goal | 错误：当前没有生效的目标 |
| `edit` + 空白 + 条件 | `edit` |
| 其它非空 | `create`；已有未 `complete` 的 Goal 则拒绝，提示先 edit 或 clear |

`/goal pause after verify` 为创建。条件 trim 后长度 0 或 >4000 拒绝（扩展预检错误码 `INVALID_PARAMS`）。

回执（`notify`，成功 `info`，失败 `error`；「没有目标」用 `warning`）：状态句、条件、`roundsStarted/maxRounds`、`activation`；`blocked` 加 `blockedReason.message`。不含 `goalId` / `revision`。

状态句：

| 条件 | 文案 |
| --- | --- |
| `active` 且 `armed` | 执行中的目标 |
| `active` 且 `disarmed` | 未运行的目标 |
| `paused` | 已暂停的目标 |
| `blocked` | 受阻的目标 |
| `complete` | 已完成的目标 |

条上恢复在「仅激活」时不写 `resume` 事件；在 `paused` / `blocked` 时写 `resume`。

### 3.2 模型工具

只保留三个：`get_goal`、`create_goal`、`update_goal`。删除 `block` / `begin_judging` 及任何 `MemoryClient` Goal RPC。

- `get_goal()` → 当前快照或 `null`（含 `activation`）。
- `create_goal({ condition, maxRounds? })` → 新 Goal，`armed`。
- `update_goal({ goalId, revision, action, condition?, blocked_reason? })`，`action` 为 `edit` | `pause` | `resume` | `complete` | `blocked`。

权限在执行时认轮次来源：

- 必须是当前运行中的根 agent、开放轮次。
- `create` / `edit` / `pause` / `resume`：本轮已有来源为用户的消息。
- `complete` / `blocked`：上述真人权限，**或**本轮有来源为 Goal 且 `goalId` / `revision` / `round === roundsStarted` 的 Goal Round 消息。
- 持久 `paused` 的 `resume`：一律拒绝（`GOAL_TOOL_RESUME_PAUSED`），只走命令 / 条。
- `blocked`：`roundsStarted >= 3` 且 `blocked_reason` 非空；是否同一障碍由模型判断。阈值常量 `3`。

`complete` / `blocked` 的工具结果不结束轮次；模型仍可对用户说一句收尾（对齐 DSH wrap-up）。

### 3.3 完成审计提示词

每次 Goal Round 注入的续跑正文采用 Codex `continuation.md` 的完成 / 阻塞审计要求（对着当前工作区逐条核需求，证据不够就继续干，禁止靠记忆标 `complete`；`blocked` 须过连续阈值）。人 `edit` 条件不单独再跑一轮审计。首版不做人改 `maxRounds` 的命令。

## 4. 续跑

只在当前可见会话。`agent_end` 且非用户中止时：

1. 无 Goal，或 `status !== 'active'`，或 `activation !== 'armed'` → 结束。
2. `roundsStarted >= maxRounds` → 不重入，阶段保持 `active`，不标 `complete`。
3. 否则追加 `round`（`roundsStarted + 1`），对同一会话 `sendMessage(续跑正文, { triggerTurn: true })`，来源标 Goal Round（当前 `goalId` / `revision` / 新 round）。不出现用户气泡。

用户 Esc / 中止：不重入，**不等于** `pause`，armed 不变。

`goal.autoContinueOnOpen === true` 且 `session_start` 时阶段为 `active`：设 `armed`；若会话空闲，立即按上面第 3 步重入一次。fork 出的新会话重放事件，新进程仍先走默认 `disarmed`（除非该设置打开且阶段 `active`）。

不引入 token 预算。轮次上限是唯一自动上限。

## 5. 条与宽度

附着、灯、经过时间、`aria-label`、清除确认、行内编辑、完成态留下、无目标不渲染：沿用 `2026-09-13-goal-bar-and-chat-width-design.md` §2，并做这些替换：

- 数据：扩展 `setStatus` → zustand。禁止 `agentDataApi.goals`。
- 动作：调用与 `/goal` 相同的扩展 handler（不经模型）。
- 去掉 `judging` / `error` 行。`active`+`disarmed` 用「未运行的目标」+ 灰灯 + 恢复。
- `blocked` 的整行 `title` 为 `blockedReason.message`。
- 抽屉历史读本会话 `customType: "goal"` 事件，不读 `admin.goal.history`。

按钮：

| 状态 | 暂停/恢复 | 编辑 | 清除 | 放大 |
| --- | --- | --- | --- | --- |
| `active` + `armed` | 暂停 | 有 | 有 | 有 |
| `active` + `disarmed` / `paused` / `blocked` | 恢复 | 有 | 有 | 有 |
| `complete` | 无 | 无 | 有 | 有 |

`CHAT_CONTENT_WIDTH = 'min(100%, 1120px, max(760px, 86%))'` 可与本次一起改，不依赖 Goal 拆除顺序。

## 6. 拆除范围

删除（不留兼容层、不做 migrate）：

- `electron-agent/electron/agentData/goalStore.ts` 及 Goal 表 / lease
- `admin.goal.*`、project `goal.*`、`runtime.ts` 的 Goal 方法与 origin 盖章
- IPC `agentData_goal_*`、`agentDataApi.goals`
- `GoalCoordinator`、`GoalHost`、`createGoalHandle`
- `recoverLegacy`、`admin.goal.fork`、`migrateLegacyGoal`
- 扩展经 `MemoryClient` 调 `goal.*`

保留：AgentData 的 Memory / Wiki / CodeGraph / 任务 / 工具审批。

`extensions/goal`：事件折算、命令、三个工具、`agent_end` 续跑、完成审计提示词。`tools.ts` 不再暴露 `block` / `begin_judging`。

前端 zustand 快照改为 §2.3。不改 `tauri-agent` 的 Goal UI；若它仍调用已删 IPC，切断引用，避免挂死。

写 JSONL 失败：变更不成，`notify` 失败，不回退到任何库。工具权限失败用稳定错误码（`GOAL_TOOL_*` / `GOAL_TOOL_RESUME_PAUSED`）。

## 7. 测试

只测 Electron + `extensions/goal`（及拆除后主进程不再导出 Goal RPC）。

- 折算：create→edit→pause→resume→round→complete；clear 后投影空；revision 单调。
- `/goal` 解析表 §3.1，含裸查询、`pause after verify` 创建。
- 工具权限：无真人不能 create；Goal Round 能 complete；paused 不能被模型 resume；blocked 轮次不足拒绝。
- `agent_end`：armed 重入并写出 `round`；disarmed / paused / 中止 / 达上限不重入。
- `goal.autoContinueOnOpen` 开关：默认 session_start 不重入；打开且 active 则 armed（空闲则重入）。
- 条：armed / disarmed / complete / 无目标；编辑走 `edit`；清除确认。
- 主进程：Goal RPC 通道不存在；Memory/Wiki 回归仍过。

## 8. 非目标

- 不把 Goal 做进 `@earendil-works/pi-coding-agent` 内核 fork。
- 不引入 Cordis。
- 不恢复独立裁判 / `judging`。
- 不做 token 预算、不做按工作区或按 Goal 的自动继续。
- 不迁 AgentData 旧 Goal。
- 不升级 tauri Goal 条。
- 不加 Goal 快捷键。

## 9. 规格自检

- 权威源、阶段、activation、设置键、事件 kind、工具权限、续跑条件、条按钮、拆除清单、不迁数据均已写死。
- 与 9 月 6 日规格矛盾处（AgentData 权威、独立裁判、持久 disarmed、headless worker）以本文为准。
- 范围可收进一份实现计划：扩展领域 + 桌面命令/条接线 + 拆除 AgentData Goal。宽度常量可同计划末任务。
