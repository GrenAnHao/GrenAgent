# Pi Codex 风格桌面 Agent 完整设计

## 目标与范围

GrenAgent 的目标是构建类 Codex 的 Electron 桌面 Agent。Electron 是唯一的桌面宿主和控制面；Pi 保留为模型回合与工具执行内核。系统不设计成可脱离 Electron 独立运行的产品。

本设计一次性覆盖以下模块，并按依赖关系分阶段实现：

1. Codex 风格 Thread / Turn / Item 数据模型。
2. 统一事件协议和事件回放。
3. Electron 控制面与项目 Pi 执行面的边界。
4. 通用系统级 Pi Worker，以及作为首个调用方的全局记忆服务。
5. 中心化 MCP 配置治理与每项目 Pi 的 MCP Client。
6. 细粒度 Permission Profile。
7. OS 级 Sandbox Manager。
8. 插件 manifest、生命周期和故障隔离。
9. 非交互执行、ServiceTask 与本地任务队列。
10. `agent`、`goal`、`mcp`、`web-search` 的接入方式。

明确不纳入本设计：Codex Cloud、远程容器、多租户云服务、账号/订阅/计费、远程 GitHub 任务编排，以及恢复 Tauri 为主线。

## 核心边界

```text
Electron 主进程 = Control Plane
  状态、策略、调度、持久化、桌面生命周期

Pi(project) = Project Agent Worker
  当前项目的模型回合、session、工具执行、项目 MCP 连接

Pi(system) = System Agent Worker
  Electron 按需启动的受限系统任务执行器，不属于任何项目会话
```

Electron 永远是上层协调者。项目 Pi 不直接管理全局数据库、跨项目记忆、MCP 中心配置、桌面队列或 UI 状态。

## 现有实现基线

- `electron-agent/src/lib/pi.ts` 定义当前 `AgentEvent` 和前端 Pi API。
- `electron-agent/electron/pi/client.ts` 负责 sidecar JSONL 请求、响应和事件接收。
- `electron-agent/electron/pi/manager.ts` 按 workspace 管理项目 Pi 进程。
- `electron-agent/electron/app/piRuntimeService.ts` 将 Electron 命令映射为 Pi RPC。
- `electron-agent/src/stores/agentReducer.ts` 将原始 Pi 事件折叠为聊天状态。
- `electron-agent/electron/agentData/` 提供本地 JSONL RPC、SQLite、MemoryStore、WikiStore 和 JobStore。
- `extensions/index.ts` 静态汇总内置扩展；`extensions/goal`、`extensions/mcp`、`extensions/web-search` 已存在。
- `extensions/safety`、`extensions/approval`、`extensions/mcp-policy` 已分别处理工具拦截、审批策略和 MCP 审计。
- `extensions/multi-agent` 已有子代理 registry 和非交互子进程执行能力。

## 总体架构

```text
Electron Renderer
        │ window.gren / IPC
        ▼
Electron App Server（主进程）
  ├── ThreadStore / TurnStore / ItemStore
  ├── EventBus + EventReplay
  ├── PermissionManager
  ├── SandboxManager
  ├── PluginManager
  ├── TaskQueue + TurnRunner
  ├── MemoryService + MCP Center
  └── Pi Worker Manager
          ├── Pi(project-A)
          ├── Pi(project-B)
          └── Pi(system, 按需启动)
```

### Electron 控制面

Electron 主进程负责：

- 项目、Thread、Turn、Item 的索引和持久化。
- 所有客户端可消费的统一事件及回放。
- 全局记忆数据库、scope 过滤和记忆任务调度。
- MCP server 配置、凭据引用、启停、工具缓存、权限策略和审计。
- Permission Profile 解析、用户审批和非交互策略。
- Shell、PTY、Pi 子进程和系统 Worker 的生命周期。
- Plugin manifest、启停状态、配置和故障记录。
- 交互 Turn 与后台 ServiceTask 的队列调度。
- Provider 配置、模型目录、桌面通知和窗口 IPC。

