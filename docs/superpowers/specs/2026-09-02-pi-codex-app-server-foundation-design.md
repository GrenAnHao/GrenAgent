# Pi Codex 风格 App Server 基础层设计

## 范围

本设计只覆盖 GrenAgent 当前 Electron 主线中的本地 Agent 基础层，用于吸收 Codex `codex-rs` 的协议与状态建模经验。首阶段不实现 Codex Cloud、远程执行、账号/计费，也不替换 Pi Runtime。

首阶段目标：

1. 引入最小的 Thread / Turn / Item 模型。
2. 将现有 Pi 事件适配为统一 App Event。
3. 保持现有 `pi://event`、`pi://ui-request` 和 Electron reducer 完全兼容。
4. 为后续权限 profile、OS 沙箱、插件生命周期和本地任务队列提供稳定边界。

## 现有上下文

- `electron-agent/src/lib/pi.ts` 定义当前 `AgentEvent` 联合类型及 Pi IPC 客户端 API。
- `electron-agent/electron/pi/client.ts` 负责 sidecar JSONL 响应与事件分发。
- `electron-agent/electron/pi/manager.ts` 按 workspace 管理 Pi 进程。
- `electron-agent/electron/app/piRuntimeService.ts` 将 Electron 命令映射为 Pi RPC。
- `electron-agent/src/stores/agentReducer.ts` 将 Pi 事件折叠为聊天状态。
- `electron-agent/electron/agentData/` 已提供独立的本地 JSONL RPC 和 SQLite 数据层，但本阶段不新增 Thread/Turn/Item 表。

## 设计方案

### 1. 协议模型

新增独立的本地协议模块，定义最小稳定模型：

```ts
type ThreadStatus = "active" | "archived" | "deleted";
type TurnStatus = "running" | "completed" | "failed" | "cancelled";
type ItemStatus = "started" | "streaming" | "completed" | "failed";

interface Thread {
  id: string;
  workspace: string;
  title?: string;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
}

interface Turn {
  id: string;
  threadId: string;
  status: TurnStatus;
  mode: "interactive" | "non-interactive";
  input: string;
  createdAt: number;
  completedAt?: number;
}

interface Item {
  id: string;
  threadId: string;
  turnId: string;
  type:
    | "user_message"
    | "assistant_message"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "permission_request"
    | "error";
  status: ItemStatus;
  payload: unknown;
  createdAt: number;
  updatedAt?: number;
}
```

首阶段模型只负责传递和关联，不负责改变 Pi session 文件格式。`threadId` 在没有现有持久化映射时可以由 workspace/session 派生；不能凭空创建会话数据。

### 2. 统一 App Event

新增 `AppEvent` 类型和内存事件总线：

```ts
interface AppEvent {
  id: string;
  type:
    | "thread.created"
    | "thread.updated"
    | "turn.started"
    | "turn.completed"
    | "turn.failed"
    | "item.created"
    | "item.updated"
    | "item.delta"
    | "permission.requested"
    | "permission.resolved";
  sequence: number;
  timestamp: number;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  data: unknown;
}
```

事件总线要求：

- 每个总线实例维护从 1 开始的单调递增 `sequence`。
- 订阅回调按发布顺序同步调用；单个订阅者异常不得阻断其他订阅者。
- 支持按 `afterSequence` 回放当前内存缓冲区。
- 缓冲区有固定上限，超出后丢弃最早事件并返回可识别的 replay gap。
- 本阶段不把事件写入 SQLite；重启恢复属于后续阶段。

### 3. Pi 事件适配

新增 adapter，将现有 `AgentEvent` 转换为 `AppEvent`：

| Pi 事件 | App Event | Item 行为 |
|---|---|---|
| `agent_start` | `turn.started` | 建立当前 turn 关联 |
| `message_start` | `item.created` | 创建 assistant/reasoning item |
| `message_update` | `item.delta` 或 `item.updated` | 转发文本/思考增量 |
| `message_end` | `item.updated` | 标记 assistant item 完成 |
| `tool_execution_start` | `item.created` | 创建 tool_call item |
| `tool_execution_update` | `item.delta` | 更新 tool_result 增量 |
| `tool_execution_end` | `item.updated` | 标记 tool_result 完成或失败 |
| `agent_end` | `turn.completed` 或 `turn.failed` | 结束当前 turn |
| `extension_error` | `turn.failed` | 携带扩展错误 |
| `queue_update` | 不转换 | 保持旧 UI 事件路径 |

适配器必须是纯函数/无副作用映射，workspace、threadId、turnId 由调用方上下文注入。无法可靠关联的旧事件不得伪造 ID，应保留原始事件数据并标记关联缺失。

### 4. 兼容策略

- `PiClientHandlers.onEvent` 的现有回调继续接收原始 `AgentEvent`。
- 新 App Server 层以旁路订阅方式消费同一事件，不修改 `AgentStore` reducer。
- 新协议事件不得替换 `pi://event`，直到前端完成独立消费与回放测试。
- `extension_ui_request` 仍走现有 `pi://ui-request`，不在本阶段改成 Item。
- 现有 `agent_prompt`、`agent_abort` 等 IPC 命令保持原签名。

### 5. 错误处理

- 输入事件缺少 `type` 时忽略并记录诊断，不抛出主进程异常。
- 事件适配失败时发布 `turn.failed`，`data` 包含原始事件和错误原因。
- 订阅者抛错只记录，不改变发布结果。
- replay 请求的 `afterSequence` 早于缓冲区起点时返回 gap 标记，由调用方重新读取权威状态。
- ID 生成统一使用 `randomUUID()`，禁止用数组下标作为协议 ID。

## 数据流

```text
Pi sidecar JSONL
    ↓
PiClient.handleLine()
    ↓ 原始 AgentEvent（旧路径保留）
Pi Event Adapter
    ↓
AppEventBus
    ├── Electron UI/未来 App Server 客户端
    ├── 诊断与审计
    └── 后续 Permission/Task/Plugin 层
```

## 测试要求

### 协议类型与事件总线

- 发布事件的 sequence 严格递增。
- 多订阅者按顺序收到同一事件。
- 一个订阅者抛错不影响其他订阅者。
- replay 能返回指定 sequence 之后的事件。
- 超出缓冲区范围时返回 replay gap。

### Pi 事件适配

- assistant 文本流能生成 created → delta → updated。
- tool call 能生成 started item，tool result 能生成 completed/failed item。
- `agent_end` 正常结束生成 `turn.completed`。
- 带错误的 `agent_end` 或 `extension_error` 生成 `turn.failed`。
- 未知事件保留原始数据，不影响后续事件。

### 回归验证

- 现有 `electron-agent/src/stores/agentReducer.test.ts` 全部通过。
- 现有 `electron-agent/electron/pi/client.test.ts`、`manager.test.ts` 全部通过。
- TypeScript 类型检查通过。

## 非目标

- 不实现 SQLite Thread/Turn/Item 持久化。
- 不实现权限 profile、OS 沙箱和插件生命周期。
- 不实现任务队列、并发调度和重试策略。
- 不迁移 Electron UI 到新事件协议。
- 不替换 Pi Runtime 或重写现有扩展。

## 验收标准

1. 新协议模块可以独立被 Electron 主进程和测试导入。
2. 现有 Pi 事件路径行为完全不变。
3. 新事件具备稳定 ID、关联字段和单调 sequence。
4. 适配器和事件总线有独立单元测试。
5. 后续可在不改 PiClient 与 AgentStore 的前提下接入权限、插件和任务队列。
