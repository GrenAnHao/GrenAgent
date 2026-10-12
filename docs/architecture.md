# 架构文档

本文介绍 GrenAgent 的整体架构、模块职责与运行时数据流。面向需要理解或参与开发的工程师。本文只写**事实**——系统当前如何运转；改动背后的取舍与「为什么」见 [`decisions/`](decisions/README.md)。

> **桌面端主线是 Electron。** `electron-agent/` 为当前实现。历史 Tauri 版（`tauri-agent/`，Tauri 2 + Rust）已于 2026-09-13 封存并从工作区移除，完整快照见 git 标签 `archive/tauri-agent`；文中涉及 Tauri 的段落均标注为历史，仅作迁移对照。桌面能力从 Tauri command 迁移到 Electron 的收口点见 `electron-agent/docs/tauri-api-inventory.md`。

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
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  主进程：ModelRuntime（短调用）                            │
│    │ Node IPC（RpcPeer，结构化克隆）                         │
│    ▼                                                     │
│  agent-host 子进程（ELECTRON_RUN_AS_NODE，所有工作区共用）     │
│    → AgentSessionRuntime / ModelRuntime（交互、Goal）        │
│    → 全部扩展、MCP 管理器、后台 job、进程内子代理               │
│    → spawn(process.execPath, [PI_WORKER_ENTRY])          │
│      + ELECTRON_RUN_AS_NODE（worktree 隔离的子代理）         │
└────────────────────────────────────────────────────────┘
```

- **请求**：渲染层通过 `window.gren.invoke(command, args)` 调用主进程，走单业务通道 `gren:invoke`（`electron/ipc/contracts.ts` 定义、按命令名分发）。运行时命令（`agent_*`、子代理、后台 job、MCP 热重载与探测）由主进程原样转发给 agent-host 子进程。
- **流式回传**：Agent 运行过程中的事件（`agent_start` / `message_start` / `message_delta` / `agent_end` 等）在 agent-host 子进程里产生，经 IPC 的 `broadcast` 事件交给主进程，主进程 `broadcastPiEvent` 广播到所有窗口（`pi://event`、`pi://ui-request`、`pi://exit`、`pi://jobs`，统一 `gren:event:` 前缀）。
- **执行**：Pi SDK 跑在 agent-host 子进程里。交互与 Goal 走 `AgentSessionRuntime`；主进程的短调用（记忆、知识库、增强提示词、测活）走主进程自己的 `ModelRuntime.completeSimple`；需要 worktree 隔离的子代理由子进程 `spawn(process.execPath, [PI_WORKER_ENTRY])` 并设 `ELECTRON_RUN_AS_NODE=1`。
- **隔离**：业务代码只依赖 `src/platform/runtime.ts` 定义的 `GrenRuntimeBridge`，不直接引用 Electron；无 bridge 时自动降级为浏览器预览实现。

## 模块职责

### cli —— 内嵌 SDK 与 worker 入口

源码仍在 `cli/`（`gren-runtime` / `pi-sdk` / `pi-worker` / `json-event`），由 electron-vite 打进 `out/main/`，不再产出 `pi.exe`。`pi-worker` 只跑官方 `main()` 的 `--mode json` / print 路径；启动期主进程把 `PI_WORKER_ENTRY` 设为 worker chunk 路径，子代理直读该环境变量。

进程退出时，worker 在模块加载阶段注册 `EPIPE` 处理：一旦命中即干净退出，避免对死管道反复写入导致 stderr 刷屏。

### extensions —— 内置扩展包

包名 `pi-extensions-pack`。`extensions/index.ts` 的 `allExtensions` 定义打进 agent-host 子进程 / worker 的工厂，实际加载还要经过 `cli/src/extension-profile.ts`。Electron 的 `builtinPlugins.ts` 注册 `goal`、`web-search`、`mcp`、`memory`、`wiki-rag`、`code-retrieval`，仅 ready 插件进入白名单；`safety` 和 `auto-title` 保留为内置基础服务。短调用不加载扩展。`extensions/package.json` 的 `pi.extensions` 字段只用于独立安装元数据。桌面端主进程保留 `PiPackageService` 与 `package_*` IPC 管理官方 `settings.packages`（渲染层已无扩展页签，没有入口调用）：可列出当前会话实际会加载的内置工厂（`filterManagedExtensions(filterExtensionsByProfile(manifestExtensions, profile), allowedPluginIds)`，与 `gren-runtime` 同源；内置清单向 agent-host 子进程要）以及用户 / 项目安装的 Pi Package；市场检索 npm `keywords:pi-package`，安装走 SDK `DefaultPackageManager`，写入后经子进程 `requestResourceReload()`。

