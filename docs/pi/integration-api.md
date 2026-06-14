# Pi 集成与 API

> 来源仓库：`https://github.com/earendil-works/pi.git`  
> 本地路径：`pi/`  
> 整理基准：`main` / `9ccfcd7c`

## 集成方式选择

| 场景 | 推荐方式 | 原因 |
| --- | --- | --- |
| Node.js 应用内嵌 agent | SDK / `AgentSession` | 不需要子进程，类型更完整 |
| IDE、GUI、非 Node 进程 | RPC mode | stdin/stdout JSONL，语言无关 |
| 终端用户直接使用 | Interactive mode | 内置 TUI、会话、快捷键、模型选择 |
| CI/脚本一次性任务 | Print / JSON mode | 易于脚本组合 |
| 自定义工作流或工具 | Extension | 可注册工具、命令、事件、UI |

## SDK

`@earendil-works/pi-coding-agent` 暴露用于嵌入的 API。最小示例：

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  sessionManager: SessionManager.inMemory(),
});

await session.prompt("What files are in the current directory?");
```

高级多 session 场景使用 `createAgentSessionRuntime()` 和 `AgentSessionRuntime`。它们会把 cwd、settings、resource、session manager、model registry 等运行期服务绑定在一起，并支持后续 `/new`、`/resume`、`/fork`、import 流程重建 runtime。

## RPC Mode

启动：

```bash
pi --mode rpc [options]
```

协议：

- 输入：stdin，每行一个 JSON command。
- 输出：stdout，每行一个 JSON response 或 event。
- framing：只按 LF (`\n`) 分割记录，可接受输入行末尾的 CRLF，但不要使用会把 Unicode separator 当换行的通用 line reader。
- command 可以带 `id`，response 会回传同一个 `id`。
- event 不带 `id`，它是异步 agent stream。

### 常用 command

Prompting:

```json
{"id":"req-1","type":"prompt","message":"Hello"}
{"type":"steer","message":"Stop and do this instead"}
{"type":"follow_up","message":"After that, summarize"}
{"type":"abort"}
```

State:

```json
{"type":"get_state"}
{"type":"get_messages"}
{"type":"get_session_stats"}
{"type":"get_last_assistant_text"}
```

Model:

```json
{"type":"set_model","provider":"anthropic","modelId":"claude-sonnet-4-20250514"}
{"type":"cycle_model"}
{"type":"get_available_models"}
{"type":"set_thinking_level","level":"high"}
```

Session:

```json
{"type":"new_session"}
{"type":"switch_session","sessionPath":"/path/to/session.jsonl"}
{"type":"fork","entryId":"abc123"}
{"type":"clone"}
{"type":"export_html"}
{"type":"set_session_name","name":"my-feature-work"}
```

Bash:

```json
{"type":"bash","command":"ls -la"}
{"type":"abort_bash"}
```

注意：RPC `bash` command 的输出会作为 `BashExecutionMessage` 存入上下文，但不会立即触发 LLM；它会在下一次 prompt 时作为上下文发送给模型。

### Streaming 时的输入策略

如果 agent 正在 streaming，`prompt` 必须指定 `streamingBehavior`：

```json
{"type":"prompt","message":"New instruction","streamingBehavior":"steer"}
```

- `steer`：当前 assistant turn 完成工具调用后、下一次 LLM call 前送入。
- `followUp`：agent 完全停止后再送入。

单独的 `steer` / `follow_up` command 也可直接入对应队列。

### Extension UI 子协议

Extension 在 RPC mode 下可通过 `ctx.ui.select()`、`confirm()`、`input()`、`editor()` 等发起用户交互。stdout 会收到：

```json
{"type":"extension_ui_request","id":"uuid-1","method":"select","title":"Allow?","options":["Allow","Block"]}
```

客户端需要向 stdin 回：

```json
{"type":"extension_ui_response","id":"uuid-1","value":"Allow"}
```

fire-and-forget UI 方法包括 `notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`，它们不需要 response。

## Extension API

Extension 是 Pi 最主要的扩展点。可实现：

- 自定义工具：`pi.registerTool()`
- 自定义命令：`pi.registerCommand()`
- 快捷键：`pi.registerShortcut()`
- CLI flags：`pi.registerFlag()`
- provider 注册：`pi.registerProvider()` / `pi.unregisterProvider()`
- 消息渲染：`pi.registerMessageRenderer()`
- 事件监听：`pi.on(event, handler)`
- 主动发消息：`pi.sendUserMessage()` / `pi.sendMessage()`
- session metadata：`pi.setSessionName()` / `pi.setLabel()`

常见事件：

- `input`
- `before_agent_start`
- `context`
- `before_provider_request`
- `after_provider_response`
- `message_start` / `message_update` / `message_end`
- `tool_call` / `tool_result`
- `session_start` / `session_before_switch` / `session_before_fork`
- `session_before_compact` / `session_compact`
- `session_before_tree` / `session_tree`

`tool_call` 可阻断工具执行，也可原地修改 `event.input`。修改参数后不会重新 schema validation，因此扩展作者必须保证结果仍符合工具参数类型。

## Session 文件

默认位置：

```text
~/.pi/agent/sessions/--<cwd-path>--/<timestamp>_<uuid>.jsonl
```

Session file 是 JSONL，第一行为 session header，后续 entry 形成树：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path/to/project"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"...","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}
```

集成方解析 session 时要注意：

- tree leaf 决定当前上下文，不是文件最后一行天然代表唯一线性历史。
- `compaction` entry 会改变上下文构造方式。
- `branch_summary` 用于在分支切换时保留被离开的路径信息。
- `custom` 不进 LLM context；`custom_message` 会进入 context。

## Provider 和模型集成

简单场景使用内置 provider 和环境变量：

```bash
export ANTHROPIC_API_KEY=...
pi --provider anthropic --model claude-sonnet-4-20250514
```

复杂场景可通过 extension 注册 provider：

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-proxy", {
    api: "anthropic-messages",
    apiKey: "$PROXY_API_KEY",
    baseUrl: "https://proxy.example.com",
    models: [
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude 4 Sonnet (proxy)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
    ],
  });
}
```

`apiKey` 支持字面值、环境变量插值（如 `$PROXY_API_KEY`）和 `!command`。如果需要 OAuth，可提供 `oauth.login()`、`refreshToken()`、`getApiKey()`。

## 集成建议

- GUI/IDE 集成优先用 RPC，不要解析 TUI 输出。
- Node.js 服务或 Electron main process 优先考虑 SDK，减少进程管理和 JSONL framing 风险。
- 对用户可见的权限确认应放在集成层或 extension 中；Pi core 默认不弹权限框。
- 处理 `message_update` 时按 event type 和 `contentIndex` 做增量 UI，不要只拼接 text。
- session 读取要按 tree 构造当前 branch，而不是把 JSONL 当普通 append-only chat log。
