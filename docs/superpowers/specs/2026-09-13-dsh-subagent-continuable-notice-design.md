# DSH 子代理第二期：可续聊 Activation + settle notice

- 日期：2026-09-13
- 状态：已落地（2026-09-14 核实）
- 复核：2026-09-13 对照 `extensions/multi-agent` 与 `@earendil-works/pi-coding-agent` 类型做过一轮修订（见 §12 附录）
- 主题：对齐 DeepSeek Harness（DSH）可继续子代理：进程内 Activation、inbox（Queue / Steer）、相邻 `send_message`、结算后向父会话注入 notice。
- 依赖：[规格 1：真会话子代理](./2026-09-13-dsh-subagent-session-child-design.md)（已落地）
- 后继：[规格 3：页头目录](./2026-09-13-dsh-subagent-header-catalog-design.md)、[规格 4：fork 种子](./2026-09-13-dsh-subagent-fork-seed-design.md)
- 关联：`extensions/multi-agent/`、`electron-agent/electron/agent/workspaceHandle.ts`、`electron-agent/src/features/chat/ChatMessageItems.tsx`

---

## 1. 目标与范围

规格 1 已经让 sidecar 里的子代理拥有独立 JSONL，但跑完即 `dispose`，父模型只靠工具结果收一次正文。DSH 的可继续子级不是这样：子 Session 留下，进程内至多一个 Activation，相邻 Agent 可再投递，Activation 自然结算后往父会话塞一条运行时 notice。

本期只做这一层，而且只覆盖 **sidecar + Electron + 已走 embedded 的路径**。

| 入口 | 本期语义 |
|------|----------|
| `spawn_agent({ action: "run" })`（默认） | 保持规格 1：阻塞 one-shot，工具结果 = 最后助手正文，跑完 dispose，**不**发 notice |
| `spawn_agent({ action: "spawn" })` + embedded | **改为可续聊**：立即返回 `agentId` + `sessionPath`，Activation 留下，结算后 notice |
| `spawn_agent({ action: "spawn" })` + 子进程回退 | 保持 registry 后台；进程退出后发 **一条** notice；**不能** `send_message` / 冷恢复 |
| `tasks` / `chain` / worktree | 仍是 one-shot，不进 Activation |

**成功标准：**

1. Electron 里 `action: "spawn"` 返回后父模型可以继续干活；子代理空闲且 inbox 空时，父会话出现一条 `customType: "subagent-settled"` 的 notice，正文句式与 DSH 一致。
2. 父模型可用 `send_message({ agent_id, message })` 把后续话投给该子代理；驻留中的子代理也可以把结果发回直接父级。调用只回执「已接受」，不带回回复。
3. `interrupt_agent` 只停当前轮次，inbox 与 JSONL 保留；`spawn_agent({ action: "cancel" })` 仍是整段拆除并发 `aborted` notice。
4. sidecar 重启后，JSONL 还在的可续聊子级可以冷恢复；不把「进程没了」写成一次对父模型的结算。

**范围**：`extensions/multi-agent` + Electron 主进程 host 钩子 + notice 渲染。CLI / Tauri 继续走子进程；它们的 `action: "spawn"` 只多一条 notice，没有 Activation。

---

## 2. 方案取舍（已锁定）

| 方案 | 做法 | 不选原因 |
|------|------|----------|
| A. 在规格 1 的 `AgentSession` 上做 Activation / inbox（**采用**） | 进程内保住 `AgentSession`，用已有 `prompt(..., { streamingBehavior })` 映射 Queue / Steer | 与规格 1 同构，不引入 DSH Agent 运行时 |
| B. 把 DSH `dsh-subagent` 原包搬进 sidecar | 真 inbox、真 Activation 图 | 依赖 Cordis / Session projection，越界 |
| C. 只加 notice，不加 Activation | `action: "spawn"` 结束时 `sendMessage` | 没有可续聊，规格 3 的编辑器无处投递 |

不把 `spawn_agent` 改名为 `subagent`，不默认把 `action: "run"` 改成后台。

---

## 3. 形态对照

DSH 用 SessionId；GrenAgent 已经用 `sa-…` 当子级对外 id，继续用。父级对外 id 是父会话 JSONL 头里的 `id`（UUID）。

