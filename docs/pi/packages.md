# Pi 包说明

> 来源仓库：`https://github.com/earendil-works/pi.git`  
> 本地路径：`pi/`  
> 整理基准：`main` / `9ccfcd7c`

## 包依赖关系

```text
@earendil-works/pi-coding-agent
  ├── @earendil-works/pi-agent-core
  ├── @earendil-works/pi-ai
  └── @earendil-works/pi-tui

@earendil-works/pi-agent-core
  └── @earendil-works/pi-ai

@earendil-works/pi-tui
  └── terminal rendering/input dependencies

@earendil-works/pi-ai
  └── provider SDKs and streaming utilities
```

Root build 顺序是 `tui -> ai -> agent -> coding-agent`。

## `@earendil-works/pi-ai`

位置：`pi/packages/ai`

职责：

- 提供统一 LLM API。
- 维护 provider/model registry。
- 将不同 provider 的响应规范化成统一事件。
- 支持 text、image input、image generation、thinking/reasoning、tool calling、usage/cost。
- 支持跨 provider handoff，将不同 provider 的 assistant message 转换为兼容格式。

主要导出：

- `getModel()` / `getModels()` / `getProviders()`
- `stream()` / `complete()`
- `streamSimple()` / `completeSimple()`
- `getImageModel()` / `generateImages()`
- `Type` / `Static` / `TSchema`
- provider-specific option types
- OAuth 类型和工具

支持的 provider 包括 OpenAI、Anthropic、Google、Vertex AI、Mistral、Groq、Cerebras、Bedrock、OpenRouter、Vercel AI Gateway、GitHub Copilot、OpenAI Codex、DeepSeek、xAI、ZAI、MiniMax、Together AI、Fireworks、Kimi、Xiaomi MiMo 等。

开发扩展点：

- 新增 provider 需要改 `src/types.ts`、`src/providers/`、`src/providers/register-builtins.ts`、model generation scripts、tests、README 和 changelog。
- 自定义 OpenAI-compatible 或 Anthropic-compatible endpoint 可以通过 custom `Model` 或 coding-agent extension provider registration 实现。
- Browser 环境可用，但 API key 需要显式传入；生产场景应使用 backend proxy。

## `@earendil-works/pi-agent-core`

位置：`pi/packages/agent`

职责：

- 提供有状态 `Agent`。
- 提供低层 `agentLoop()` / `agentLoopContinue()`。
- 管理 `AgentMessage`、`AgentEvent`、工具调用、事件订阅、steering/follow-up queue。
- 提供 compaction、branch summary、session repo、skills、prompt templates、system prompt 等 harness primitive。

核心概念：

- `AgentMessage` 比 LLM message 更宽，可以包含 UI-only 或 extension 自定义类型。
- `transformContext()` 用于裁剪或注入上下文。
- `convertToLlm()` 用于过滤并转换给 provider 的标准 message。
- `beforeToolCall` 和 `afterToolCall` 可以拦截、阻断或修饰工具执行。
- `toolExecution` 可为 `parallel` 或 `sequential`。

适用场景：

- 需要构建自己的 agent runtime，但不想使用 Pi CLI。
- 需要精确控制事件、工具、消息转换、compaction 或上下文。
- 需要把 agent 嵌入服务端、桌面端或测试框架。

## `@earendil-works/pi-coding-agent`

位置：`pi/packages/coding-agent`

职责：

- 发布 `pi` CLI。
- 提供 interactive / print / json / rpc 模式。
- 管理 settings、session、model registry、auth、resource loading、extensions。
- 提供默认内置工具和 TUI 渲染。
- 暴露 SDK API，允许外部 Node.js 应用直接创建 agent session。

关键模块：

- `AgentSession`：会话生命周期和 agent 操作的主入口。
- `AgentSessionRuntime`：支持当前 cwd 绑定的服务重建，用于 `/new`、`/resume`、`/fork`、import 等流程。
- `SessionManager`：JSONL session 文件读写、树结构、branch、fork、clone。
- `SettingsManager`：合并全局和项目 settings，处理 trust-gated project writes。
- `ModelRegistry`：模型注册、选择、OAuth/API key 解析。
- `ResourceLoader`：加载 AGENTS/CLAUDE context、skills、prompts、themes、extensions、packages。
- `ExtensionRunner`：绑定 extension runtime、事件、UI、工具、命令。

默认 CLI 能力：

- `pi`：交互式启动。
- `pi -p` / `--print`：一次性输出。
- `pi --mode json`：JSON event stream。
- `pi --mode rpc`：JSONL RPC integration。
- `pi --session` / `--fork` / `--continue` / `--resume`：会话恢复和分支。
- `pi install` / `pi remove` / `pi update` / `pi config`：Pi package 管理。

## `@earendil-works/pi-tui`

位置：`pi/packages/tui`

职责：

- 提供 terminal UI framework。
- 支持差量渲染和 synchronized output，减少闪烁。
- 支持 editor、input、select list、settings list、Markdown、loader、image、overlay 等组件。
- 支持 Kitty keyboard protocol、IME cursor positioning、bracketed paste、file/slash autocomplete。

核心导出：

- `TUI`、`Container`、`Component`、`Focusable`
- `ProcessTerminal`
- `Editor`、`Input`、`Text`、`Markdown`、`SelectList`、`SettingsList`
- `Image`、terminal image helpers
- `matchesKey()`、`Key`、keybinding manager
- `visibleWidth()`、`truncateToWidth()`、`wrapTextWithAnsi()`

使用注意：

- `render(width)` 返回的每一行不得超过 `width`。
- 带输入光标的组件应实现 `Focusable`，尤其要考虑中文/日文/韩文 IME 候选窗定位。
- 样式不要跨行依赖 ANSI 状态，应每行重置或使用工具函数包裹。

## Root workspace

位置：`pi/package.json`

主要脚本：

- `npm run build`：按包依赖顺序构建所有包。
- `npm run check`：Biome、依赖 pin 检查、TypeScript import 检查、shrinkwrap 检查、`tsgo --noEmit`、browser smoke。
- `npm run test`：workspace test。
- `npm run release:local`：本地 release smoke。
- `npm run publish:*` / `npm run release:*`：发布流程。

推荐本地验证：

```bash
npm install --ignore-scripts
npm run build
npm run check
./test.sh
./pi-test.sh
```