扩展通过 `pi.registerTool()` 注册工具、`pi.registerCommand()` 注册斜杠命令。能力类扩展（生图 / TTS / Embedding）通过共享的 `resolveCapabilityEndpoint` 从模型注册表解析供应商与模型。

#### 内置扩展

| 扩展 | 职责 | 主要工具 / 命令 |
| --- | --- | --- |
| `safety` | 工具调用安全闸：路径保护、危险 bash 拦截、沙箱模式约束 | 策略 / 中间件，无显式工具 |
| `approval` | 审批策略（ask / auto / full）热更新应用与 setStatus | 无 slash；宿主 `agent_set_approval` |
| `loop-guard` | 相同工具调用在第 3/5/8 次追加提醒；不拦截，不限单轮总次数 | 策略 / 中间件，无显式工具 |
| `rulebook` | 声明式规则库（`.pi/rules.jsonc`），工具 / 文本规则拦截与纠正 | `/rules` |
| `compaction-policy` | 超大结果熔断、按压力裁旧工具输出（缓存冷时定案、热时沿用）、压力指示、删任意段、自动压缩 | 无 slash；宿主 `agent_exclude_entry` / `agent_restore_entry` |
| `auto-title` | 首轮结束后自动生成会话标题 | 策略 / 中间件，无显式工具 |
| `todo` | 会话内待办清单 | `todo` |
| `present` | 把已有文件声明为本轮产物 | `present` |
| `agent-mode` | Agent / Ask / Debug / Plan 模式切换与 Plan 卡片 | 宿主 `agent_set_mode`；卡片仍用 `/plan-build`；`ask_user` |
| `debug-tools` | 调试日志工具 | `debug_log` |
| `dap` | Debug Adapter Protocol 调试 | `dap_launch`、`dap_set_breakpoints`、`dap_evaluate` 等 |
| `diagram-hint` | Mermaid / KaTeX 渲染约定提示（隐式注入） | 策略 / 中间件，无显式工具 |
| `fable-behavior` | Fable 5 + coding-agent 行为层（Tier 注入 + 子 agent 种子 + `fable_behavior_ref`） | `fable_behavior_ref` |
| `goal` | 设定会话完成条件并自动驱动 / 判定 | `/goal` |
| `memory` | AgentData 分层记忆、自动召回及活动分支会话捕获 | `memory_search`、`conversation_search` |
| `wiki-rag` | TencentDB 风格 Wiki 只读检索（列出 / 检索 / 阅读） | `wiki_list`、`wiki_read`、`wiki_search` |
| `code-retrieval` | 经 AgentData 复用主进程内置 CodeGraph SDK 实例 | `code_explore` |
| `session-memory` | 带分支锚点的会话工作状态；压缩时一次抽取兼作压缩摘要，交给 Pi 摘要时压缩后重锚 | 内部 `/session-state`（slash 菜单不列） |
| `web-fetch` | 单页 URL 抓取 | `fetch_url`（`format`: markdown / text / html / json / llms） |
| `web-search` | 多引擎联网搜索。Devin 登录有效且未指定引擎链时，`web_search` 先走 Devin，失败再回退 Bing、搜狗、百度。`devin_code_search` 把查询和选中片段发往 Windsurf | `web_search`、`web_search_multi`、`devin_code_search` |
| `mcp` | 外部 MCP server 工具桥接 | `mcp__<server>__<tool>`（动态） |
| `mcp-policy` | MCP 工具权限策略与审计 | 策略 / 中间件，无显式工具 |
| `image-gen` | 文生图 | `generate_image` |
| `diagnostics` | 环境 / 依赖诊断 | `diagnostics` |
| `multi-agent` | 子代理委派 | `spawn_agent` |
| `sandbox` | 自有 bash（对外契约同 pi 1.0.2 内置 bash，不再用 `createBashToolDefinition`）：沙箱 operations（Windows 走 PowerShell），输出流式进卡片。每次调用都是 `bash-N` job，前台等 `timeout`（默认 120 秒，`BASH_FOREGROUND_TIMEOUT_SEC`），仍在跑就交出已有输出并转后台；`run_in_background: true` 直接返回 id，完整日志写临时文件。无会话或超并发上限时退回不受管前台（timeout 到点杀）。沙箱拒绝和 runner 失败由 operations 作为事实返回（`{ exitCode, sandbox }`），bash 把标记接在输出后、退出码前并放进 `details.sandbox`，后台任务并进结算 detail；被拒后用 `sandbox_permissions` + `justification` 在同一次调用里升权，经用户批准 | `bash` |
| `jobs` | 进程内后台 job 注册表（语义移植自 DSH jobs / jobs-local / tool-jobs）：每个 job 一个有界输出环（运行期 256KB、结算后 16KB），拉取源每 150ms 泵入；模型按消耗式游标读，`readAt` 非消耗；每个会话最多 10 个存活 job；结算发 `job-done` 通知，等待已收走、模型自己 `job_kill`、会话销毁的不发。`onEvent` 供宿主跟随，`observer.ts` 把事件合并成帧 | `job_output`、`job_list`、`job_kill` |
| `lsp` | 语言服务器：定义 / 引用 / 悬停等 | `lsp_definition`、`lsp_references` 等 |
| `ast-tools` | AST 结构化搜索与编辑 | `ast_grep`、`ast_edit` |
| `github` | GitHub CLI 封装 | `github` |
| `batch-tools` | 批量读文件与工作区搜索 | `read_files`、`search` |
| `code-exec` | 持久 Python / JavaScript 执行环境 | `py_run`、`js_run` |
| `hashline` | 行号锚点读写与编辑 | `hl_read`、`hl_edit` |
| `tts` | 语音合成 | `speak` |
| `im-gateway` | HTTP webhook IM 网关（Slack / Feishu 等适配） | 暂缓加载；内部状态命令不进 slash |
| `im-platforms` | 微信 ilink bot 接入，隔离式远程遥控 | 暂缓加载；内部状态命令不进 slash |

