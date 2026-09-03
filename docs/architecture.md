# 架构文档

本文介绍 GrenAgent 的整体架构、模块职责与运行时数据流。面向需要理解或参与开发的工程师。

> **桌面端主线是 Electron。** `electron-agent/` 为当前实现，`tauri-agent/`（Tauri 2 + Rust）已过时并冻结，文中涉及 Tauri 的段落均标注为历史，仅作迁移对照。桌面能力从 Tauri command 迁移到 Electron 的收口点见 `electron-agent/docs/tauri-api-inventory.md`。

## 总览

GrenAgent 是一个本地优先的桌面 AI 编码 Agent，由三层组成：

```
┌────────────────────────────────────────────────────────┐
│  electron-agent（桌面应用）                               │
│  ┌────────────────┐   window.gren   ┌────────────────┐  │
│  │ React 渲染层     │ ─────────────▶ │ 主进程服务层     │  │
│  │ (Vite/Renderer) │ ◀───────────── │ (Electron)     │  │
│  └───────┬────────┘   gren:event:   └────────┬───────┘  │
│          │                                   │          │
│  ┌───────▼───────────────────────────────────▼───────┐  │
│  │ Agent Data Runtime（127.0.0.1 随机端口 JSONL RPC）   │  │
│  │ 记忆 L0-L3 / Wiki FTS5 / 任务与审计（node:sqlite）    │  │
│  └───────────────────────┬───────────────────────────┘  │
└──────────────────────────┼──────────────────────────────┘
                           │ stdio JSONL RPC（--mode rpc）
                 ┌─────────▼─────────┐
                 │ cli（sidecar）     │
                 │ Pi runtime +      │
                 │ extensions        │
                 │  → resources/pi   │
                 └───────────────────┘
```

- **请求**：渲染层通过 `window.gren.invoke(command, args)` 调用主进程，走单业务通道 `gren:invoke`（`electron/ipc/contracts.ts` 定义、按命令名分发）。
- **流式回传**：Agent 运行过程中的事件（`agent_start` / `message_start` / `message_delta` / `agent_end` 等）由主进程 `broadcastPiEvent` 广播到所有窗口（`pi://event`、`pi://ui-request`、`pi://exit`，统一 `gren:event:` 前缀）。
- **执行**：主进程按工作区维持一个 sidecar 进程，以 RPC 模式（`--mode rpc`，stdio JSONL）驱动，sidecar 内运行 Pi Agent 与全部内置扩展。
- **隔离**：业务代码只依赖 `src/platform/runtime.ts` 定义的 `GrenRuntimeBridge`，不直接引用 Electron；无 bridge 时自动降级为浏览器预览实现。

## 模块职责

### cli —— Agent sidecar

包名 `grenagent-agent-sidecar`，入口 `cli/src/main.ts`。它把 Pi 运行时与内置扩展编译成单个二进制 `resources/pi`（`electron-agent/scripts/build-sidecar.mjs` 用 `bun build --compile` 产出，随安装包分发），无需全局安装 `pi`，也无需 `-e` 注入扩展。

采用混合运行时（hybrid runtime）：

- `--mode rpc`：由 Electron 主进程拉起（历史版本由 Tauri 后端拉起）。保留 Pi 原生 Skill 扫描，并追加当前 Agent 的托管 Skill 根目录；同名时本机原生 Skill 优先。
- 其他模式（子代理等一次性任务，走 `--mode json -p`）：复用官方 `main()`，由其处理 print 模式。

主进程解析 sidecar 的顺序为：环境变量 `GREN_PI_COMMAND` → 打包态 `resources/pi/pi(.exe)` → 开发态用 Bun 直接跑 `cli/src/main.ts`（`electron/runtimePaths.ts`）。

进程退出时，父进程（Electron 主进程）会关闭 stdio / RPC 管道，在途写入随后以 `EPIPE` 失败。sidecar 在模块加载阶段就注册 `EPIPE` 处理：一旦命中即干净退出，避免对死管道反复写入导致 stderr 刷屏。

### extensions —— 内置扩展包

