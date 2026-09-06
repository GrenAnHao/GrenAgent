# Pi 会话 Goal 设计

日期：2026-09-06
状态：设计已确认，待用户审阅书面规格
适用范围：Pi Electron 版；Goal 扩展、AgentData 持久化、Electron 会话 UI 与续跑调度

## 1. 目标与边界

Goal 表示一个绑定到真实会话的持续执行目标。它允许 Agent 在多个真实 turn 中推进同一件事，但必须能够被暂停、恢复、验收、审计和安全停止。

本设计采用 DeepSeek 风格的“目标状态 + 独立续跑驱动”作为主结构，吸收 Codex 的权限校验、审计记录和真实用量记录思路，保留 Pi 的独立完成裁判。实现复用现有 `AgentData`、会话记录、Electron Turn 调度和 `AgentData` 事务，不重写 Pi 核心循环，不引入 Cordis。

Goal 的实时控制面只存在于当前会话页面内，不建立独立的“Goal”主页面。全局入口最多提供只读历史/审计查询，不能成为当前 Goal 的第二个控制源。

首版明确规则：

- 自动续跑默认上限为每个 Goal `256` 个真实轮次；用户可在直接授权下调整该上限。达到当前上限后停止并保留 Goal，不显示为已完成。
- 首版不引入 Token 或费用预算。轮次上限是唯一自动续跑上限；后续预算能力必须另行设计，不能隐式改变本版语义。
- 目标完成必须经过独立 LLM 裁判；裁判失败、不可用或输出无法解析时，Goal 保留且停止续跑，绝不进入 `complete`。

## 2. 用户界面模型

### 2.1 会话页内唯一入口

在 `ChatView` 的会话内容与输入框之间保留一条 `SessionGoalBar`，首版沿用现有 `GoalPill` 的紧凑视觉语言。它只读取当前真实 `sessionId` 的 Goal：

- 当前会话没有 Goal 时不占位，不显示空卡片。
- 有 Goal 时显示状态、目标摘要、已用轮次和最小操作集。
- 切换会话时替换为新会话的快照；不同会话不能共享同一条实时引用。
- 切换标签页或窗口不会暂停后台 Goal；后台调度始终按 `sessionId` 工作。

目标详情使用当前会话内的 inline disclosure 或右侧 drawer，不跳转路由。详情展示 `goalId`、`revision`、停止原因、裁判依据、阻塞计数和操作记录。

视觉原型已按此结构验证：`.superpowers/brainstorm/goal-ui-20260906-v1/content/goal-in-session-v2.html`。原型顶部的状态切换仅用于审阅状态表现，不属于生产 UI。

### 2.2 状态展示

| 内部状态 | 用户文案 | 会话页表现 | 允许的实时操作 |
| --- | --- | --- | --- |
| `active` | 执行中 | 绿色状态点，显示下一轮与已用轮次 | 暂停、修改、查看详情、清除 |
| `paused` | 已暂停 | 黄色状态点，显示暂停原因 | 恢复、修改、查看详情、清除 |
| `disarmed` | 待恢复 | 蓝色状态点，显示“快照存在但未激活” | 显式恢复、查看详情、清除 |
| `judging` | 正在验收 | 紫色验收条；与完成严格分开 | 查看裁判进度；禁止暂停、修改和清除 |
| `blocked` | 业务阻塞 | 红色停止原因卡，显示连续障碍次数 | 查看证据、解除阻塞并恢复、修改、清除 |
| `complete` | 已完成 | 绿色完成状态，显示裁判通过依据 | 只读详情；不再续跑 |
| `error` | 已停止（运行故障） | 红色/中性故障提示，显示可恢复原因 | 用户处理故障后显式恢复、查看详情、清除 |
| `cleared` | 已清除 | 当前会话显示墓碑折叠项 | 查看历史；不可自动恢复 |

`judging` 与 `complete` 不得合并成一个“完成中”状态。用户必须能明确知道“正在验收”尚未通过。

### 2.3 侧栏与全局入口

会话侧栏最多显示 Goal 的小状态点或轮次提示，用于发现异常；不在侧栏提供暂停、恢复或修改控制。全局历史/审计视图可以列出已清除、已完成和历史快照，但必须标明所属 `sessionId`，且不能直接操作当前会话的 live 状态。

## 3. 领域模型

AgentData 保存一条稳定的 Goal 快照和追加式历史。建议模型如下（字段名是跨进程契约的一部分）：