控制面约定：模式 / 审批 / 删段由桌面 IPC 写 `runtime-settings.json`，扩展 `watchConfig` 应用，不再经假 prompt 或 slash 命令。slash 菜单只保留发生式命令（`/goal`、`/rules`、工作流、技能、前端 `/compact`）。`/plan-build` 仍由计划卡片 `runCommand` 触发，但不出现在菜单。

### electron-agent —— 桌面应用（当前主线）

包名 `electron-agent`，由渲染层、主进程服务层与自研 Agent Data Runtime 组成。

**渲染层（`electron-agent/src`）：**

- `features/`：按域划分的业务模块——`chat`（对话）、`sessions`（会话 / 项目侧栏）、`connections`（IM 接入 / 微信）、`usage`（用量）、`settings`（供应商 / 模型）、`dock`（终端 Dock）、`fileExplorer`（Dock「文件」标签里的项目文件浏览器）、`tools`（工具卡片）、`extensions`（扩展 / 技能）、`agentData`（记忆与知识资产）、`workspace`、`context`、`panels`、`subagents`、`visual`、`layout`、`common`、`extensionUi`。
- `stores/`：zustand store 群，`agent.ts` / `agentReducer.ts` 为核心，把 pi 事件流折叠为会话状态。
- `lib/`：主进程能力封装——`pi.ts`（`onPiEvent` / `onPiUiRequest` / `onPiExit`）、`agentData.ts`（记忆与 Wiki API）等。
- `platform/`：**后端抽象层**。`runtime.ts` 定义 `GrenRuntimeBridge` 并对接 `window.gren`，无 bridge 时降级为 `browserPreviewBridge`，使渲染层可在纯浏览器预览态运行。
- `components/` / `theme/`：通用组件与主题，运行时注入 `--gren-*` CSS 变量。
- 首包只含对话界面。设置 / 连接 / 扩展 / 用量 / Agent 数据 / 开发者工作台面板、终端（xterm）、Mermaid（beautiful-mermaid、elkjs），以及 @lobehub/ui 的 Markdown / 高亮 / diff（经 `src/lib/lobeHeavy.ts` 中转）都按需加载；Markdown 与代码视图的预热在浏览器空闲后进行。