| DSH | GrenAgent 本期 |
|-----|----------------|
| Continuable Activation | 进程内 `AgentSession` + inbox 包装，同一 `sa-…` 同时最多一份 |
| Inbox `followup` / `steer` | `session.prompt(text, { streamingBehavior: "followUp" \| "steer" })` |
| `sendMessage()` 相邻权限 | 新工具 `send_message`；只允许直接父→子、驻留子→直接父 |
| `createSettlementMessage` + `sendWaking` | 父扩展 `pi.sendMessage({ customType: "subagent-settled", display: true }, { triggerTurn, deliverAs })` |
| 冷恢复 | `SessionManager.open` + `createAgentSessionFromServices`，只对 `subagent_meta.mode === "continuable"` |
| `interrupt`（keepInbox） | `interrupt_agent` → `session.abort()`，不 dispose |
| 无持久父邮箱 | 父 Session 不在线则子→父投递失败，不排队 |

Pi 约定（已核对 `@earendil-works/pi-coding-agent` 的 `.d.ts`）：

| 目的 | 扩展侧 API（`pi`） | 手里有 `SessionManager` 时 |
|------|-------------------|---------------------------|
| 持久化、不进模型（`custom`） | `pi.appendEntry(customType, data)` → `void` | `sessionManager.appendCustomEntry(customType, data)` |
| 进模型上下文 + 落盘 + 可唤醒（`custom_message`） | `pi.sendMessage({ customType, content, display, details }, { triggerTurn?, deliverAs? })` → `void` | `session.sendCustomMessage(...)` |

`custom` 不进模型，`custom_message` 进模型。notice 必须走 `sendMessage`，只 `appendEntry` 父模型看不到。**不存在** `pi.appendCustomEntry`——写规格/实现时不要沿用这个名。

---

## 4. 模块与宿主

不要再往 `embedded-runner.ts` / `index.ts` 里堆状态机。

| 文件 | 职责 |
|------|------|
| `extensions/multi-agent/activation.ts` | `ChildLock`、驻留表、结算监视、拆除顺序、冷恢复入口 |
| `extensions/multi-agent/inbox.ts` | 关闭中拒收；`followUp` / `steer` 投递 |
| `extensions/multi-agent/settlement-notice.ts` | DSH 句式、`stopReason` → 摘要 |
| `extensions/multi-agent/adjacent-tools.ts` | 注册 `send_message`、`interrupt_agent` |
| `extensions/multi-agent/parent-host.ts` | 父会话 host 注册表（`sendNotice` / `isBusy` / `isDraining`） |
| `extensions/multi-agent/embedded-runner.ts` | 拆出 `createEmbeddedChildSession`（建 Session、绑扩展、不 dispose）；one-shot 仍在跑完 dispose |
| `electron-agent/electron/agent/workspaceHandle.ts` | `start()` 注册 parent host；`dispose()` 先 drain 子 Activation |

`WorkspaceHandle` 不拥有 Activation 图，只提供「这个工作区当前父会话」的投递能力。Activation 图挂在 sidecar 进程内单例上，按 `cwd` 分桶。

**`pi` 是每会话一个实例**（扩展 factory 每次 `bindExtensions` 各跑一次），进程里可能有多个工作区 / 多个父会话。因此：

- parent-host 注册表按 **`sessionPath`** 分桶，表项必须带 `workspace`；
- 子→父投递时校验 `activation.workspace === host.workspace`，否则 `UNAUTHORIZED`。不能只按 `cwd` 桶找 host——A 工作区的子级会把结果塞进 B 工作区的父会话；
- 拿「当前调用方是谁」一律走工具 `ctx`（`ctx.sessionManager.getSessionId()`），不要依赖模块级 `let currentPi`。

---

## 5. 数据

### 5.1 子会话 `subagent_meta`

规格 1 已写 `origin / agentId / parentSession / model`。本期补齐，仍用 **子会话** `sessionManager.appendCustomEntry`（`custom`，不进模型；扩展侧写父目录才用 `pi.appendEntry`）：

```ts
{
  origin: "subagent";
  agentId: string;          // sa-…
  parentSession: string | null; // 父 JSONL 路径
  parentSessionId: string | null; // 父头 id，供 send_message
  model: string | null;
  mode: "one-shot" | "continuable";
  label: string;            // 任务首行，截断到 80 字，供规格 3
  inheritedEventCount: number; // 规格 4 种子长度；本期恒为 0
}
```

`mode` 在创建时冻结。失败的创建不写这条，也不写规格 3 的目录事实。