包名 `pi-extensions-pack`。权威清单是 `extensions/index.ts` 的 `allExtensions`，由 sidecar 的 `extensionFactories` 一并编译进 `binaries/pi`。`extensions/package.json` 的 `pi.extensions` 字段仅用于独立安装时的元数据，与 sidecar 实际加载列表可能不一致。

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
| `tencentdb-memory` | TencentDB 长期记忆与会话捕获，支持本机托管和远程 Gateway | `tdai_memory_search`、`tdai_conversation_search` |
| `session-memory` | 会话结构化工作状态，压缩后重锚 | `/session-state` |
| `web-fetch` | 单页 URL 抓取 | `fetch_url`、`fetch_llms`、`fetch_html`、`fetch_markdown`、`fetch_txt`、`fetch_json` |
| `web-search` | 多引擎联网搜索与站点 / GitHub 抓取 | `web_search`、`web_search_multi`、`fetch_web_content` |
| `mcp` | 外部 MCP server 工具桥接 | `mcp__<server>__<tool>`（动态） |
| `mcp-policy` | MCP 工具权限策略与审计 | 策略 / 中间件，无显式工具 |
| `image-gen` | 文生图 | `generate_image` |
| `code-review` | 结构化代码审查记录与报告 | `git_diff`、`review_note`、`/review` |
| `diagnostics` | 环境 / 依赖诊断 | `diagnostics` |
| `multi-agent` | 子代理委派 | `spawn_agent` |
| `lsp` | 语言服务器：定义 / 引用 / 悬停等 | `lsp_definition`、`lsp_references` 等 |
| `ast-tools` | AST 结构化搜索与编辑 | `ast_grep`、`ast_edit` |
| `github` | GitHub CLI 封装 | `github` |
| `batch-tools` | 批量读文件与工作区搜索 | `read_files`、`search` |
| `code-exec` | 持久 Python / JavaScript 执行环境 | `py_run`、`js_run` |
| `hashline` | 行号锚点读写与编辑 | `hl_read`、`hl_edit` |
| `tts` | 语音合成 | `speak` |
| `im-gateway` | HTTP webhook IM 网关（Slack / Feishu 等适配） | `/imgateway` |
| `im-platforms` | 微信 ilink bot 接入，隔离式远程遥控 | `/im` |

### electron-agent —— 桌面应用（当前主线）

包名 `electron-agent`，由渲染层、主进程服务层与自研 Agent Data Runtime 组成。

**渲染层（`electron-agent/src`）：**

- `features/`：按域划分的业务模块——`chat`（对话）、`sessions`（会话 / 项目侧栏）、`connections`（IM 接入 / 微信）、`usage`（用量）、`settings`（供应商 / 模型）、`dock`（终端 Dock）、`tools`（工具卡片）、`extensions`（扩展 / 技能）、`agentData`（记忆与知识资产）、`workspace`、`context`、`panels`、`subagents`、`visual`、`layout`、`common`、`extensionUi`。
- `stores/`：zustand store 群，`agent.ts` / `agentReducer.ts` 为核心，把 pi 事件流折叠为会话状态。
- `lib/`：主进程能力封装——`pi.ts`（`onPiEvent` / `onPiUiRequest` / `onPiExit`）、`agentData.ts`（记忆与 Wiki API）等。
- `platform/`：**后端抽象层**。`runtime.ts` 定义 `GrenRuntimeBridge` 并对接 `window.gren`，无 bridge 时降级为 `browserPreviewBridge`，使渲染层可在纯浏览器预览态运行。
- `components/` / `theme/`：通用组件与主题，运行时注入 `--gren-*` CSS 变量。

**主进程（`electron-agent/electron`）：**