**主进程（`electron-agent/electron`）：**

- `main.ts` / `mainConfig.ts`：窗口创建与生命周期。`whenReady` 内构造 `ModelRuntimeHost`（短调用）、启动 Agent Data Runtime、拉起 agent-host 子进程（`AgentProcessClient`），`before-quit` 先关子进程、再停 Agent Data。主进程不静态引入 `extensions/**` 的运行时模块。
- `agentProcess/`：主进程与 agent-host 子进程之间的一层。`rpcPeer.ts` 是对称 RPC（请求 / 响应两个方向 + 单向事件），`contract.ts` 列出两个方向的方法名（`AGENT_METHODS` / `HOST_METHODS`）。`agentProcessClient.ts` 负责拉起（同一份 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE`，不带 V8 参数：生产入口是字节码，参数不同缓存会被拒）、`host.ready` 握手、意外退出时拒绝在途请求并对打开过的工作区广播 `pi://exit`、下一条运行时命令再拉起（60 秒内崩 3 次暂停 30 秒）、关停（`host.shutdown`，10 秒不退就整树杀掉）。`mainBindings.ts` 是主进程这一侧的接线：子进程回调主进程的处理表（解析工作区、AgentData 令牌、MCP 运行配置、`pi.*` 授权、回合入库、带锁合并 `runtime-settings.json`），以及给 IPC 命令和各服务用的转发端口；释放 / 查询类端口只在子进程在跑时转发，不在就给兜底值。子进程每 10 秒报一次内存与事件循环延迟（`runtime-diag.jsonl` 里的 `agent-host-sample`）。`jobGuard.ts` 在 Windows 上为每个 agent-host 启动 `pi-job-guard.exe`（源码 `electron-agent/native/job-guard.c`，预编译入仓，构建时拷到 `out/main`）：把 agent-host 放进一个不允许静默脱离的 Job，agent-host 退出（崩溃、关停或主进程崩溃）后结束 Job 里残留的、没有可见窗口的子孙进程（`agent-host-sweep`）。`hostEntry.ts` 是子进程入口，`runtimeGraph.ts` 在子进程里装配 `AgentHost` / `PiRuntimeService` / `SubagentService` / jobs 桥 / MCP 操作。冒烟脚本 `scripts/agent-host-smoke.mjs` 在临时 HOME 里跑真实子进程。
- `app/`：服务层——`piRuntimeService`（在 agent-host 子进程里运行：`agent_*` 到 `WorkspaceHandle`；模式 / 审批 / 删段经主进程带锁写 runtime config，另含 `rewindTo`）、`workspaceService`、`settingsService`、`mcpConfigService`、`mcpPolicyService`、`usageService`、`gitService`、`fileService`（工作区内的读写与按层列目录，路径一律 realpath 后校验不越界）、`fileWatchService`（文件浏览器展开的目录各开一个非递归 `fs.watch`，合并后经 `files://changed` 推回发起的窗口）、`skillService`、`subagentService`、`uiHistoryService`、`createService`、`providerService` 等；`terminalService`（命令白名单 spawn）与 `shellService`（node-pty 真 PTY）提供终端能力。`jobsBridge` 在 agent-host 子进程里订阅同进程的 jobs 注册表，把后台 job 的状态与输出增量经 `pi://jobs` 广播（100ms 合并，经主进程转发到窗口），另有 `job_snapshot` / `job_kill` 命令；渲染层 `jobLiveStore` 按字节偏移接帧，bash 卡片凭结果 details 里的 `jobId` + `jobStartedAt` 跟随后台输出并可停止。后台任务归启动它的会话（owner = sessionId），没有全局入口；名下有存活任务的会话被切走时 `piRuntimeService` 把它的 handle 停靠在后台（`hasLiveJobs`），任务跑完才释放，否则 `session_shutdown` 会把任务一并取消。前台 bash 也是匿名 job（模型拿不到 id），运行中的 partial 更新把 `details.foregroundJob` 带给界面，卡片据此跟随输出并可单独停止这一条命令。
- `pi/`：事件投影（`eventAdapter`）与短调用壳（`systemWorkerManager`）。
- `agent/`：`WorkspaceHandle`、`AgentHost`、`ModelRuntimeHost`、`SessionUiAdapter`（`ModelRuntimeHost` 两个进程各一份，其余都在 agent-host 子进程里）。同一项目里空闲会话共用前景 handle，用 `switchSession` 换文件；正在跑的会话留在自己的 handle 上，再打开另一个会话不会拆掉它。
- `ipc/`：`contracts.ts` 定义命令与事件通道（`gren:invoke`、`gren:event:`），`register.ts` 注册全量命令（含 `agent_*` 透传与流式 Channel）。
- `preload.ts`：向渲染层暴露 `window.gren`（`invoke` / `subscribe` / 目录选择 / 打开外部 / 窗口控制 / webview 拖放）。
- `webviewSecurity.ts` / `webviewPreload.ts`：对 webview 二次强制 `contextIsolation`、`sandbox`、关闭 `nodeIntegration`，并限制导航与 `window.open`。
- `workerEntry.ts`：解析打包 / 开发态的 `PI_WORKER_ENTRY` 与 agent-host 入口（打包后都从 `app.asar.unpacked/out/main/` 加载）。