```ts
type GoalStatus =
  | 'active'
  | 'paused'
  | 'disarmed'
  | 'judging'
  | 'blocked'
  | 'complete'
  | 'error'
  | 'cleared';

interface GoalSnapshot {
  goalId: string;
  sessionId: string;
  revision: number;
  condition: string;
  status: GoalStatus;
  roundsUsed: number;
  maxRounds: number; // 默认 256；只能由直接人类授权调整
  createdAt: string;
  updatedAt: string;
  stopReason?: GoalStopReason;
  judge?: GoalJudgeRecord;
  blockage?: GoalBlockageRecord;
  sourceGoalId?: string;
  sourceSessionId?: string;
  clearedAt?: string;
}
```

`revision` 从 1 开始，每次目标内容、状态、恢复方式、轮次上限或裁判结果发生持久化变化时递增。所有写入、续跑请求、裁判结果和 UI 事件都带 `goalId + revision`；旧 revision 的结果必须被丢弃。

`sessionId` 是唯一实时归属键。workspace、项目路径和 Electron 标签页都不是 Goal 的所有权键；它们可以作为展示元数据，但不能替代 `sessionId`。

停止原因使用结构化值而不是只保存一段 UI 文本：

```ts
interface GoalStopReason {
  kind:
    | 'user_pause'
    | 'max_rounds'
    | 'judge_failed'
    | 'judge_unavailable'
    | 'blocked'
    | 'runtime_error'
    | 'persistence_error'
    | 'cleared';
  summary: string;
  at: string;
  turnId?: string;
}
```

裁判记录保存模型、调用时间、结论、结构化依据和对应 revision。业务阻塞记录保存可供审计的摘要、最近一次 turn、连续次数和经模型归一化后的障碍指纹；不把完整隐私输入复制到 Goal 表。

## 4. 状态转换

允许的主转换如下：

```text
create -> active
active -> paused             用户暂停或运行故障
active -> judging            Agent 显式申请完成
active -> blocked            同一业务障碍连续满足阈值
active -> disarmed           重启/历史恢复/fork 后恢复为非激活快照
judging -> complete          独立裁判通过
judging -> paused/error      裁判未通过、调用失败或输出无法解析
paused -> active             用户显式恢复且 revision 仍匹配
disarmed -> active           用户显式恢复且 revision 仍匹配
blocked -> active            用户确认解除阻塞且 revision 仍匹配
error -> active              用户处理故障后显式恢复
任意非 cleared 状态 -> cleared   用户确认清除
```

裁判判定“未完成”时不创建新 Goal，也不清除原 Goal；保留当前 revision、裁判缺失项和进展上下文，回到 `paused` 并等待下一次显式续跑。裁判通过才允许进入 `complete`。

## 5. Agent 工具与权限

### 5.1 只读工具

`get_goal` 只读取当前真实会话的 Goal，不接受任意 workspace 作为替代归属。返回当前快照、状态、轮次、停止原因和最近裁判摘要；没有 Goal 时返回明确的空结果。

### 5.2 创建工具

`create_goal` 只有在以下条件同时满足时可用：

- 调用者是顶层 Agent，不是子代理；
- 当前 turn 含有直接人类输入；
- 人类输入明确表达“持续推进直到完成”或等价意图；
- 当前会话没有另一个激活 Goal。

普通单轮任务、子代理 turn 和自动续跑 turn 不能隐式创建 Goal。创建后绑定当前 `sessionId`，初始 `revision=1`，状态为 `active`。

### 5.3 更新、恢复与清除

`update_goal` 必须带 `goalId + revision`。以下操作需要直接人类授权：修改目标、暂停、恢复、清除、调整轮次上限。首版 `maxRounds` 默认值为 256；调整后写入新 revision，续跑驱动只使用当前快照中的值。不开放 Token/费用预算。

自动续跑 turn 只允许三类业务动作：报告进展、申请完成、报告业务阻塞。自动 turn 不能修改目标、改变上限、恢复/暂停、清除或关闭裁判。

所有 revision 冲突返回“快照已变化”，要求 Agent 重新调用 `get_goal`；不得静默覆盖新目标。

## 6. 独立续跑驱动

续跑驱动是 Agent turn 结束后的独立调度层，复用现有 Electron Turn 调度，不把循环逻辑塞入 Goal 扩展的普通命令处理器。

每次调度前按事务读取最新快照并检查：

1. 状态为 `active`；
2. `roundsUsed < maxRounds`；
3. 当前 `goalId + revision` 没有在途续跑；
4. 没有 `judging`、`blocked`、`error` 或 `cleared` 状态；
5. 当前会话仍存在，但 UI 是否选中该标签页不影响执行。