Electron 不直接运行项目模型回合，也不代理每一次 MCP 工具调用。

### Pi(project) 项目执行面

一个 workspace 对应一个项目 Pi 进程；一个项目 Pi 可服务该 workspace 下的多个 Thread，但同一时刻只执行一个 active Turn。它负责：

- Pi session 文件、上下文树和上下文压缩。
- 当前项目的 Agent turn、流式文本、思考、工具调用和工具结果。
- `agent`、`goal`、项目 Skill、项目规则和项目级配置。
- 根据 Electron 下发的有效 MCP 配置建立本项目独立的 MCP Client。
- 执行项目工具，并将原始事件通过 RPC 回传。
- 通过受控 RPC 请求 Electron 的记忆搜索、记忆捕获和权限决策。

项目 Pi 不直接打开 Agent Data SQLite，也不读取其他项目的 session 文件。

### Pi(system) 通用系统 Agent Worker

系统 Worker 是 Electron 共享的通用 LLM 执行能力，由 Electron 按需启动、执行完任务后空闲退出。记忆处理是首个调用方，不是 Worker 的专属用途：

- 不绑定 workspace、Thread 或项目 session。
- 每个 ServiceTask 使用独立临时上下文，任务结束后不保留为项目聊天历史。
- 默认只具有受控的 LLM completion 和结构化 JSON 输出能力，不自动加载项目 MCP、web-search、Shell、DAP、LSP、写文件和子代理能力。
- 通过独立 RPC 接收已注册的系统任务，例如记忆抽取/去重/摘要、Thread 标题生成、内容分类和上下文摘要。
- 每种任务由 Electron 的 ServiceTask Registry 绑定输入/输出 schema、超时、重试策略和能力白名单；任务 payload 不能自行申请额外能力。
- 某类系统任务若需要工具，必须在任务定义中显式声明，并由 PermissionManager 和 SandboxManager 执行；不能继承任一项目 Pi 的工具或权限。
- 结果回传 Electron，由对应的系统服务校验并决定是否持久化或发布事件。

生命周期：

```text
无任务 → Electron 启动 system Pi → 执行任务队列
       → 队列为空并达到 idleTimeout → Electron 关闭 system Pi
```

Worker 崩溃时当前任务回到 `queued` 并增加尝试次数；连续失败达到策略上限后进入 `failed`，不影响项目 Pi 对话。

## Thread / Turn / Item 模型

```ts
type ThreadStatus = "active" | "archived" | "deleted";
type TurnStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
type ItemStatus = "started" | "streaming" | "completed" | "failed";

interface Thread {
  id: string;
  projectId: string;
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
  permissionProfile: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
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

Thread/Turn/Item 是 Electron App Server 的规范模型。Pi session 文件继续作为 Pi 的上下文存储，由 adapter 映射，不改变现有 session 格式。

## 统一事件协议

```ts
interface AppEvent {
  id: string;
  type:
    | "thread.created" | "thread.updated"
    | "turn.queued" | "turn.started" | "turn.completed" | "turn.failed" | "turn.cancelled"
    | "item.created" | "item.updated" | "item.delta"
    | "permission.requested" | "permission.resolved"
    | "task.queued" | "task.started" | "task.completed" | "task.failed"
    | "plugin.state_changed" | "mcp.state_changed" | "memory.updated";
  sequence: number;
  timestamp: number;
  projectId?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  data: unknown;
}
```

EventBus 规则：

- 每个 App Server 实例维护单调递增 sequence。
- 发布顺序是所有订阅者看到的顺序；订阅者异常不得阻塞其他订阅者。
- 内存环形缓冲区支持 `afterSequence` 回放。
- 回放起点早于缓冲区最早 sequence 时返回 `gap`，调用方重新读取权威状态。
- 交互 UI、插件、任务队列、MCP 和记忆服务均使用同一事件出口。
- 事件不携带大体积 transcript；大内容通过 Item/查询接口读取。

Pi 事件映射：

| Pi 事件 | App Event | 说明 |
|---|---|---|
| `agent_start` | `turn.started` | 关联当前项目 Thread/Turn |
| `message_start` | `item.created` | 建立 assistant/reasoning Item |
| `message_update` | `item.delta` | 转发 text/thinking 增量 |
| `message_end` | `item.updated` | 完成 assistant Item |
| `tool_execution_start` | `item.created` | 建立 tool_call Item |
| `tool_execution_update` | `item.delta` | 转发工具进度/部分结果 |
| `tool_execution_end` | `item.updated` | 完成或失败 tool_result Item |
| `agent_end` | `turn.completed` / `turn.failed` | 结束当前 Turn |
| `extension_error` | `turn.failed` | 携带扩展错误 |
| `queue_update` | `task.*` 或旧事件 | 保留旧 UI 兼容，不强行伪造 Item |

原始 `pi://event` 保持不变。App Event 先旁路发布，待前端完成双读和回放验证后，再切换 UI 主消费路径。

