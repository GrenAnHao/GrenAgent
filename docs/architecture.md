# 架构文档

本文介绍 GrenAgent 的整体架构、模块职责与运行时数据流。面向需要理解或参与开发的工程师。

## 总览

GrenAgent 是一个本地优先的桌面 AI 编码 Agent，由三层组成：

```
┌─────────────────────────────────────────────┐
│  tauri-agent（桌面应用 grenagent-app）          │
│  ┌─────────────┐   invoke    ┌─────────────┐  │
│  │ React 前端   │ ──────────▶ │ Rust 后端    │  │
│  │ (Vite)      │ ◀────────── │ (Tauri)     │  │
│  └─────────────┘   event     └──────┬──────┘  │
└──────────────────────────────────────┼────────┘
                                        │ RPC (stdio)
                              ┌─────────▼─────────┐
                              │ cli（sidecar）     │
                              │ Pi runtime +      │
                              │ extensions        │
                              │  → binaries/pi    │
                              └───────────────────┘
```

- **请求**：前端通过 Tauri command（`invoke`）调用 Rust 后端。
- **流式回传**：Agent 运行过程中的事件（`agent_start` / `message_start` / `message_delta` / `agent_end` 等）通过 Tauri 事件回传前端。
- **执行**：Rust 后端以 RPC 模式（`--mode rpc`，stdio 管道）驱动 sidecar 进程，sidecar 内运行 Pi Agent 与全部内置扩展。

## 模块职责

### cli —— Agent sidecar

包名 `grenagent-agent-sidecar`，入口 `cli/src/main.ts`。它把 Pi 运行时与内置扩展编译成单个二进制 `binaries/pi`，无需全局安装 `pi`，也无需 `-e` 注入扩展。

采用混合运行时（hybrid runtime）：

- `--mode rpc`：由 Tauri 后端拉起。自行构建运行时，以便传入 `skillsOverride`、并按 `SKILLS_DISABLED` 过滤用户在 GUI 里禁用的技能。
- 其他模式（子代理、记忆抽取等一次性任务，走 `--mode json -p`）：复用官方 `main()`，由其处理 print 模式。

进程退出时，父进程（Tauri）会关闭 stdio / RPC 管道，在途写入随后以 `EPIPE` 失败。sidecar 在模块加载阶段就注册 `EPIPE` 处理：一旦命中即干净退出，避免对死管道反复写入导致 stderr 刷屏。

### extensions —— 内置扩展包

包名 `pi-extensions-pack`。权威清单是 `extensions/index.ts` 的 `allExtensions`（当前 **37 个**），由 sidecar 的 `extensionFactories` 一并编译进 `binaries/pi`。`extensions/package.json` 的 `pi.extensions` 字段仅用于独立安装时的元数据，与 sidecar 实际加载列表可能不一致。

扩展通过 `pi.registerTool()` 注册工具、`pi.registerCommand()` 注册斜杠命令。能力类扩展（生图 / TTS / Embedding）通过共享的 `resolveCapabilityEndpoint` 从模型注册表解析供应商与模型。

#### 内置扩展

| 扩展 | 职责 | 主要工具 / 命令 |
| --- | --- | --- |
| `safety` | 工具调用安全闸：路径保护、危险 bash 拦截、沙箱模式约束 | 策略 / 中间件，无显式工具 |
| `approval` | 审批策略（ask / auto / full）切换与持久化 | `/approval` |
| `loop-guard` | 防止相同工具死循环与单次请求工具调用发散 | 策略 / 中间件，无显式工具 |
| `rulebook` | 声明式规则库（`.pi/rules.jsonc`），工具 / 文本规则拦截与纠正 | `/rules` |
| `compaction-policy` | 上下文修剪与压力指示 | `/compaction` |
| `auto-title` | 首轮结束后自动生成会话标题 | 策略 / 中间件，无显式工具 |
| `checkpoint` | 每轮工作区 git 影子快照，可回滚文件 | `/checkpoint` |
| `todo` | 会话内待办清单 | `todo` |
| `agent-mode` | Agent / Ask / Debug / Plan 模式切换与 Plan 卡片 | `/mode`、`/plan`、`/plan-build`、`ask_user` |
| `debug-tools` | 调试日志工具 | `debug_log` |
| `dap` | Debug Adapter Protocol 调试 | `dap_launch`、`dap_set_breakpoints`、`dap_evaluate` 等 |
| `diagram-hint` | Mermaid / KaTeX 渲染约定提示（隐式注入） | 策略 / 中间件，无显式工具 |
| `fable-behavior` | Fable 5 + coding-agent 行为层（Tier 注入 + 子 agent 种子 + `fable_behavior_ref`） | `fable_behavior_ref` |
| `goal` | 设定会话完成条件并自动驱动 / 判定 | `/goal` |
| `knowledge-rag` | 知识库 RAG：分块、向量或关键词检索 | `kb_search`、`kb_add`、`/kb` |
| `long-term-memory` | 跨会话长期记忆存取 | `memory_save`、`memory_recall`、`/memory` |
| `session-memory` | 会话结构化工作状态，压缩后重锚 | `/session-state` |
| `web-fetch` | 单页 URL 抓取 | `fetch_url`、`fetch_llms`、`fetch_html`、`fetch_markdown`、`fetch_txt`、`fetch_json` |
| `web-search` | 多引擎联网搜索与站点 / GitHub 抓取 | `web_search`、`web_search_multi`、`fetch_web_content` |
| `session-search` | 跨会话历史搜索 | `history_search`、`/history` |
| `mcp` | 外部 MCP server 工具桥接 | `mcp__<server>__<tool>`（动态） |
| `mcp-policy` | MCP 工具权限策略与审计 | 策略 / 中间件，无显式工具 |
| `image-gen` | 文生图 | `generate_image` |
| `code-review` | 结构化代码审查记录与报告 | `git_diff`、`review_note`、`/review` |
| `diagnostics` | 环境 / 依赖诊断 | `diagnostics` |
| `multi-agent` | 子代理委派 | `spawn_agent` |
| `code-intel` | CodeGraph 只读探索子代理 | `explore_context` |
| `lsp` | 语言服务器：定义 / 引用 / 悬停等 | `lsp_definition`、`lsp_references` 等 |
| `code-search` | 工作区代码索引与搜索 | `code_search`、`/code-index` |
| `ast-tools` | AST 结构化搜索与编辑 | `ast_grep`、`ast_edit` |
| `github` | GitHub CLI 封装 | `github` |
| `batch-tools` | 批量读文件与工作区搜索 | `read_files`、`search` |
| `code-exec` | 持久 Python / JavaScript 执行环境 | `py_run`、`js_run` |
| `hashline` | 行号锚点读写与编辑 | `hl_read`、`hl_edit` |
| `tts` | 语音合成 | `speak` |
| `im-gateway` | HTTP webhook IM 网关（Slack / Feishu 等适配） | `/imgateway` |
| `im-platforms` | 微信 ilink bot 接入，隔离式远程遥控 | `/im` |