`label` / `mode` 与规格 3 的 `subagent_catalog` 事实有重叠：**目录显示以 `subagent_catalog` 为准**，`subagent_meta.label` 只作父目录行缺失时的兜底（例如父日志被外部工具改坏）。不要在两处各维护一份真值。

### 5.2 Activation（进程内，不持久）

```ts
interface Activation {
  childId: string;
  sessionPath: string;
  parentSessionId: string;
  parentSessionPath: string;
  workspace: string;
  mode: "continuable";
  session: AgentSession;
  inbox: SubagentInbox;
  announced: boolean;       // 首次 inbox 接受后为 true；未宣布的拆除不发 notice
  ownedChildren: Set<string>; // 本期恒空（仍禁止嵌套 spawn）
  poke: PromiseWithResolvers<void>;
}
```

同一 `childId` 的投递、结算、拆除走一把 `ChildLock`（失败的一节不能拒绝后续无关调用）。

### 5.3 父 host

`action: "spawn"` 进入 embedded 时，用**父扩展**的 `pi` 注册：

```ts
interface ParentSessionHost {
  sessionId: string;        // 父头 id
  sessionPath: string;      // 注册键；换会话 / dispose 时注销
  workspace: string;        // 跨工作区隔离用
  isBusy(): boolean;     // 父 AgentSession 非 idle
  isDraining(): boolean; // WorkspaceHandle 已 dispose / 正在换会话
  sendNotice(payload: SettlementNotice): void;
}
```

换会话或 dispose 时注销。notice 找不到 host（或 workspace 不匹配）就记警告，不抛给子级。

---

## 6. 生命周期

### 6.1 启动（`action: "spawn"` + embedded）

1. `canUseEmbeddedSubagent(profile)` 为假 → 子进程路径（§8）。
2. `SubAgentRegistry.genId()` → `sa-…`；registry 行 `running`。
3. `createEmbeddedChildSession`：`SessionManager.create(cwd, undefined, { id, parentSession: 父 JSONL 路径 })`（`SessionHeader` 只有 `parentSession` 一个字段，放不下 id）。`parentSessionId` = `ctx.sessionManager.getSessionId()`（父头 `id`，`index.ts` 里 `sessionSpawnKey` 就是这么取的），**只**写进 `subagent_meta`，连同 `mode: "continuable"`。
4. 工具过滤与规格 1 相同（强制去掉 `spawn_agent` / `explore_context`）；**子会话要能看到 `send_message`**。
5. 初始任务末尾追加返回指引（§7.2）。
6. 安装 Activation，inbox 接受初始任务（`followUp`），`announced = true`。
7. **此时**才允许规格 3 追加父目录事实。准入失败则拆除、不写目录、工具调用报错。
8. 工具立刻返回：`Background sub-agent started. agentId: …`，`details: { agentId, sessionPath, mode: "continuable", status: "running" }`。
9. 结算监视在后台跑；`wait` / `status` / `cancel` 继续读 registry。

`promptGuidelines` 补一句：后台 spawn 结算后会收到 notice；不必为了拿结论再 `wait`，`wait` 仅在必须卡住当前轮次时用。

### 6.2 Inbox

```ts
type Delivery = "followUp" | "steer";

class SubagentInbox {
  deliver(text: string, delivery: Delivery): void;
  get closing(): Promise<void> | undefined;
  get hasPending(): boolean; // 未消费的 followUp / steer 队列
  close(release: () => Promise<void>): Promise<void>;
}
```

关闭中投递抛 `ACTIVATION_CLOSING`，消息未接受。`hasPending` 直接用 `AgentSession` 现成的同步读口：

```ts
session.pendingMessageCount;   // steering + followUp 未消费总条数
session.getSteeringMessages(); // readonly string[]
session.getFollowUpMessages(); // readonly string[]
```

**不要**去解析 `queue_update` 事件——SDK 里没有这个稳定事件名，照着写必然变成推测性代码。

投递规则（对齐 DSH 模型消息，不给模型暴露 delivery 参数）：

- 目标正在跑 → `steer`
- 目标 idle 且 Activation 在 → `followUp`（开新轮）
- 目标无 Activation 且 `mode === "continuable"` → 冷恢复后再 `followUp`
- 目标 `mode === "one-shot"` 或 JSONL 不存在 → 失败，消息未送达

调用约定（SDK 已明确）：`session.prompt(text, { streamingBehavior })` 在**流式期间必须**给 `streamingBehavior`，否则抛 `Error`；idle 时省略该参数即开新轮。判断「是否在流式」用 `session.isStreaming`（`getState()` 已在用），不要自己记账。