- `main.ts` / `mainConfig.ts`：窗口创建与生命周期。`whenReady` 内构造全部服务与 `PiManager` 并启动 Agent Data Runtime，`before-quit` 关闭 sidecar 与运行时。
- `app/`：服务层，取代原 Tauri command 实现——`piRuntimeService`（25 个 `agent_*` 命令到 pi RPC 的映射，含 `/mode`、`/approval` 等伪命令与 `rewindTo`）、`workspaceService`、`settingsService`、`mcpConfigService`、`mcpPolicyService`、`usageService`、`gitService`、`fileService`、`skillService`、`subagentService`、`uiHistoryService`、`createService`、`providerService` 等；`terminalService`（命令白名单 spawn）与 `shellService`（node-pty 真 PTY）提供终端能力；`processRegistry` / `shutdown` 负责进程树回收与优雅退出。
- `pi/`：sidecar 客户端与进程管理，按工作区一个进程，stdio JSONL 通信，退出时先 `stdin.end()` 再 `killTree()`。另有 oneshot 与 `probe-models` 等短命调用。
- `ipc/`：`contracts.ts` 定义命令与事件通道（`gren:invoke`、`gren:event:`），`register.ts` 注册全量命令（含 `agent_*` 透传与流式 Channel）。
- `preload.ts`：向渲染层暴露 `window.gren`（`invoke` / `subscribe` / 目录选择 / 打开外部 / 窗口控制 / webview 拖放）。
- `webviewSecurity.ts` / `webviewPreload.ts`：对 webview 二次强制 `contextIsolation`、`sandbox`、关闭 `nodeIntegration`，并限制导航与 `window.open`。
- `runtimePaths.ts`：sidecar 与运行时路径解析（顺序见 cli 章节）。

**Agent Data Runtime（`electron-agent/electron/agentData`）：**

自研的本地数据运行时，取代历史版本随包分发的 TencentDB 托管服务。启动后在 `127.0.0.1` 随机端口提供 JSONL RPC（`randomBytes(32)` token 鉴权），数据落在 `<应用数据目录>/agent-data.db`（`node:sqlite`）：

- `memoryStore`：L0-L3 分级记忆，fingerprint 去重与增量 capture / commit。
- `wikiStore`：Markdown 按标题切块，`wiki_pages` 加 FTS5 `wiki_fts` 全文检索。
- `jobStore`：任务、配置（version 乐观锁）与审计，支持导出 / 导入 / 诊断。
- 代码检索（CodeGraph）目前为占位实现，`codeRetrieval.status` 返回未连接。

运行时启动后主进程自连，同时把 endpoint 以 `AGENT_DATA_ENDPOINT` 注入每个 pi 子进程，sidecar 可反向调用记忆与 Wiki 能力。

部分命令直接读取本地数据，不经过 sidecar，例如 `usageService` 扫描会话 jsonl 聚合用量。

### tauri-agent —— 桌面应用（已过时 · 冻结）

> 已停止维护：不再接受功能开发、缺陷修复与依赖升级。以下为历史结构，仅供迁移对照，参见 [`tauri-agent/README.md`](../tauri-agent/README.md) 与 [`electron-agent/docs/tauri-api-inventory.md`](../electron-agent/docs/tauri-api-inventory.md)。

包名 `grenagent-app`，分前端与 Rust 后端两部分。

**前端（`tauri-agent/src`，历史快照）：**

- `features/`：按域划分的业务模块——`chat`（对话）、`sessions`（会话 / 项目侧栏）、`connections`（IM 接入 / 微信）、`usage`（用量）、`settings`（供应商 / 模型）、`dock`（终端 Dock）、`tools`（工具卡片）、`extensions`（扩展 / 技能）、`tencentdb`（记忆连接与资产）。
- `stores/`：轻量 vanilla store 加 reducer，通过 `requestAnimationFrame` 批量通知组件，避免每帧不可变拷贝。
- `lib/`：`pi.ts`（封装所有 Tauri command 与事件监听）、会话合并、预热等。
- `components/`：品牌、标题栏、加载、错误边界等通用组件。
- `theme/`：主题与配色方案，运行时注入 `--gren-*` CSS 变量。

**Rust 后端（`tauri-agent/src-tauri`，历史快照）：**

- `commands/`：Tauri command 实现，按域拆分——`agent`、`sessions`、`usage`、`git`、`subagent`、`providers`、`checkpoint`、`mcp_policy`、`tencentdb`、`files` 等。
- `state/`：应用全局状态。
- `capabilities/`：Tauri 权限声明（如 `opener:default`、`dialog:allow-open`、`shell:allow-spawn` 等）。