调度器使用幂等键 `goalId + revision + nextRound` 防止重启、重复事件和多窗口造成重复 turn。每一轮完成后先在 AgentData 事务中追加进展和递增 `roundsUsed`，事务成功后再广播 UI。达到当前 `maxRounds` 只记录 `max_rounds` 停止原因，不改变为 `complete`。

持久化失败、凭据失效、模型不可用和调度器崩溃属于运行故障，立即停止续跑并进入 `error` 或带故障停止原因的 `paused`，不等待三次业务阻塞判定。

## 7. 完成验收与裁判

普通 Goal 轮次结束不调用裁判。只有 Agent 发出带 `goalId + revision` 和进展证据的内部 `goal_completion_request` 事件时，续跑驱动才原子地把 Goal 标记为 `judging` 并提交独立裁判请求。该事件不能由子代理伪造，也不能绕过独立裁判。

裁判输入至少包含：

- 当前 Goal 快照和 revision；
- 目标条件；
- 进展摘要、相关 turn 引用和结构化结果；
- 已报告但未解决的阻塞或缺失项。

裁判输出必须包含可解析的 `pass` / `fail`、理由和缺失项。处理规则：

- `pass` 且 revision 匹配：写入裁判记录并转为 `complete`；
- `fail` 且 revision 匹配：写入缺失项并转为 `paused`，保留 Goal；
- 调用超时、凭据失效、模型不可用、输出无法解析或 revision 不匹配：不写入完成结论；保留 Goal，记录故障并停止续跑；
- 旧 revision 的裁判结果：记录为过期事件，不得覆盖当前状态。

Agent 不能跳过、替换或关闭独立裁判。UI 的“已完成”只由持久化的裁判通过记录驱动。

## 8. 业务阻塞与运行故障

业务阻塞只有在同一语义障碍连续出现在至少 3 个真实 Goal 轮次、且当前没有其他安全可推进工作时才进入 `blocked`。程序负责记录真实轮次、保存摘要和计数；障碍是否语义相同由模型根据上下文判断。

恢复后连续计数重新计算。不同障碍、用户修改目标或出现可安全推进的新工作都会打断连续计数。

运行故障不使用 `blocked`：裁判不可用、凭据失效、AgentData 持久化失败、续跑调度失败等直接进入 `error`/故障暂停，并把具体原因展示在当前会话内。

## 9. 持久化、恢复与 fork

AgentData 是唯一权威状态来源；扩展内存和前端 Zustand 只做缓存/投影，不拥有最终状态。

- 状态、revision 和历史事件必须事务提交成功后才通知 UI。
- 重启、历史会话恢复和 fork 都保留 Goal 快照与历史，但默认状态为 `disarmed`，不自动续跑。
- 用户必须在对应会话内显式恢复，恢复请求带 `goalId + revision`。
- fork 创建独立 Goal 副本，生成新的 `goalId`，保留 `sourceGoalId/sourceSessionId` 引用，不共享 live 状态。
- `clear` 写入墓碑和清除事件，保留历史，不物理删除审计记录。
- 旧日志没有完整 Goal 快照时不猜测状态；首次打开显示“待恢复”，等待用户显式确认。

## 10. 会话页数据流

```text
当前 ChatView(sessionId)
  ├─ SessionGoalBar / GoalPill
  │    └─ get_goal(sessionId) ← AgentData 投影
  ├─ Goal 详情 drawer
  │    └─ stopReason / judge / blockage / audit events
  └─ 用户操作
       └─ update_goal(goalId, revision, action)
            └─ AgentData 事务
                 ├─ 提交成功 → 广播当前 session 的新快照
                 └─ 续跑驱动按新 revision 判断是否启动下一轮

Agent turn 结束
  └─ 续跑驱动读取最新快照
       ├─ active → 启动下一真实 turn
       ├─ completion request → judging → 独立裁判
       ├─ blocked/error/paused → 停止并记录原因
       └─ complete/cleared/disarmed → 不自动执行
```

前端事件必须包含 `sessionId + goalId + revision`。切换会话时旧事件即使迟到也只能更新旧 session 的缓存，不能覆盖当前页面。

## 11. 兼容现有模块

首版改动边界集中在以下模块：

- `extensions/goal/`：状态契约、Agent 工具、完成申请和裁判适配；不把持久化权威留在扩展局部内存。
- `electron-agent/electron/agentData/`：Goal 快照、历史事件、事务更新和按 session 查询。
- `electron-agent/electron/piRuntimeService.ts` 与现有 Turn 调度：承载独立续跑请求和幂等去重。
- `electron-agent/src/features/chat/input/GoalPill.tsx`、`MessageEditor.tsx`：会话内 GoalBar 和详情入口。
- `electron-agent/src/stores/goalStore.ts`：从单个 `goal` 投影改为按 `sessionId` 的缓存，不作为权威源。