## 记忆架构

记忆是 Electron 管理的半独立系统，不归属任何项目 Pi。数据库统一存储，记录 scope、来源项目和来源 session。

```ts
type MemoryScope =
  | { kind: "global" }
  | { kind: "project"; projectId: string }
  | { kind: "session"; projectId: string; sessionId: string };
```

读取策略：

```text
默认：当前项目记忆 + global 记忆
显式开启跨项目：当前项目 + global + 其他项目记忆
```

跨项目读取必须是项目/会话级策略，可审计、可关闭；搜索结果返回来源 projectId 和 scope。

写入流程：

```text
项目 Pi agent_end
  ↓ memory.capture RPC
Electron MemoryService 写入 pending capture
  ↓ ServiceTaskQueue.enqueue(memory_extract)
按需启动 Pi(system)
  ↓ 结构化提炼/分层/去重
Electron 校验结果、应用 scope、写入 SQLite
  ↓ memory.updated
```

查询流程：

```text
项目 Pi before_agent_start
  ↓ memory.search RPC
Electron 按 scope policy 检索统一数据库
  ↓
返回上下文片段，项目 Pi 注入当前回合
```

在记忆场景中，系统 Worker 只负责受控的 LLM 计算；Electron 负责数据真实性、权限、去重、审计和最终写入。记忆提炼不进入任何项目聊天历史。

## MCP 中心与项目 Client

MCP 采用“中心治理、项目连接”的边界：

```text
Electron MCP Center
  ├── 全局/项目配置合并
  ├── 凭据引用与安全存储
  ├── server 启停和健康状态
  ├── 工具缓存和能力快照
  ├── 权限策略与审计
  └── 向项目 Pi 下发有效配置

Pi(project)
  └── 为当前项目建立独立 MCP Client 连接并执行工具
```

Electron 不代理每次工具调用。Pi 负责 MCP 协议、连接和实际调用；Electron 负责配置、策略和审计事件。

项目启动流程：

1. Electron 根据全局配置、项目配置和启用状态计算有效 server 集合。
2. Pi 启动时接收脱敏配置或安全凭据引用。
3. Pi 建立本项目独立连接，工具名保持 `mcp__server__tool`。
4. 工具调用通过统一 PermissionManager 检查，并回传 Tool Item/Event。
5. Electron 面板订阅 `mcp.state_changed`，显示连接和工具状态。

## Permission Profile

权限拆分为资源范围和交互策略：

```ts
interface PermissionProfile {
  filesystem: "none" | "workspace-read" | "workspace-write" | "unrestricted";
  network: "none" | "allowlist" | "full";
  process: "none" | "allowlist" | "full";
  secrets: "none" | "selected" | "all";
  interaction: "deny" | "ask" | "auto";
}
```

