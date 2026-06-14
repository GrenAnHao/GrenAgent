# Pi Agent 功能模块分析

> 生成时间：2026-06-11  
> 来源：https://github.com/earendil-works/pi

## 1. 核心模块清单

### 1.1 Agent Core (`@earendil-works/pi-agent-core`)

**功能**：状态管理、事件流、工具执行的核心运行时

**核心类**：
- `Agent`: 主代理类，管理状态、事件订阅、工具调用
- `agentLoop` / `agentLoopContinue`: 低级事件循环

**数据模型**：
```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}

interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | "custom";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
```

**事件流**：
- `agent_start` / `agent_end`
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

**关键特性**：
- Steering（中断控制）：运行时注入用户消息
- Follow-up（后续任务）：任务完成后排队
- 工具执行模式：`parallel`（默认）或 `sequential`
- 钩子：`beforeToolCall` / `afterToolCall`

---

### 1.2 Coding Agent (`@earendil-works/pi-coding-agent`)

**功能**：面向开发者的交互式编码代理 CLI

**核心类**：
- `AgentSession`: 会话生命周期管理、持久化、分支、压缩
- `AgentSessionRuntime`: 运行时工厂，管理进程级资源
- `SessionManager`: 会话持久化到文件
- `SettingsManager`: 项目/用户级配置
- `ModelRegistry`: 模型注册和凭证管理
- `AuthStorage`: API Key 和 OAuth 凭证存储
- `ResourceLoader`: 扩展、技能、提示模板加载

**运行模式**：
1. **Interactive**: 终端 TUI，实时交互
2. **Print**: 一次性打印模式（适合脚本）
3. **RPC**: 基于 JSONL 的进程间通信（适合 IDE/GUI 集成）
4. **SDK**: 嵌入式编程接口

---

### 1.3 AI Provider (`@earendil-works/pi-ai`)

**功能**：统一多供应商 LLM API

**支持的供应商**：
- OpenAI、Anthropic、Google、Mistral、Cohere、Groq、AWS Bedrock、Azure OpenAI、xAI、OpenRouter、Perplexity、Deepseek 等

**核心接口**：
```typescript
interface Model<TProvider> {
  provider: string;
  id: string;
  contextWindow: number;
  reasoning: boolean;
}

async function* stream(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions
): AsyncGenerator<AssistantMessageEvent>
```

---

## 2. API 层设计

### 2.1 RPC 模式（主要 API）

**通信协议**：JSONL (JSON Lines) over stdin/stdout

**命令格式**（stdin）：
```typescript
type RpcCommand =
  // 提示
  | { id?: string; type: "prompt"; message: string; images?: ImageContent[] }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "abort" }
  
  // 状态查询
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_commands" }
  
  // 模型控制
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }
  
  // Thinking 级别
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  
  // 压缩
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  
  // Bash 执行
  | { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
  | { id?: string; type: "abort_bash" }
  
  // 会话管理
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "clone" }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "get_session_stats" }
```

**响应格式**（stdout）：
```typescript
type RpcResponse =
  | { id?: string; type: "response"; command: string; success: true; data?: any }
  | { id?: string; type: "response"; command: string; success: false; error: string }
```

**事件流**（stdout）：
所有 `AgentEvent` 作为 JSONL 实时推送：
- `agent_start` / `agent_end`
- `message_start` / `message_update` / `message_end`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`

**扩展 UI 请求**（stdout → stdin 响应）：
```typescript
type RpcExtensionUIRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; options: string[] }
  | { type: "extension_ui_request"; id: string; method: "confirm"; message: string }
  | { type: "extension_ui_request"; id: string; method: "input"; placeholder?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string }