**Agent Data Runtime（`electron-agent/electron/agentData`）：**

自研的本地数据运行时，取代历史版本随包分发的 TencentDB 托管服务。启动后在 `127.0.0.1` 随机端口提供 JSONL RPC（`randomBytes(32)` token 鉴权），数据落在 `<应用数据目录>/agent-data.db`（`node:sqlite`）：

- `memoryStore`：分级记忆和活动分支会话捕获，按来源合并提炼任务并保留未提交增量。`memory_search` 查询提炼后的记忆；`conversation_search` 查询已捕获会话的片段。L1 限来源项目，L2/L3 沿用全局作用域。
- `wikiEngine`：每个知识库为 `<应用数据目录>/wiki/<wikiId>/`（原文 `raw/sources/`、生成页 `wiki/`、库内 `index.db`）；库状态在 `wiki_assets`（`draft` / `pending` / `processing` / `ready` / `failed`）。只有 `processing` 拒绝写入；工作台可 `resetDraft`。抽取在进程内队列完成，不建 `wiki.*` 系统任务。Agent 仅 `wiki_list` / `wiki_search` / `wiki_read`。
- `jobStore`：任务、配置（version 乐观锁）与审计，支持导出 / 导入 / 诊断。
- 代码检索通过主进程 `CodeGraphService` / `CodeGraphEngine` 内置的 CodeGraph 1.6.0 SDK 执行，不启动 CodeGraph CLI/MCP，不再读取 `GREN_CODEGRAPH_COMMAND`。实例按工作区共享，空闲 15 分钟关闭；查询与同工作区索引写入互斥。`codeRetrieval.call` 仅允许只读查询工具，参数与 CodeGraph 1.6.0 SDK 查询面对齐，缺少索引时不自动创建；GUI 使用版本化结构化行、节点与边，Agent 直接读取同一响应的文本。
- `CodeGraphJobs` 把 SDK 的真实阶段接入现有任务系统。未知或不一致的进度数量不转换成百分比。只有用户显式建立/同步才写索引，不启用 SDK watcher；取消先发信号、等 SDK 安全结束再落终态，退出等待任务记录完成后关闭 AgentData。
- SDK 是固定版本的应用依赖，保留 Rust 内核与 WASM 语法。`asarUnpack` 解出 SDK，`scripts/package-codegraph.cjs` 补齐平台包自带且被 builder 过滤的 `lib/node_modules`；加载器使用物理解包路径保证 worker、WASM 和原生模块可访问。没有平台包时报告安装包问题，不回退到全局 CLI 或在线安装。

#### 会话 Goal

Goal 绑在当前 Pi 会话。权威源是会话 JSONL 里 `customType: "goal"` 且带 `kind` 的事件，由 `extensions/goal` 折叠为快照；续跑正文走 `customType: "goal-round"`。完成由本会话工作模型通过 `update_goal(complete|blocked)` 自报，没有独立裁判，也没有 AgentData Goal 表、Coordinator 或 Goal worker。重开默认 `disarmed`；仅当应用设置 `goal.autoContinueOnOpen === "true"` 且阶段为 `active` 时武装。旧 AgentData Goal 不迁移。详见 [Goal 回到 Pi 会话](./superpowers/specs/2026-09-13-goal-on-session-design.md)。