预置 profile：

| Profile | 用途 |
|---|---|
| `readonly` | 代码分析和审查 |
| `workspace` | 普通项目开发 |
| `interactive` | 用户确认后的完整开发 |
| `automation` | 非交互任务 |
| `unrestricted` | 用户明确授权的本地操作 |

所有项目 Pi、system Pi、Shell、PTY、MCP 和后台任务都必须绑定有效 profile。决策流程：

```text
Operation → PermissionManager.evaluate()
  → allow / deny / ask
  → permission.requested
  → 用户或非交互策略处理
  → permission.resolved
```

现有 `approval`、`safety`、`mcp-policy` 和 workspace trust 将逐步适配为 PermissionManager 的策略提供者，避免新增平行规则。

## OS 级 Sandbox Manager

```ts
interface SandboxManager {
  capabilities(): Promise<SandboxCapabilities>;
  run(input: SandboxRunInput): Promise<ProcessResult>;
  stop(id: string): Promise<void>;
}
```

Sandbox Manager 统一覆盖：

- Pi project/system 子进程。
- TerminalService 的短命命令。
- ShellService 的 PTY。
- 子代理进程。

策略层先统一 cwd、可读/可写路径、环境变量和网络模式；平台层分别实现 Windows restricted token/Job Object 或 AppContainer、macOS Seatbelt、Linux Landlock/bubblewrap。平台能力不足时必须产生降级事件并遵守应用层 deny/ask，不能静默升级为 unrestricted。

## 插件生命周期

现有静态 `allExtensions` 保留兼容；新增 manifest 和状态层：

```text
discovered → validated → loaded → started → ready
                                      ↓
                              stopping → stopped
```

异常状态：`validation_failed`、`start_failed`、`crashed`、`disabled`。

```ts
interface PluginManifest {
  id: string;
  version: string;
  apiVersion: string;
  capabilities: Array<"agent" | "tool" | "mcp" | "provider" | "ui" | "event-subscriber">;
  permissions?: Partial<PermissionProfile>;
}
```

PluginManager 在 Electron 侧管理发现、校验、配置、启停、状态事件和故障记录；Pi 侧只加载被允许的扩展。插件在发现、校验和启动阶段的失败必须被隔离，不能拖垮 App Server 或其他项目 Pi。运行期插件若导致 Pi 进程致命退出，则由项目 Pi 进程边界隔离，PluginManager 记录该插件关联的故障并按策略重启项目 Pi；本设计不引入每个插件独立进程。

## Turn 与 ServiceTask 队列

用户对话和系统任务共用调度基础，但数据类型分开。ServiceTask 类型通过 Electron 注册表扩展，不在队列内硬编码为记忆专用：

```ts
type BuiltinServiceTaskKind =
  | "memory_extract"
  | "memory_deduplicate"
  | "memory_summarize"
  | "thread_title_generate"
  | "content_classify"
  | "context_summarize";

interface ServiceTaskDefinition {
  kind: string;
  inputSchema: unknown;
  outputSchema: unknown;
  capabilities: Array<"llm_completion" | "llm_embedding" | "network" | "filesystem_read">;
  timeoutMs: number;
  maxAttempts: number;
}

interface ServiceTask {
  id: string;
  kind: string;
  sourceProjectId?: string;
  sourceSessionId?: string;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  input: unknown;
  output?: unknown;
  attempts: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
```

规则：