人类路径（规格 3 编辑器）可以显式选 `followUp` / `steer`；本期工具不暴露该参数。

### 6.3 结算

监视循环：

1. `await session.waitForIdle()`
2. 在 `ChildLock` 里看：inbox 已关闭 → 退出；`hasPending` 或 `ownedChildren.size > 0` → 继续等；否则准备结算
3. 再读一遍队列与 session 是否又被 poke；有变化则重来
4. `extractAssistantOutput(session.messages)`（规格 1 规则；规格 4 落地后从 `inheritedEventCount` 之后截）
5. `runMaintenance` 等价：同一轮里关闭 inbox，再 `dispose` handle，**保留 JSONL**
6. registry `finish`：`done` / `cancelled` / `error`
7. 若 `announced`，`notifySettlement`

`stopReason` 继续用规格 1 的 `completed | aborted | error`。DSH 还有 `max-tokens` / `refusal`；本期并进 `error`，notice 用 `failed before it finished`。不要为这两个值改 `assistant-output.ts`。

自然结算后的子级是冷的，不是销毁。再 `send_message` 会开新的 Activation 纪元，纪元结束再发一条 notice。

### 6.4 拆除与重启

| 动作 | inbox | JSONL | notice | 之后 send_message |
|------|-------|-------|--------|-------------------|
| 自然结算 | 关 | 留 | 有（已宣布） | 冷恢复 |
| `interrupt_agent` | 开 | 留 | 无 | 可以，队列仍在 |
| `spawn_agent` `cancel` / 父 host drain | 关 | 留 | `aborted`（已宣布） | 拒绝（meta 标 `tornDown`） |
| 未宣布就失败 | 关 | 可删 | 无 | 不适用 |
| sidecar 重启时 registry 仍 `running` | — | 留 | **无** | 可冷恢复 |

**冷恢复不是「open 完就有 session」。** 完整链路：`SessionManager.open(childPath)` → `createAgentSessionServices(...)`（重建资源加载器 / 扩展 / 模型运行时）→ `createAgentSessionFromServices({ services, sessionManager, ... })` → `bindExtensions`（与规格 1 同参）→ `prompt(text)`。services 构造成本与新建子会话同级，实现里必须显式写全这四步；子会话多时可考虑按 `cwd` 缓存一份 services，但缓存与「父切换了模型 / 配置」的失效关系要先定清楚，本期先不缓存。

重启：`session_start` 里现有 reap 不得把可续聊行打成「已取消并通知父模型」。改成：JSONL 在且 `subagent_meta.mode === "continuable"` → registry 标 `done`，`output` 空或「sidecar restarted」，不 `sendNotice`。one-shot / 子进程孤行仍按现在 reap。

`cancel` 在 `subagent_meta` 加 `tornDown: true`（再写一条 custom，不改 mode）。冷恢复见到它就失败。

父 `WorkspaceHandle.dispose` / 换会话：`drainDescendants`，已宣布的发 `aborted` notice；正在换走的父 host `isDraining()` 为真则只写入 `custom_message`、不 `triggerTurn`。

---

## 7. 相邻工具

### 7.1 `send_message`

父会话与可续聊子会话都注册，schema 相同，避免子级多一套工具定义（对齐 DSH）。

```
agent_id: string
message: string
```

权限：

- 调用方必须是当前 `exec` 所在的那份在线 `AgentSession`。`senderId` = `ctx.sessionManager.getSessionId()`；子级找父级读自己 JSONL 里的 `subagent_meta.parentSessionId`
- 每个在线 Agent 都可以对**直接**可续聊子级投递
- 只有**驻留**可续聊子级可以对**直接**父级投递；父级必须仍有 parent host
- 同级、隔代、自己 → `UNAUTHORIZED`，消息未送达
- 只有父→子支持冷恢复；子→父不恢复父会话

回执成功：`message delivered to agent <agent_id>`，`details.messageId` 为本次 `prompt` 的用户消息 id（没有稳定 id 就用 JSONL 最后一条 user entry 的 `id`）。失败文本必须写明未送达，不能假装成功。

投递正文（模型可见，对齐 DSH）：

```
Agent <senderId> sent a message: <message>
```

不要把这条包装成 `subagent-settled`。那是运行时结算，不是 Agent 自己写的话。

### 7.2 返回指引

可续聊子级的**第一条**用户任务末尾追加（one-shot 不加）：