Goal 条和详情抽屉只存在当前会话页的输入区，不建立跨会话的 live Goal 页面。

运行时启动后主进程自连，同时把 endpoint 以 `AGENT_DATA_ENDPOINT` 注入 ALS / 子代理 env，扩展可反向调用记忆与 Wiki 能力。

记忆提炼共用 `TaskQueue` 的系统任务通道；Wiki 抽取走进程内串行队列与 Electron 模型短调用，不再创建 `wiki.ingest` / `wiki.sync` 任务。`SystemWorkerManager` 经 `ModelRuntime.completeSimple` 做串行短调用，不持有会话。自动记忆遵守 `MEMORY_AUTO_INJECT`、`MEMORY_AUTO_CAPTURE`、`MEMORY_EXTRACT`，子代理和系统 worker 不触发自动记忆流程。大请求采用 64 KiB 分片，单物理帧上限 1 MiB，单逻辑请求上限 32 MiB；超限明确失败，不裁剪会话尾部代替全文。

部分命令直接读取本地数据，例如 `usageService` 扫描会话 jsonl 聚合用量。侧栏会话列表（`WorkspaceService.listAllSessions` / `listSessions`）按字节标记只解码标题、首条用户消息、子代理与旧短调用标记所在的行，并按文件大小和修改时间缓存每份会话的解析结果，文件没变时只做一次 `stat`。

### tauri-agent —— 桌面应用（已封存）

> 已于 2026-09-13 封存并从工作区移除：完整快照见 git 标签 `archive/tauri-agent`（`git checkout archive/tauri-agent -- tauri-agent` 可取回）。以下为历史结构，仅供迁移对照，参见 [`electron-agent/docs/tauri-api-inventory.md`](../electron-agent/docs/tauri-api-inventory.md)。

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

- 扫码登录、长轮询收发，无需公网；启用开关与网络配置均热更新（写盘后运行时重连，无需重启）。
- 运行状态经 `setStatus("wechat", ...)`、会话镜像经 `setStatus("wechat-messages", ...)` 从主进程扩展状态推送到前端。
- 前端 `ExtensionUiHost`（`electron-agent/src/features/extensionUi`）接收后写入 `wechatStatusStore` / `imMessagesStore`，由「连接」面板 `ConnectionsPanel` 展示登录二维码、状态与只读会话镜像。
- 主人自己的交互式会话与微信流量隔离，因此桌面 UI 的「微信会话记录」是唯一能看到微信聊了什么的地方。

## 记忆与知识运行时

当前桌面端（Electron）使用自研 **Agent Data Runtime**（见上文 `electron-agent/electron/agentData`）：随主进程启动，数据在 `<应用数据目录>/agent-data.db` 本地落盘（`node:sqlite`），提供 L0-L3 分级记忆与 Wiki FTS5 检索；运行时 endpoint 以 `AGENT_DATA_ENDPOINT` 注入 ALS 与子代理环境，扩展可反向调用。

> **历史（Tauri 版，已过时）**：桌面端通过 Tauri 生命周期托管随安装包分发的 Node.js、MemoryCore 和 MemoryKnowledge。`local` 模式在应用启动时启动两个回环服务并等待 `/health`，自动初始化固定的单用户身份 `local / personal-local / pi-personal`，退出时由进程守卫回收；`remote` 模式不创建本机子进程，只连接配置的 HTTPS Gateway，并允许使用服务端已有 Team、Agent 和 User 身份。远程 Gateway API Key 与 User Key 分别保存在系统凭据库。Pi sidecar 启动后立即把两项 TencentDB 密钥移入模块私有内存并从工具子进程环境删除；知识工具通过仅获得专用 token 的 MemoryKnowledge MCP 注入。

## 数据存储

| 数据 | 位置 |
| --- | --- |
| 会话记录 | `~/.pi/agent/sessions/*.jsonl` |
| Agent Data（记忆 / Wiki / 任务与审计） | `<应用数据目录>/agent-data.db`（Electron 主进程托管） |
| Wiki 正文与库内索引 | `<应用数据目录>/wiki/<wikiId>/`（`wiki/`、`raw/sources/`、`index.db`），参见 [Wiki 使用说明](./agent-data-wiki.md) |
| 生成的图片 | `<工作区>/.pi/images/` |
| 合成的音频 | `<工作区>/.pi/audio/` |
| TencentDB 本地运行时数据（历史） | `<应用数据目录>/tencentdb-memory/`（MemoryCore、MemoryKnowledge，Tauri 版） |