### tauri-agent —— 桌面应用

包名 `grenagent-app`，分前端与 Rust 后端两部分。

**前端（`tauri-agent/src`）：**

- `features/`：按域划分的业务模块——`chat`（对话）、`sessions`（会话 / 项目侧栏）、`knowledge`（知识库）、`memory`（记忆）、`connections`（IM 接入 / 微信）、`usage`（用量）、`settings`（供应商 / 模型）、`dock`（终端 Dock）、`tools`（工具卡片）、`extensions`（扩展 / 技能）。
- `stores/`：轻量 vanilla store 加 reducer，通过 `requestAnimationFrame` 批量通知组件，避免每帧不可变拷贝。
- `lib/`：`pi.ts`（封装所有 Tauri command 与事件监听）、会话合并、预热等。
- `components/`：品牌、标题栏、加载、错误边界等通用组件。
- `theme/`：主题与配色方案，运行时注入 `--gren-*` CSS 变量。

**Rust 后端（`tauri-agent/src-tauri`）：**

- `commands/`：Tauri command 实现，按域拆分——`agent`、`sessions`、`usage`、`knowledge`、`memory`、`git`、`code_intel`、`skills`、`subagent`、`providers`、`checkpoint`、`mcp_policy`、`files` 等。
- `state/`：应用全局状态。
- `capabilities/`：Tauri 权限声明（如 `opener:default`、`dialog:allow-open`、`shell:allow-spawn` 等）。

部分 command 直接读取本地数据，不经过 sidecar，例如 `usage_report` 扫描会话 jsonl 聚合用量、`kb_*` 只读打开知识库 SQLite。

## IM 接入（微信）

`im-platforms` 扩展把 Pi Agent 接到微信（官方 ilink / clawbot AI-bot 接口），实现单一主人的远程遥控：在手机微信里给 bot 发消息即可驱动 Agent。

- 扫码登录、长轮询收发，无需公网；启用开关与网络配置均热更新（写盘后 sidecar 重连，无需重启）。
- 运行状态经 `setStatus("wechat", ...)`、会话镜像经 `setStatus("wechat-messages", ...)` 从 sidecar 推送到前端。
- 前端 `ExtensionUiHost`（`tauri-agent/src/features/extensionUi`）接收后写入 `wechatStatusStore` / `imMessagesStore`，由「连接」面板 `ConnectionsPanel` 展示登录二维码、状态与只读会话镜像。
- 主人自己的交互式会话与微信流量隔离，因此桌面 UI 的「微信会话记录」是唯一能看到微信聊了什么的地方。

## 代码智能

内置 CodeGraph 作为离线、零配置的代码图谱引擎，基于 tree-sitter 与 SQLite，文件变更自动增量同步。二进制随应用打包（`tauri.conf.json` 的 `resources` 收录 `binaries/codegraph`），由 `code_intel` 相关 command 托管索引与查询。

## 数据存储

| 数据 | 位置 |
| --- | --- |
| 会话记录 | `~/.pi/agent/sessions/*.jsonl` |
| 知识库 | `<工作区>/.pi/knowledge/default.db`（SQLite） |
| 生成的图片 | `<工作区>/.pi/images/` |
| 合成的音频 | `<工作区>/.pi/audio/` |
| 代码图谱 | `<工作区>/.codegraph/`（已被 gitignore） |

## 用量统计口径

`usage_report`（`tauri-agent/src-tauri/src/commands/usage.rs`）扫描会话 jsonl，只聚合满足以下条件的记录：`type` 为 `message`、`message.role` 为 `assistant`、且带 `usage` 字段，从中累加 input / output / cacheRead / cacheWrite 与 cost。

由此可知：生图、TTS 等工具调用以 tool result 形式返回、不带 `usage` 字段，因此其调用量与费用不计入用量统计；统计页是纯 Token 报表。

## 独立模块：本地向量服务（embedding）

`embedding/` 是一个独立的本地向量服务，当前尚未集成进 sidecar 或桌面应用。它在本地 CPU 上用 `@huggingface/transformers` 运行 `Xenova/all-MiniLM-L6-v2`，通过 `POST /embed` 返回 384 维向量，并可用 Node.js SEA 打成单文件可执行程序。

它面向未来的本地化向量检索（离线 RAG / 代码语义搜索等），无需远程 Embedding API。注意 `tauri.conf.json` 目前只打包 `binaries/pi` 与 `binaries/codegraph`，不含该服务。实现细节见 `embedding/README.md`。