```
Your parent agent id is "<parentSessionId>". Before you finish, send your result to that agent with send_message({ agent_id: "<parentSessionId>", message: "<self-contained result>" }). The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. Send earlier messages as well when a finding changes what the parent should do next; sending a message does not end your turn.
```

`parentSessionId` 用 JSON 转义后的父头 id。

### 7.3 `interrupt_agent`

```
agent_id: string
```

- 调用方必须是目标的在线祖先（本期即直接父级）或用户取消路径
- 自己、同级、非祖先 → 出错
- 目标不在驻留表（已结算 / 从未启动）→ 接受并当空操作：`interrupt requested for agent <id>`
- 命中驻留 → `session.abort()`，inbox 不关，后代不拆（本期无后代）
- 不等待完全停稳

不把 `interrupt_agent` 做成 `spawn_agent` 的新 action，以免和 `cancel` 混名。

### 7.4 不新增 `list_agents`

`spawn_agent({ action: "list" })` 保留。谱系目录是规格 3。模型用 `agentId` 投递，不靠列表工具。

---

## 8. Settle notice

### 8.1 句式（与 DSH 逐句对齐）

摘要第一行按 `stopReason`：

| stopReason | 第一行 |
|------------|--------|
| `completed` | `Background subagent <id> finished and will do no further work unless you send it more.` |
| `aborted` | `Background subagent <id> was stopped before it finished.` |
| `error` | `Background subagent <id> failed before it finished.` |

第二段：有正文则 `Its closing message:` + 规格 1 抽出的助手正文；否则 `It left no closing message.`

`<id>` 是 `sa-…`。

### 8.2 投递

`settlement-notice.ts` 只拼 payload。真正发送走 parent host：

```
pi.sendMessage(
  {
    customType: "subagent-settled",
    content: 全文,
    display: true,
    details: { childId, stopReason, sessionPath },
  },
  host.isDraining()
    ? { triggerTurn: false }
    : host.isBusy()
      ? { triggerTurn: false, deliverAs: "steer" }
      : { triggerTurn: true, deliverAs: "followUp" },
);
```

一条消息同时进模型上下文、进 JSONL、唤醒或插入当前轮。禁止再 `sendUserMessage` 同一段，以免双份。

已核实：`pi.sendMessage` 存在，签名 `{ triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }`，**同步返回 `void`**（不 await、不抛投递失败）。所以 §8.2 里那句「`sendMessage` 若不认 `deliverAs`」只在单测证明投递确实没发生时才走；两条通道必须二选一，不允许同时开着。

`sendMessage` 若不认 `deliverAs`：busy 时改用已注册的 `WorkspaceHandle.prompt(全文, { streamingBehavior: "steer" }, "main")`，且不再写第二条 `custom_message`。实现时只保留一条通道，单测锁「父消息列表里只有一条 settled」。

### 8.3 Electron 渲染

在 `src/features/chat/ChatMessageItems.tsx` 的 `case 'notice'` 分发里加分支（现已有 `agent-answer` / `agent-plan` / `agent-questions` / `visual-inline` 同款写法）：`msg.customType === "subagent-settled"` 走专用 pill，标题用第一行摘要，展开看 closing message。不要落到兜底的通用 `NoticePill`（会显示成「已注入上下文」）。

主 store 继续忽略 `source === "subagent"` 的子会话事件（规格 1）。notice 是父会话自己的 `custom_message`，必须进主对话。

### 8.4 子进程回退

`action: "spawn"` 走 `spawnPiAgent` 时：进程退出后，若 parent host 还在，发同样句式的 notice。`details.sessionPath` 可缺。这条路径没有 `send_message`、没有冷恢复。`wait` 行为不变。

（第八期起子进程后台 notice 由 `job-done` 承担）

---

## 9. 错误

| 码 | 何时 | 调用方看到 |
|----|------|------------|
| `UNAUTHORIZED` | 非相邻 / 父不匹配 | 消息未送达 |
| `NOT_RESUMABLE` | one-shot、已 `tornDown`、无 JSONL | 消息未送达 |
| `PARENT_UNAVAILABLE` | 子→父时 host 不在 | 消息未送达 |
| `ACTIVATION_CLOSING` | 结算拆除中 | 消息未送达 |
| `DUPLICATE_CHILD` | `sa-…` 已驻留 | 启动失败 |
| `DRAINING` | 父工作区在拆 | 启动 / 投递失败 |

工具层把这些收成 `isError: true` 的短文本，不抛到让父轮次崩掉。

