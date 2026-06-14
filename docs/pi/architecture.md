# Pi 架构与数据流

> 来源仓库：`https://github.com/earendil-works/pi.git`  
> 本地路径：`pi/`  
> 整理基准：`main` / `9ccfcd7c`

## 分层视图

```text
User / IDE / CLI / GUI
        |
        v
@earendil-works/pi-coding-agent
  - CLI modes: interactive / print / json / rpc
  - AgentSession, SessionManager, SettingsManager
  - ResourceLoader, ExtensionRunner, ModelRegistry
        |
        v
@earendil-works/pi-agent-core
  - Agent, agentLoop, agentLoopContinue
  - AgentMessage, AgentEvent, tool execution
  - compaction, skills, prompt templates, session harness
        |
        v
@earendil-works/pi-ai
  - Model registry
  - stream(), complete(), streamSimple(), completeSimple()
  - provider adapters and content/tool-call event normalization
        |
        v
LLM Providers
```

`@earendil-works/pi-tui` 横向服务 `coding-agent` 的 interactive mode，负责终端组件、输入、选择器、Markdown、图片和差量渲染。

## 输入到响应的主链路

1. 用户从 TUI、print/json、RPC 或 SDK 提交 prompt。
2. `coding-agent` 解析输入，展开 file refs、skill commands、prompt templates，并根据当前模式决定是否入队。
3. `AgentSession` 将输入送入 `Agent`，同时绑定 settings、session、resource、extension、model registry。
4. `Agent` 触发 `agent_start`、`turn_start`、`message_start` 等事件。
5. `agent-core` 将 `AgentMessage[]` 经过可选 `transformContext()`，再由 `convertToLlm()` 转成 provider 可接受的 LLM message。
6. `pi-ai` 使用当前 `Model` 和 provider adapter 发起流式请求。
7. LLM 响应被规范化成 `AssistantMessageEvent`，包括 text、thinking、toolcall、usage、stop/error。
8. 如果 assistant 请求工具调用，`agent-core` 验证参数、触发 tool hooks、执行工具并发出工具事件。
9. 工具结果写回上下文；如果需要，进入下一 turn。
10. 没有继续条件后触发 `turn_end` 和 `agent_end`，session 持久化当前消息和状态。

## 事件模型

Pi 用事件流驱动 UI 和集成层。核心事件包括：

- `agent_start` / `agent_end`
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `queue_update`
- `compaction_start` / `compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `extension_error`

`message_update` 内部携带 `assistantMessageEvent`，它进一步区分：

- `text_start` / `text_delta` / `text_end`
- `thinking_start` / `thinking_delta` / `thinking_end`
- `toolcall_start` / `toolcall_delta` / `toolcall_end`
- `done`
- `error`

集成方应按 `contentIndex` 关联同一 content block，不要假设 text、thinking、toolcall 的 delta 一定连续。

## 消息模型

`AgentMessage` 是 agent 层统一消息类型，包含：

- `user`：用户输入，可包含文本和图片。
- `assistant`：模型输出，可包含 text、thinking、toolCall。
- `toolResult`：工具执行结果，可包含文本和图片。
- `bashExecution`：用户通过 `!` / RPC bash 命令执行的 shell 结果。
- `custom`：extension 注入的自定义消息。
- `branchSummary`：会话树切换时生成的分支摘要。
- `compactionSummary`：上下文压缩摘要。

LLM 不直接理解所有 `AgentMessage`。发送前会通过 `convertToLlm()` 过滤或转换成 provider 支持的标准 message。

## 工具执行模型

工具定义使用 TypeBox schema：

```typescript
interface ToolDefinition<TParams, TDetails> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  executionMode?: "parallel" | "sequential";
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}
```

默认执行模式是 `parallel`：工具预检按顺序进行，允许执行的工具并发运行，`tool_execution_end` 按完成顺序发出，但写入 LLM 上下文的 tool result 仍按 assistant 原始 tool call 顺序排列。如果某个工具标记为 `sequential`，整批工具调用按顺序执行。

工具可以通过 `onUpdate` 流式回传部分结果，也可以返回 `terminate: true` 建议跳过后续 LLM follow-up；只有同一批 finalized tool result 全部 `terminate` 时才会提前停止。

## 会话与分支

Pi 会话是 JSONL 文件，每行一个 entry。当前格式版本为 v3，支持树结构：

- entry 有 `id` 和 `parentId`。
- 当前 leaf 表示会话当前位置。
- `/tree` 可以跳回旧节点并从那里继续。
- `/fork` 和 `/clone` 可派生新 session file。
- `buildSessionContext()` 会从 leaf 回溯到 root，构造当前分支的 LLM 上下文。

重要 entry 类型包括：

- `session`
- `message`
- `model_change`
- `thinking_level_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `session_info`

## Extension 运行时

Extension 是 TypeScript module，默认导出 `ExtensionFactory`：

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool(...);
  pi.registerCommand(...);
  pi.on("tool_call", async (event, ctx) => ...);
}
```

Extension 可以：

- 监听 project trust、session、context、provider、agent、message、tool、input 等事件。
- 注册 LLM-callable tools。
- 注册 slash commands、keyboard shortcuts、CLI flags。
- 注入或渲染 custom messages。
- 注册或覆盖 provider/model。
- 操作 UI：select、confirm、input、notify、setStatus、setWidget、setTitle、editor 等。

TUI、RPC、JSON、print 四种模式提供不同能力。代码里通过 `ctx.mode` 和 `ctx.hasUI` 判断，避免在 RPC/print 中调用仅 TUI 可用的组件能力。

## 配置和信任边界

配置来源：

- `~/.pi/agent/settings.json`：全局配置。
- `.pi/settings.json`：项目配置，覆盖全局配置。

项目 trust 控制是否加载 `.pi/settings.json`、项目本地 extension、项目 package 等有执行风险的资源。交互模式会询问；非交互模式默认依据 `defaultProjectTrust`，也可通过 `--approve` / `--no-approve` 覆盖。

## 安全模型

Pi 默认不提供权限隔离。内置工具、`!` 命令和 extension 默认继承启动进程权限。需要隔离时有三类官方文档推荐模式：

- **OpenShell**：整个 `pi` 进程在 sandbox 中运行。
- **Gondolin extension**：`pi` 留在 host，内置工具和 `!` 命令路由到本地 Linux micro-VM。
- **Plain Docker**：整个 `pi` 进程跑在 Docker 容器中。

集成 IDE 或 GUI 时，如果要暴露写文件、bash、package install 等能力，应在 Pi 外层增加项目授权、路径限制、命令确认或沙箱策略。