- 交互 Turn 和 ServiceTask 都由 Electron TaskQueue 调度。
- TaskQueue 只接受 ServiceTask Registry 中已启用的 kind；入队和出队结果都按对应 schema 校验。
- 同一 Thread 同时只允许一个 active Turn；同一 system Pi 同时只执行一个 ServiceTask；不同项目的项目 Pi 可以并行运行。
- TaskQueue 对 system Pi 采用串行调度；项目 Pi 的并发由各 Thread/项目进程约束，是否限制跨项目并发由 Electron 的资源策略决定，不改变 Thread 语义。
- 交互 Turn 绑定项目 Pi；ServiceTask 绑定 system Pi。
- 非交互 Turn 遇到 `ask` 时变为 `blocked`，不弹出无法处理的 UI。
- Electron 退出时，运行中的本地任务恢复为 `queued`；明确取消的任务保持 `cancelled`。
- 支持排队、启动、取消、失败、重试、完成事件；不实现云端优先级和分布式调度。

## agent / goal / mcp / web-search 边界

```text
agent
  项目 Pi 的回合执行、工具编排和流式事件

goal
  项目目标状态、完成判定；通过 Electron TurnRunner 驱动后续 Turn

mcp
  Pi 内执行 Client；Electron 中心治理配置、权限、状态和审计

web-search
  普通项目工具插件；遵守 Permission Profile 和网络策略

memory
  Electron 数据服务；需要 LLM 时调用通用 system Pi Worker，不进入项目 session

system services
  标题、摘要、分类、索引整理等非项目会话能力，通过 ServiceTask Registry 调用 system Pi Worker
```

## 本地 App Server 接口

第一批内部接口统一命名，Renderer 通过 Electron IPC 调用：

```text
thread/create
thread/list
thread/read
turn/start
turn/cancel
item/list
task/enqueue
task/list
task/cancel
permission/resolve
event/replay
memory/search
memory/capture
mcp/config/list
mcp/status/list
mcp/tool-policy/read
```

现有 `agent_prompt`、`agent_abort`、`pi://event`、`pi://ui-request` 保留兼容；新接口先做 adapter，不能让一次迁移同时改变 UI、Pi RPC 和持久化格式。

## 持久化设计

Agent Data SQLite 增加以下逻辑表：

- `threads`：项目与 Thread 元数据。
- `turns`：Turn 状态、模式、权限 profile 和错误。
- `items`：Item 权威快照及 JSON payload。
- `app_events`：持久化非增量生命周期事件和审计事件；高频 `item.delta` 只进入内存环形缓冲区，不写入该表。进程重启后通过 Thread/Turn/Item 权威快照恢复状态，事件表仅用于短期诊断和审计。
- `service_tasks`：系统任务队列和重试状态。
- `plugin_state`：插件版本、状态和错误。
- 现有 memory、MCP policy、job、audit 表继续复用并通过外键或 source 字段关联。

Pi session 文件仍由 Pi 管理；Thread/Turn/Item 数据库是 Electron 的产品索引，不取代 Pi 上下文存储。

## 分阶段实施顺序

### 阶段 1：协议与事件基础

- 新增模型类型、EventBus、replay 和 Pi event adapter。
- 保持原始 Pi 事件和 AgentStore reducer 不变。
- 通过测试确认 Thread/Turn/Item 关联、sequence、gap 和未知事件处理。

### 阶段 2：Thread/Turn/Item 持久化与 App Server adapter

- 在 Agent Data SQLite 增加表和 repository。
- 为现有 `open_workspace`、`agent_prompt`、`agent_abort` 建立 adapter。
- Electron UI 双读新旧状态，验证重启、切换项目和旧 session 兼容。

### 阶段 3：ServiceTask Registry、system Pi Worker 与记忆控制面

- 建立通用 ServiceTask Definition/Registry、schema 校验和能力白名单。
- 将 memory capture/search 统一收口到 Electron MemoryService。
- 增加 ServiceTask 队列和 system Pi 按需启动/空闲退出。
- 验证跨项目策略默认关闭、显式开启可审计、Worker 故障不影响项目对话。

### 阶段 4：MCP Center 与 Permission Profile

- 将 MCP 配置、状态、工具缓存和策略集中到 Electron。
- 项目 Pi 只接收有效配置并建立独立 Client。
- 将 approval/safety/mcp-policy 适配到统一权限决策。