---

## 10. 明确不做

- 嵌套 `spawn_agent`、`ownedChildren` 非空图（接口留空集）
- 跨进程 Activation / 持久父邮箱
- ACP / Codex / 远程后端
- 把 `action: "run"` 改成默认后台
- 改工具名为 `subagent`
- 人类 Queue/Steer 切换（规格 3）
- 页头目录、fork 种子
- Tauri 详情改绑 Activation
- DSH 的 `max-tokens` / `refusal` 独立枚举
- `list_agents` 新工具

---

## 11. 测试

**inbox / activation**

- 关闭中 `deliver` 抛错且不调用 `prompt`
- 同一 `childId` 的两次投递串行
- idle + 空 inbox → 进入结算；结算前再投递 → 取消本次结算
- 未宣布拆除 → 不 `sendNotice`
- 已宣布 + `completed` → notice 句式与 `details.childId` 正确
- `cancel` 后 `tornDown`，冷恢复拒绝
- sidecar reap：continuable + JSONL 在 → `done` 且不 notice；子进程孤儿仍按旧 reap
- `hasPending` 用 `pendingMessageCount`：`steer` 入队后 > 0、被消费后归 0
- A 工作区的子级向 B 工作区的父 host 投递 → `PARENT_UNAVAILABLE`（同进程多工作区时不许串台）

**adjacent-tools**

- 父→直接子成功；父→无关 id 失败
- 驻留子→父成功；子 dispose 后→父失败
- 同级失败
- 冷恢复：JSONL 在、无 Activation，父 `send_message` 会再建 Session 并 `prompt`
- one-shot 子拒绝 `send_message`
- `interrupt` 不存在的 id 仍成功空操作
- 返回指引只出现在 continuable 首条任务

**notice**

- `completed` / `aborted` / `error` 三句
- 无正文 → `It left no closing message.`
- busy 父：不 `triggerTurn`，走 steer
- idle 父：`triggerTurn: true`
- draining：写入但不唤醒
- 父消息里只有一条 settled，没有配套 user 气泡
- Electron：`subagent-settled` 不用「已注入上下文」当标题

**路由**

- embedded `spawn` 不在首次 idle 后 dispose
- embedded `run` 仍 dispose、无 notice
- 子进程 `spawn` 退出后有 notice、无 `send_message`

不在本期做浏览器端到端真人续聊（规格 3）。

---

## 12. 附录：本次复核已确认的现状（2026-09-13）

写实现前不必再查，以下都是读代码 / 读 `.d.ts` 得出的结论：

| 项 | 结论 |
|----|------|
| `pi.sendMessage` | 存在，`{ triggerTurn?, deliverAs?: steer\|followUp\|nextTurn }`，同步 `void` |
| `pi.appendEntry` | 存在（`appendCustomEntry` 只存在于 `SessionManager`，扩展侧没有） |
| `session.prompt` | `PromptOptions` 含 `streamingBehavior: "steer" \| "followUp"`；流式期间不给会抛错 |
| 队列读口 | `pendingMessageCount` / `getSteeringMessages()` / `getFollowUpMessages()` / `clearQueue()` |
| 父会话取 id / 路径 | 工具 `ctx.sessionManager.getSessionId()` / `getSessionFile()`（`index.ts` 已有 `parentSessionPath` / `sessionSpawnKey` 两个现成取法） |
| `WorkspaceHandle.prompt` | `(text, { images?, streamingBehavior? }, origin)`，**只收 `'main' \| 'goal'`**，notice 兜底只能传 `"main"` |
| 现有后台 spawn | `index.ts:492-568`，`registry.create` + `executeSubagent(...)` 分离执行 + `inflight`；改造点就在这一段 |
| 现有 reap | `session_start` → `getRegistry(cwd)`，子进程用 `PI_IS_SUBAGENT=1` 跳过；**embedded 子级不设这个 env** |
| 子进程才设 `PI_IS_SUBAGENT` | `runner.ts:286`；embedded 子级的身份在 ALS `origin === "subagent"`（`resolveToolOrigin()`） |
| Electron 主列 | `MainChatColumn` 是 `src/App.tsx` 里的本地组件（非独立文件），外层容器已 `position: relative` |
| 子事件通道 | `extensions/multi-agent/embedded-events.ts` + `WorkspaceHandle.start()` 注册 sink，事件带 `source: 'subagent'`；渲染层 `src/stores/agent.ts:179` 已过滤 |