## 用量统计口径

`usageService`（`electron-agent/electron/app/usageService.ts`，历史实现为 `tauri-agent/src-tauri/src/commands/usage.rs` 的 `usage_report`）扫描会话 jsonl，只聚合满足以下条件的记录：`type` 为 `message`、`message.role` 为 `assistant`、且带 `usage` 字段，从中累加 input / output / cacheRead / cacheWrite、totalTokens 与 cost，并据此计算 cacheHitRate。

由此可知：生图、TTS 等工具调用以 tool result 形式返回、不带 `usage` 字段，因此其调用量与费用不计入用量统计；统计页是纯 Token 报表。

## 独立模块：本地向量服务（embedding）

`embedding/` 是一个独立的本地向量服务，当前尚未集成进桌面应用。它在本地 CPU 上用 `@huggingface/transformers` 运行 `Xenova/all-MiniLM-L6-v2`，通过 `POST /embed` 返回 384 维向量，并可用 Node.js SEA 打成单文件可执行程序。

它面向独立的本地向量实验，不属于桌面端记忆链路；桌面端的长期记忆和知识检索由自研 Agent Data Runtime 负责。实现细节见 `embedding/README.md`。

## 命令与规则

- **命令**是全局的 Pi prompt template，文件在 `<agentDir>/prompts/<名>.md`。正文里写了 `{参数}` / `{参数=默认值}` 的模板由 `extensions/prompt-commands` 在 `input` 钩子里接管：`/名 "值" …` 展开成 `<command name="…" args="{JSON}">正文</command>`，块后接补充正文；其余模板（包括 `$1` 写法）仍由 Pi 原生展开。语法在 `extensions/prompt-commands/syntax.ts`，扩展、主进程、渲染层共用。`splitArgs` 在双引号内只把 `\"` 和 `\\` 当转义，其它反斜杠原样保留；`findCommandBlocks` 线性扫描。
- 输入框里带参数的命令是 Lexical `CommandPillNode`（`src/features/chat/input/editor/CommandPill/`），只能放在输入开头，且输入框里最多一个：斜杠菜单与粘贴都要求光标 / 斜杠在整个输入开头且当前没有胶囊，不满足时带参数模板不出现在菜单里，粘贴按普通文本处理。胶囊内嵌原生 `<input>`：最后一个参数上 Tab、末尾 →、Esc 跳到胶囊后；第一个参数上 Shift+Tab、开头 ← 不动；离开胶囊时先 focus 编辑器根节点再移动选区；胶囊内 Ctrl/Cmd+Enter 透传 interrupt。
- markdown 写出时胶囊写私用区字符 U+E000。发送和存草稿时由 `readComposerText` 把标记换成调用文本，调用文本总在最前，标记前后的正文各自 trim 后用一个空格接在后面。气泡由 `messageTags.tsx` 把 `<command>` 块还原成只读胶囊，不显示正文。
- **规则**一条一个 Markdown 文件：全局 `<agentDir>/rules/*.md`，项目 `<工作区>/.pi/rules/*.md`，frontmatter 有 `title` 和 `enabled`。`extensions/context-rules` 在每次 `before_agent_start` 把启用的规则追加到 `systemPromptOptions.contextFiles`（全局在前、项目在后，同范围按文件名），按文件 mtime 缓存。读文件失败（如 Windows 上的 EBUSY）不缓存，下一轮重试；YAML 解析错误按 mtime 缓存，日志去重。子代理同样加载。
- 主进程 `PromptLibraryService` 负责读写两类文件，原子写的临时文件名用 `randomUUID`，规则 id 冲突按大小写不敏感判断。IPC 命令：`list_prompt_commands` / `save_prompt_command` / `delete_prompt_command` / `list_context_rules` / `save_context_rule` / `set_context_rule_enabled` / `delete_context_rule`；开关不存在的规则返回「规则不存在」。管理界面是扩展面板的「命令」「规则」页签；命令改动通过 `PI_RELOAD_REV` 让会话重载，规则改动下一轮生效。