type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true }
```

---

## 3. 数据模型

### 3.1 会话结构

**会话文件格式**（`.pi/sessions/<id>.jsonl`）：
```typescript
type SessionEntry =
  | { type: "message"; message: AgentMessage }
  | { type: "modelChange"; model: Model<any> }
  | { type: "thinkingLevelChange"; level: ThinkingLevel }
  | { type: "compaction"; summary: string; tokensBefore: number }
  | { type: "branchSummary"; summary: string; fromId: string }
  | { type: "sessionInfo"; name?: string }
  | { type: "custom"; customType: string; data: unknown }
```

**消息类型扩展**：
```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  timestamp: number;
}

interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}
```

---

### 3.2 工具系统

**内置工具**（7 个）：
1. `read`: 读取文件（支持偏移量、行限制）
2. `write`: 写入文件（覆盖模式）
3. `edit`: 编辑文件（精确字符串替换）
4. `bash`: 执行 shell 命令
5. `grep`: 内容搜索（ripgrep）
6. `find`: 文件查找（glob 模式）
7. `ls`: 目录列表

**工具定义**：
```typescript
interface ToolDefinition<TSchema, TDetails> {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  executionMode?: "parallel" | "sequential";
  execute: (
    toolCallId: string,
    params: Static<TSchema>,
    signal: AbortSignal,
    onUpdate?: AgentToolUpdateCallback
  ) => Promise<AgentToolResult<TDetails>>;
}

interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  terminate?: boolean;
}
```

---

### 3.3 扩展系统

**扩展工厂**：
```typescript
type ExtensionFactory = (ctx: ExtensionContext) => Extension | Promise<Extension>;

interface Extension {
  name: string;
  activate?: (runtime: ExtensionRuntime) => void | Promise<void>;
  onAgentStart?: (event: AgentStartEvent) => void | Promise<void>;
  onTurnStart?: (event: TurnStartEvent) => void | Promise<void>;
  onTurnEnd?: (event: TurnEndEvent) => void | Promise<void>;
  onToolCall?: (event: ToolCallEvent) => ToolCallEventResult | Promise<ToolCallEventResult>;
  onSessionStart?: (event: SessionStartEvent) => void | Promise<void>;
  onSessionShutdown?: (event: SessionShutdownEvent) => void | Promise<void>;
}
```

---

## 4. UI 层需要支持的功能

### P0（核心，必须实现）

1. **会话管理**：创建/切换/删除会话、会话列表、会话重命名
2. **消息流展示**：用户消息、助手消息（流式）、工具调用和结果、Thinking 内容、图片消息
3. **交互控制**：输入框、发送消息、中断执行、Steering
4. **模型选择**：模型列表、切换模型、Thinking 级别控制
5. **工具执行可视化**：工具名称和参数、执行状态、工具结果

### P1（重要，增强体验）

6. **Bash 执行**：显示命令和输出、支持中断、退出码显示
7. **上下文压缩**：手动触发压缩、自动压缩提示、压缩摘要展示
8. **分支和回溯**：Fork 会话、Clone 会话、分支摘要显示
9. **扩展 UI**：选择/确认/输入对话框、通知
10. **统计信息**：Token 使用量、消息数量、会话时长

### P2（扩展功能）

11. **导出功能**：导出 HTML/Markdown、分享会话
12. **搜索和过滤**：搜索历史消息、按工具筛选、按时间筛选
13. **Skills 和 Prompts 管理**：技能列表、快速调用界面、提示模板编辑
14. **主题和自定义**：暗色/亮色模式、代码高亮、自定义配色

---

## 5. 推荐的 UI 架构（Hermes）

```
hermes/
├── lib/
│   └── pi-rpc.ts              # RPC 客户端 + 类型
├── store/
│   ├── session.ts             # 会话状态
│   └── messages.ts            # 消息流状态
├── features/
│   ├── chat/                  # 聊天核心（P0）
│   ├── sessions/              # 会话管理（P0）
│   ├── tools/                 # 工具可视化（P0）
│   ├── controls/              # 控制栏（P1）
│   └── extension-ui/          # 扩展对话框（P1）
└── components/ui/             # 基础组件
```
