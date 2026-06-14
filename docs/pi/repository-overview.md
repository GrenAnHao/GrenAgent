# Pi 仓库概览

> 来源仓库：`https://github.com/earendil-works/pi.git`  
> 本地路径：`pi/`  
> 整理基准：`main` / `9ccfcd7c`

## 项目定位

Pi 是一个 agent harness monorepo，主要产物是可交互的终端编码代理 `pi`。项目的核心思路是：内核保持小，工作流通过 extension、skill、prompt template、theme、package、SDK 或 RPC 扩展，而不是把计划模式、子代理、权限弹窗等特性全部内建进核心。

上游 README 对仓库的定位是：

- `@earendil-works/pi-coding-agent`：交互式编码代理 CLI。
- `@earendil-works/pi-agent-core`：带工具调用、事件流和状态管理的 agent runtime。
- `@earendil-works/pi-ai`：统一多 provider LLM API。
- `@earendil-works/pi-tui`：支持差量渲染的终端 UI 库。

## Monorepo 结构

```text
pi/
├── packages/
│   ├── ai/            # LLM provider abstraction
│   ├── agent/         # Agent runtime, event loop, harness primitives
│   ├── coding-agent/  # pi CLI, sessions, extensions, RPC, SDK
│   └── tui/           # Terminal UI primitives
├── scripts/           # build/check/release/supply-chain helper scripts
├── test.sh            # non-LLM test runner
├── pi-test.sh         # run pi from source
├── package.json       # root workspace scripts
└── README.md
```

Root `package.json` 使用 npm workspaces，要求 Node.js `>=22.19.0`。构建顺序是 `tui -> ai -> agent -> coding-agent`，因为 `coding-agent` 依赖前三个包。

## 运行模式

`pi` 主要提供四种运行方式：

- **Interactive**：默认终端 TUI，展示消息、工具调用、thinking、模型、token/cost 等状态。
- **Print / JSON**：一次性运行，适合脚本或流水线。
- **RPC**：通过 stdin/stdout 的 JSONL 协议集成到 IDE、GUI 或其他进程。
- **SDK**：在 Node.js 应用内直接使用 `createAgentSession()`、`AgentSessionRuntime` 等 API。

## 核心理念

Pi 的 README 明确强调几个“不内建”的选择：

- 不内建 MCP：推荐用 CLI 工具 + README，或用 extension 添加 MCP 能力。
- 不内建 sub-agent：可通过 extension、tmux 或第三方 package 实现。
- 不内建 permission popup：默认继承启动进程权限，需要隔离时用容器、OpenShell、Gondolin 等方案。
- 不内建 plan mode / todo：希望用户用文件、extension 或 package 自行组合。

这意味着集成 Pi 时要把它理解成“可扩展 agent runtime + CLI shell”，而不是固定产品形态。

## 关键用户能力

- 多 provider 模型选择：支持 Anthropic、OpenAI、Google、Vertex AI、Mistral、Groq、Bedrock、OpenRouter、Vercel AI Gateway、GitHub Copilot、Codex OAuth 等。
- 工具执行：默认内置 `read`、`write`、`edit`、`bash`，并可启用 `grep`、`find`、`ls`。
- 流式事件：assistant text、thinking、tool call arguments、tool execution result 都以事件流更新。
- 会话持久化：JSONL session file，支持 branching、fork、clone、compaction、export/share。
- 项目资源：自动加载 `AGENTS.md` / `CLAUDE.md`，支持 `.pi/` 和 `~/.pi/agent/` 下的 settings、extensions、skills、prompts、themes、packages。

## 供应链和安全边界

上游对依赖变更采取较强约束：

- 直接外部依赖精确锁定版本。
- `.npmrc` 使用 `save-exact=true` 和 `min-release-age=2`。
- `package-lock.json` 是依赖事实源。
- 发布的 CLI 包带 `packages/coding-agent/npm-shrinkwrap.json`。
- 安装示例推荐 `--ignore-scripts`。

运行时安全边界需要集成方自行处理。Pi 默认拥有启动用户和进程的权限，第三方 Pi package 和 extension 也可能执行任意代码。