（历史行为）部分 command 直接读取本地数据，不经过 sidecar，例如 `usage_report` 扫描会话 jsonl 聚合用量；长期记忆与知识检索统一经 TencentDB SDK / MemoryKnowledge MCP。

## IM 接入（微信）

`im-platforms` 扩展把 Pi Agent 接到微信（官方 ilink / clawbot AI-bot 接口），实现单一主人的远程遥控：在手机微信里给 bot 发消息即可驱动 Agent。

- 扫码登录、长轮询收发，无需公网；启用开关与网络配置均热更新（写盘后 sidecar 重连，无需重启）。
- 运行状态经 `setStatus("wechat", ...)`、会话镜像经 `setStatus("wechat-messages", ...)` 从 sidecar 推送到前端。
- 前端 `ExtensionUiHost`（`electron-agent/src/features/extensionUi`）接收后写入 `wechatStatusStore` / `imMessagesStore`，由「连接」面板 `ConnectionsPanel` 展示登录二维码、状态与只读会话镜像。
- 主人自己的交互式会话与微信流量隔离，因此桌面 UI 的「微信会话记录」是唯一能看到微信聊了什么的地方。

## 记忆与知识运行时

当前桌面端（Electron）使用自研 **Agent Data Runtime**（见上文 `electron-agent/electron/agentData`）：随主进程启动，数据在 `<应用数据目录>/agent-data.db` 本地落盘（`node:sqlite`），提供 L0-L3 分级记忆与 Wiki FTS5 检索；运行时 endpoint 以 `AGENT_DATA_ENDPOINT` 注入每个 pi 子进程，扩展可反向调用。

> **历史（Tauri 版，已过时）**：桌面端通过 Tauri 生命周期托管随安装包分发的 Node.js、MemoryCore 和 MemoryKnowledge。`local` 模式在应用启动时启动两个回环服务并等待 `/health`，自动初始化固定的单用户身份 `local / personal-local / pi-personal`，退出时由进程守卫回收；`remote` 模式不创建本机子进程，只连接配置的 HTTPS Gateway，并允许使用服务端已有 Team、Agent 和 User 身份。远程 Gateway API Key 与 User Key 分别保存在系统凭据库。Pi sidecar 启动后立即把两项 TencentDB 密钥移入模块私有内存并从工具子进程环境删除；知识工具通过仅获得专用 token 的 MemoryKnowledge MCP 注入。

## 数据存储

| 数据 | 位置 |
| --- | --- |
| 会话记录 | `~/.pi/agent/sessions/*.jsonl` |
| Agent Data（记忆 / Wiki / 任务与审计） | `<应用数据目录>/agent-data.db`（Electron 主进程托管） |
| 生成的图片 | `<工作区>/.pi/images/` |
| 合成的音频 | `<工作区>/.pi/audio/` |
| TencentDB 本地运行时数据（历史） | `<应用数据目录>/tencentdb-memory/`（MemoryCore、MemoryKnowledge，Tauri 版） |

## 用量统计口径

`usageService`（`electron-agent/electron/app/usageService.ts`，历史实现为 `tauri-agent/src-tauri/src/commands/usage.rs` 的 `usage_report`）扫描会话 jsonl，只聚合满足以下条件的记录：`type` 为 `message`、`message.role` 为 `assistant`、且带 `usage` 字段，从中累加 input / output / cacheRead / cacheWrite、totalTokens 与 cost，并据此计算 cacheHitRate。

由此可知：生图、TTS 等工具调用以 tool result 形式返回、不带 `usage` 字段，因此其调用量与费用不计入用量统计；统计页是纯 Token 报表。

## 独立模块：本地向量服务（embedding）

`embedding/` 是一个独立的本地向量服务，当前尚未集成进 sidecar 或桌面应用。它在本地 CPU 上用 `@huggingface/transformers` 运行 `Xenova/all-MiniLM-L6-v2`，通过 `POST /embed` 返回 384 维向量，并可用 Node.js SEA 打成单文件可执行程序。

它面向独立的本地向量实验，不属于桌面端记忆链路；桌面端的长期记忆和知识检索由自研 Agent Data Runtime 负责。实现细节见 `embedding/README.md`。