### 阶段 5：Sandbox Manager

- 先统一所有进程入口的策略输入和审计事件。
- 按平台接入 OS 沙箱；增加路径、进程、网络和降级测试。

### 阶段 6：PluginManager 与任务队列完善

- 为扩展增加 manifest、状态机、启停和崩溃隔离。
- 将 `goal`、非交互 Agent Turn、记忆任务纳入统一 TaskQueue。
- 统一任务恢复、取消、重试和状态事件。

### 阶段 7：前端协议切换

- 新 UI 订阅 App Event 并按 Item 重建状态。
- 保留旧 Pi 事件一段兼容期。
- 双读结果一致后移除不再使用的 UI 私有事件适配。

## 错误和恢复策略

- Pi RPC 断开：当前 Turn 标记 `failed`，项目 Pi 可由 PiManager 重启；不自动伪造完成。
- system Pi 崩溃：当前 ServiceTask 回到 `queued`，按 attempts/retry policy 处理。
- Event replay gap：调用方重新读取 Thread/Turn/Item 权威快照。
- Permission `ask` 无 UI：交互 Turn 进入 `blocked`，非交互 Turn 进入 `blocked` 并等待策略更新。
- Sandbox 不可用：发布降级事件，按 profile 继续 deny/ask；禁止自动放开。
- 插件加载失败：该插件进入错误状态，其他插件和项目继续运行。
- 数据库写入失败：不丢失正在执行的 Pi 回合；记录诊断并在下一次权威快照同步时重试。

## 测试与验收

### 协议与事件

- sequence 严格递增，多订阅者顺序一致。
- replay 能返回事件，越过环形缓冲区时返回 gap。
- Pi assistant/tool/agent_end 事件正确映射为 Item/Turn 事件。
- 未知 Pi 事件不破坏后续事件。

### 边界与数据

- 一个 workspace 只允许一个项目 Pi。
- 多项目记忆默认不可互读，显式策略开启后可检索并携带来源。
- 记忆提炼不写入项目聊天 session。
- system Pi 不继承项目工具、MCP、上下文或权限；只有任务定义声明的能力可用。
- MCP server 配置中心变更后，项目 Pi 可重新建立连接。

### 权限与沙箱

- `readonly` 禁止写文件和进程执行。
- `workspace` 只允许项目路径范围内的写入。
- `ask` 产生可恢复的 permission Item/Event。
- 无 OS 沙箱时有明确降级事件。
- Shell、PTY、Terminal、Pi 和子代理都经过统一策略入口。

### 任务和插件

- ServiceTask 按需启动 system Pi，空闲后退出。
- 非记忆 ServiceTask 可以复用同一 Worker，并按独立 schema 和能力白名单执行。
- Worker 崩溃可重试，项目 Pi 不受影响。
- 非交互 Turn 的权限阻塞、取消、恢复和失败状态正确。
- 插件状态转移、版本校验和崩溃隔离可测试。

### 回归

- 现有 `electron-agent/src/stores/agentReducer.test.ts`、`electron-agent/electron/pi/client.test.ts`、`manager.test.ts` 全部通过。
- 现有 goal、MCP、web-search、multi-agent 扩展测试全部通过。
- Electron 与 CLI TypeScript 类型检查通过。

## 最终验收标准

1. Electron 是唯一控制面，项目 Pi 和通用 system Pi 的职责边界清晰且可测试。
2. 项目对话、记忆任务、其他系统 LLM 任务、MCP 调用和后台任务都能映射到统一事件协议。
3. 记忆数据库统一管理，支持项目隔离和受策略控制的跨项目读取。
4. MCP 配置中心化，但每个项目 Pi 保持独立 Client 连接。
5. 权限、沙箱、插件和任务队列有统一生命周期和故障恢复路径。
6. 现有 Pi UI/RPC 行为在迁移期间保持兼容。