不在本设计中重写 AgentData 其它 Memory/Wiki/CodeGraph 契约，也不改变已确认的 Electron 内置 CodeGraph SDK 方案。

## 12. 错误处理与用户可见性

| 情况 | 持久化结果 | UI 文案 | 是否自动续跑 |
| --- | --- | --- | --- |
| 用户暂停 | `paused + user_pause` | 已暂停 | 否，等待恢复 |
| 达到当前轮次上限 | `paused + max_rounds` | 已达到轮次上限 | 否 |
| 裁判未通过 | `paused + judge_failed` | 验收未通过，列出缺失项 | 否，等待显式继续 |
| 裁判调用失败 | `error/paused + judge_unavailable` | 验收服务不可用 | 否 |
| 同一业务障碍 3 轮 | `blocked` | 业务阻塞，显示计数和证据 | 否 |
| AgentData 写入失败 | `error + persistence_error`（若无法写入则保留内存故障日志） | 状态保存失败 | 否 |
| 清除 | `cleared` 墓碑 | 当前会话无激活 Goal | 否 |

任何无法证明完成的情况都不能显示“已完成”。

## 13. 测试与验收标准

### 13.1 状态与权限

- 创建条件只允许顶层 Agent 在直接人类 turn 中满足；单轮任务、子代理和自动 turn 被拒绝。
- `get_goal` 只能读当前 session；两个 session 的 Goal 互不覆盖。
- 所有写入缺少或使用旧 `goalId + revision` 时失败并返回最新 revision 提示。
- 自动 turn 无法修改目标、轮次上限、暂停/恢复或关闭裁判。

### 13.2 续跑与停止

- 轮次完成后事务先提交再通知 UI；重复事件不会创建重复 turn。
- UI 切换会话/标签页不影响后台续跑；新会话不会继承旧 Goal。
- 默认第 256 轮后停止且不是 `complete`；经授权调整上限后按新快照继续。
- 同一语义阻塞连续三轮才 `blocked`，恢复后计数重置；运行故障不等待三轮。

### 13.3 裁判与生命周期

- 普通轮次不调用裁判；完成申请才进入 `judging`。
- 裁判通过、未通过、超时、不可解析和旧 revision 结果各有回归测试。
- 重启、历史恢复和 fork 保留快照但默认 `disarmed`；fork 的 Goal 独立更新。
- clear 保留墓碑和审计；旧日志缺快照时显示待恢复而不是伪造状态。

### 13.4 UI

- 会话页无 Goal 时不占位；有 Goal 时只显示当前 session 的 GoalBar。
- 详情 drawer 可查看 revision、轮次、停止原因、裁判依据、阻塞证据和操作记录。
- `judging` 与 `complete` 的文案、颜色和可用操作不同。
- `blocked` 与运行故障的停止原因可区分；长目标、路径和错误不溢出。
- 在 1440×900、1200×800 和窄窗口下无控件重叠；键盘可聚焦 Goal 操作和详情抽屉。

## 14. 非目标

- 不建立跨会话共享的 live Goal 控制台。
- 不在首版加入 Token/费用预算、自动模型切换或多 Goal 并行编排。
- 不允许 Agent 自行宣告完成或关闭裁判。
- 不把业务阻塞、模型/凭据故障和持久化故障合并成一个模糊状态。
- 不引入 Cordis，不重写 Pi 核心循环，不修改 Tauri 版本。
- 不在本设计阶段修改生产代码或迁移历史日志内容。

## 15. 设计自检

- **占位符扫描：** 没有 TODO、未定义的“以后决定”或依赖用户隐式选择的字段；默认 256 轮、授权调整规则和首版不含 Token/费用预算已明确。
- **内部一致性：** `sessionId` 是唯一实时归属键；UI、Agent 工具、续跑驱动、持久化和事件广播均携带 session 与 revision；fork/恢复规则与 disarmed 状态一致。
- **完成边界：** 只有独立裁判通过才进入 `complete`；裁判失败和运行故障都不会误报完成。
- **范围检查：** 规格只覆盖 Goal 状态、续跑、验收、会话 UI 和其 AgentData 边界，可由一份实现计划拆成后端状态/调度、前端会话栏、裁判与测试三个阶段。
- **视觉验证：** 会话内 GoalBar、详情 drawer 和六种主要状态已在本地视觉伴侣原型中检查；生产 UI 尚未实现。
