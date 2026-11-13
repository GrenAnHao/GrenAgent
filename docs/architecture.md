# 架构文档

GrenAgent 的桌面端位于 `electron-agent/`。本文说明当前的进程边界和数据归属；设计取舍见 [决策笔记](../.agents/notes/)，开发命令见 [开发指南](./development.md)。早期 Tauri 版见 Git 标签 `archive/tauri-agent`。

## 总览

```text
React 渲染层
  ↕ window.gren（请求 gren:invoke，事件 gren:event:）
Electron 主进程
  ├─ Node IPC / RpcPeer ↔ agent-host：交互会话、扩展、后台任务
  ├─ Node IPC / RpcPeer ↔ codegraph-host：索引调度、SDK 读写线程
  └─ 进程内 AgentDataRuntime：线程、回合、授权和插件状态

扩展的 code_explore / 工具授权 → 主进程最小扩展端点
```

- **渲染层**：业务组件经 `src/platform/runtime.ts` 使用 `GrenRuntimeBridge`，不直接依赖 Electron。浏览器预览没有 preload 桥时使用 `browserPreviewBridge`。
- **主进程**：管理窗口、桌面 IPC 和两个宿主子进程；供应商测活、提示词增强等短调用由主进程的模型运行时执行。AgentData 在主进程内装配，不再启动 `agentdata-host`。
- **agent-host**：所有工作区共用一个宿主进程。交互和 Goal 使用 Pi SDK；子代理默认在宿主内执行。CLI 或 worker 走进程式子代理后端时，通过 `PI_WORKER_ENTRY` 启动 worker。会话和任务事件经主进程转发给渲染层，包括 `pi://event`、`pi://ui-request`、`pi://exit` 和 `pi://jobs`。
- **codegraph-host**：由主进程持有，独立于 agent-host，负责 CodeGraph SDK、索引查询和同步。宿主退出后由 `CodeGraphHostSupervisor` 恢复，不等待下一次用户查询。

## 模块职责

会话模式为 Agent / Ask / Debug / Plan / Ultra。旧 Brainstorm 会话和项目默认恢复为 Agent。Ultra 使用独立的默认/角色模型与白名单键，共用 SettingsService、供应商目录和子代理执行器；普通模型设置不参与 Ultra 解析。Ultra 规则按主会话模式注入，Ask / Plan 保持工具限制，未确认 Plan 不能手切 Ultra。子会话在元数据中固定 ordinary/ultra 路由域，恢复不随父会话改域；Ultra 历史模型不可用时明确失败，不自动换模。

### cli —— 内嵌 SDK 与 worker 入口

源码仍在 `cli/`（`gren-runtime` / `pi-sdk` / `pi-worker` / `json-event`），由 electron-vite 打进 `out/main/`（`dev` / `start`；打包用的 `build` 写 `out-pkg/main/`，electron-builder 再映射回 asar 里的 `out/main/`），不再产出 `pi.exe`。`pi-worker` 的 `--mode subagent` 经 IPC 托管子会话；`--mode json` 和默认 print 路径交给官方 `main()`。启动期主进程把 `PI_WORKER_ENTRY` 设为 worker chunk 路径，子代理直读该环境变量。

进程退出时，worker 在模块加载阶段注册 `EPIPE` 处理：一旦命中即干净退出，避免对死管道反复写入导致 stderr 刷屏。

### extensions —— 内置扩展包

包名 `pi-extensions-pack`。`extensions/index.ts` 的 `allExtensions` 定义打进 agent-host 子进程 / worker 的工厂，实际加载还要经过 `cli/src/extension-profile.ts`。Electron 的 `builtinPlugins.ts` 注册 `goal`、`web-search`、`mcp`、`code-retrieval`，仅 ready 插件进入白名单；`safety` 和 `auto-title` 保留为内置基础服务。短调用不加载扩展。`extensions/package.json` 的 `pi.extensions` 字段只用于独立安装元数据。桌面端主进程保留 `PiPackageService` 与 `package_*` IPC 管理官方 `settings.packages`：可列出当前会话实际会加载的内置工厂（`filterManagedExtensions(filterExtensionsByProfile(manifestExtensions, profile), allowedPluginIds)`，与 `gren-runtime` 同源；内置清单向 agent-host 子进程要）以及用户 / 项目安装的 Pi Package；市场检索 npm `keywords:pi-package`，安装走 SDK `DefaultPackageManager`，写入后经子进程 `requestResourceReload()`。

扩展通过 `pi.registerTool()` 注册工具、`pi.registerCommand()` 注册斜杠命令。能力类扩展（生图 / TTS）通过共享的 `resolveCapabilityEndpoint` 从模型注册表解析供应商与模型。

#### 内置扩展

| 扩展 | 职责 | 主要工具 / 命令 |
| --- | --- | --- |
| `safety` | 工具调用安全闸：路径保护、危险 bash 拦截、沙箱模式约束 | 策略 / 中间件，无显式工具 |
| `approval` | 审批策略（ask / auto / full）热更新应用与 setStatus | 无 slash；宿主 `agent_set_approval` |
| `loop-guard` | 相同工具调用在第 3/5/8 次追加提醒；不拦截，不限单轮总次数 | 策略 / 中间件，无显式工具 |
| `rulebook` | 声明式规则库（`.pi/rules.jsonc`），工具 / 文本规则拦截与纠正 | `/rules` |
| `compaction-policy` | 超大结果熔断、按压力裁旧工具输出（缓存冷时定案、热时沿用）、压力指示、删任意段、自动压缩 | 无 slash；宿主 `agent_exclude_entry` / `agent_restore_entry` |
| `image-limits` | 输入钩子把超过 2000×2000（或模型 `inputLimits.images.resize`）的新图片缩小，pi 1.3.0 不缩 steer / followUp 的图；请求前 `context` 钩子把历史里仍超限的图在副本里缩小或换成文字 | 策略 / 中间件，无显式工具 |
| `auto-title` | 会话没有名字时，模型第一条回复结束就按首条用户消息生成标题；侧栏「重新生成标题」走主进程 `generate_session_title`，共用同一套输入整理和提示词 | 策略 / 中间件，无显式工具 |
| `todo` | 会话内待办清单 | `todo` |
| `present` | 把已有文件声明为本轮产物 | `present` |
| `agent-mode` | Agent / Ask / Debug / Plan 模式切换；结构化 Plan（`upsert_plan`）与右栏计划面板 | 宿主 `agent_set_mode`（未确认计划时拒绝切到能动手的模式）；面板经 `/plan-update` `/plan-confirm` `/plan-cancel` `/plan-finish` 回写；`ask_user` |
| `debug-tools` | 调试日志工具 | `debug_log` |
| `dap` | Debug Adapter Protocol 调试 | `dap_launch`、`dap_set_breakpoints`、`dap_evaluate` 等 |
| `diagram-hint` | Mermaid / KaTeX 渲染约定提示（隐式注入） | 策略 / 中间件，无显式工具 |
| `fable-behavior` | Fable 5 + coding-agent 行为层（Tier 注入 + 子 agent 种子 + `fable_behavior_ref`） | `fable_behavior_ref` |
| `goal` | 设定会话完成条件并自动驱动 / 判定 | `/goal` |
| `code-retrieval` | 经主进程最小扩展端点查询 codegraph-host | `code_explore` |
| `session-memory` | 带分支锚点的会话工作状态；压缩时一次抽取兼作压缩摘要，交给 Pi 摘要时压缩后重锚 | 内部 `/session-state`（slash 菜单不列） |
| `web-fetch` | 单页 URL 抓取 | `fetch_url`（`format`: markdown / text / html / json / llms） |
| `web-search` | 联网搜索。`web_search` 默认走 Bing，失败再回退搜狗、百度；可用 `WEB_SEARCH_PROVIDER` / `WEB_SEARCH_ENGINES` 指定。另内置 AnySearch（`ANYSEARCH_API_KEY` 可选，匿名走每日免费额度） | `web_search`、`anysearch_search`、`anysearch_sub_domains` |
| `mcp` | 外部 MCP server 工具桥接 | `mcp__<server>__<tool>`（动态） |
| `mcp-policy` | MCP 工具权限策略与审计 | 策略 / 中间件，无显式工具 |
| `image-gen` | 文生图 | `generate_image` |
| `diagnostics` | 环境 / 依赖诊断 | `diagnostics` |
| `multi-agent` | 子代理委派，普通与 Ultra 模型配置分域 | `spawn_agent`、`list_subagent_models` |
| `sandbox` | 自有 bash（对外契约同 pi 1.0.2 内置 bash，不再用 `createBashToolDefinition`）：沙箱 operations（Windows 照 pi 用 Git Bash：settings.json 的 `shellPath`，否则 Program Files 下的 Git、PATH 上的 bash.exe），输出流式进卡片。每次调用都是 `bash-N` job，前台等 `timeout`（默认 120 秒，`BASH_FOREGROUND_TIMEOUT_SEC`），仍在跑就交出已有输出并转后台；`run_in_background: true` 直接返回 id，完整日志写临时文件。无会话或超并发上限时退回不受管前台（timeout 到点杀）。沙箱拒绝和 runner 失败由 operations 作为事实返回（`{ exitCode, sandbox }`），bash 把标记接在输出后、退出码前并放进 `details.sandbox`，后台任务并进结算 detail；被拒后用 `sandbox_permissions` + `justification` 在同一次调用里升权，经用户批准 | `bash` |
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

控制面约定：模式 / 审批 / 删段由桌面 IPC 写 `runtime-settings.json`，扩展 `watchConfig` 应用，不再经假 prompt 或 slash 命令。slash 菜单只保留发生式命令（`/goal`、`/rules`、工作流、技能、前端 `/compact`）。计划面板的 `/plan-*` 命令由面板 `runCommand`（带会话路径）触发，不出现在菜单。

### electron-agent —— 桌面应用（当前主线）

包名 `electron-agent`，包含渲染层、主进程服务和两个宿主子进程。

**渲染层（`electron-agent/src`）：**

- `features/`：按域划分的业务模块——`chat`（对话）、`sessions`（会话 / 项目侧栏）、`usage`（用量）、`settings`（供应商 / 模型）、`dock`（终端 Dock）、`fileExplorer`（Dock「文件管理器」标签：项目文件树 + 多文件标签）、`tools`（工具卡片）、`extensions`（扩展 / 技能）、`codeIndex`（代码索引入口）与 `agentData`（沿用目录名的索引组件）、`workspace`、`context`、`panels`、`subagents`、`visual`、`layout`、`common`、`extensionUi`。
- `stores/`：zustand store 群，`agent.ts` / `agentReducer.ts` 为核心，把 pi 事件流折叠为会话状态。
- `lib/`：主进程能力封装——`pi.ts`（`onPiEvent` / `onPiUiRequest` / `onPiExit`）、`agentData.ts`（代码索引 IPC 封装）等。
- `platform/`：**后端抽象层**。`runtime.ts` 定义 `GrenRuntimeBridge` 并对接 `window.gren`，无 bridge 时降级为 `browserPreviewBridge`，使渲染层可在纯浏览器预览态运行。
- `components/` / `theme/`：通用组件与主题，运行时注入 `--gren-*` CSS 变量。
- 首包只含对话界面。设置 / 扩展 / 用量 / 代码索引 / 开发者工作台面板、终端（xterm）、Mermaid（beautiful-mermaid、elkjs），以及 @lobehub/ui 的 Markdown / 高亮 / diff（经 `src/lib/lobeHeavy.ts` 中转）都按需加载；Markdown 与代码视图的预热在浏览器空闲后进行。

**主进程（`electron-agent/electron`）：**

- `main.ts` / `mainConfig.ts`：创建窗口、装配主进程服务，并管理 agent-host、codegraph-host 和本地数据的生命周期。
- `agentProcess/`：主进程与 agent-host 子进程之间的一层。`rpcPeer.ts` 是对称 RPC（请求 / 响应两个方向 + 单向事件），`contract.ts` 列出两个方向的方法名（`AGENT_METHODS` / `HOST_METHODS`）。`agentProcessClient.ts` 负责拉起（同一份 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE`，不带 V8 参数：生产入口是字节码，参数不同缓存会被拒）、`host.ready` 握手、意外退出时拒绝在途请求并对打开过的工作区广播 `pi://exit`、下一条运行时命令再拉起（60 秒内崩 3 次暂停 30 秒）、关停（`host.shutdown`，10 秒不退就整树杀掉）。`mainBindings.ts` 是主进程这一侧的接线：子进程回调主进程的处理表（解析工作区、扩展端点令牌、MCP 运行配置、`pi.*` 授权、回合入库、带锁合并 `runtime-settings.json`），以及给 IPC 命令和各服务用的转发端口；释放 / 查询类端口只在子进程在跑时转发，不在就给兜底值。子进程每 10 秒报一次内存与事件循环延迟（`runtime-diag.jsonl` 里的 `agent-host-sample`）。`jobGuard.ts` 在 Windows 上为每个 agent-host 启动 `pi-job-guard.exe`（源码 `electron-agent/native/job-guard.c`，预编译入仓，构建时拷到 `out/main`）：把 agent-host 放进一个不允许静默脱离的 Job，agent-host 退出（崩溃、关停或主进程崩溃）后结束 Job 里残留的、没有可见窗口的子孙进程（`agent-host-sweep`）。`hostEntry.ts` 是子进程入口；进程级 `uncaughtException` / `unhandledRejection` 不让进程退出，按 AsyncLocalStorage 归到某个在跑的子代理的交给它按 error 结算（`extensions/_shared/leak-owner.ts`；`unhandledRejection` 等 1 秒，期间被接住的不算），其余只记日志。`runtimeGraph.ts` 在子进程里装配 `AgentHost` / `PiRuntimeService` / `SubagentService` / jobs 桥 / MCP 操作。冒烟脚本 `scripts/agent-host-smoke.mjs` 在临时 HOME 里跑真实子进程。
- `app/`：服务层——`piRuntimeService`（在 agent-host 子进程里运行：`agent_*` 到 `WorkspaceHandle`；模式 / 审批 / 删段经主进程带锁写 runtime config，另含 `rewindTo`）、`workspaceService`、`settingsService`、`mcpConfigService`、`mcpPolicyService`、`usageService`、`gitService`、`fileService`（工作区内的读写与按层列目录，路径一律 realpath 后校验不越界）、`fileWatchService`（文件浏览器展开的目录各开一个非递归 `fs.watch`，合并后经 `files://changed` 推回发起的窗口）、`skillService`、`subagentService`、`uiHistoryService`、`createService`、`providerService` 等；`terminalService`（命令白名单 spawn）与 `shellService`（node-pty 真 PTY）提供终端能力。`jobsBridge` 在 agent-host 子进程里订阅同进程的 jobs 注册表，把后台 job 的状态与输出增量经 `pi://jobs` 广播（100ms 合并，经主进程转发到窗口），另有 `job_snapshot` / `job_kill` 命令；渲染层 `jobLiveStore` 按字节偏移接帧，bash 卡片凭结果 details 里的 `jobId` + `jobStartedAt` 跟随后台输出并可停止。后台任务归启动它的会话（owner = sessionId），没有全局入口；名下有存活任务的会话被切走时 `piRuntimeService` 把它的 handle 停靠在后台（`hasLiveJobs`），任务跑完才释放，否则 `session_shutdown` 会把任务一并取消。前台 bash 也是匿名 job（模型拿不到 id），运行中的 partial 更新把 `details.foregroundJob` 带给界面，卡片据此跟随输出并可单独停止这一条命令。
- `pi/`：事件投影（`eventAdapter`）与短调用壳（`systemWorkerManager`）。
- `agent/`：`WorkspaceHandle`、`AgentHost`、`ModelRuntimeHost`、`SessionUiAdapter`（`ModelRuntimeHost` 两个进程各一份，其余都在 agent-host 子进程里）。同一项目里空闲会话共用前景 handle，用 `switchSession` 换文件；正在跑的会话留在自己的 handle 上，再打开另一个会话不会拆掉它。
- `ipc/`：`contracts.ts` 定义命令与事件通道（`gren:invoke`、`gren:event:`），`register.ts` 注册全量命令（含 `agent_*` 透传与流式 Channel）。
- `preload.ts`：向渲染层暴露 `window.gren`（`invoke` / `subscribe` / 目录选择 / 打开外部 / 窗口控制 / webview 拖放）。
- `webviewSecurity.ts` / `webviewPreload.ts`：对 webview 二次强制 `contextIsolation`、`sandbox`、关闭 `nodeIntegration`，并限制导航与 `window.open`。
- `workerEntry.ts`：解析打包 / 开发态的 `PI_WORKER_ENTRY` 与 agent-host、codegraph-host、codegraph-worker 入口（打包后都从 `app.asar.unpacked/out/main/` 加载）。
- `agentData/`：`assemble.ts` 在主进程内装配 `AgentDataRuntime` 和索引任务执行器；`AgentDataService` 为桌面 IPC 提供进程内调用。运行时保存线程、回合及条目、工具授权和插件状态。Pi 会话历史仍以会话 JSONL 为准。
- `agentData/minimalEndpoint.ts`：对扩展开放本地命名管道（Windows）或 Unix socket。工作区由令牌确定；只接受只读的 `codeRetrieval.call` 和 `permission.tool.evaluate / remember / settle`，不开放索引写入或管理 RPC。

### 代码索引

旧 Wiki 和任务中心已下线。桌面的「代码索引」是独立入口，[CodeIndexWorkspace](../electron-agent/src/features/codeIndex/CodeIndexWorkspace.tsx) 加载 `CodeRetrievalPanel`，沿用 `agentData_code_*` IPC，经主进程查询 `codegraph-host`。Agent 的 `code_explore` 经最小扩展端点访问同一个宿主。界面使用结构化搜索结果、节点和边定位源码及关系。

- **建立与手动同步**：用户显式发起，界面通过 `agentData_jobs_create` 提交 `codegraph.sync`。`CodeGraphJobs` 执行同步，进度与结果写入独立的 `IndexTaskStore`，不写旧的共享任务表。界面轮询索引状态，回到空闲后停止；启动时结算遗留的未终态记录。
- **自动同步**：只维护已有索引。查询会激活工作区的 SDK 文件监听，单独读状态不会。调度器合并同工作区的改动；增量同步期间可查上次提交的索引，全量重建期间返回忙碌。自动同步不创建手动任务，熔断记录写入索引任务库。`GREN_CODEGRAPH_AUTO_SYNC=off` 可关闭自动同步。
- **进程与打包**：`codegraph-host` 默认用一个写线程和独立的读线程；`GREN_CODEGRAPH_READ_WORKERS` 调整读线程数，`GREN_CODEGRAPH_THREADS=off` 切回单线程。SDK 及平台资源随应用分发，不依赖全局 CLI。退出时主进程停止宿主监督，等待 agent-host 退出，再收尾索引任务和数据运行时，最后关闭索引任务库。

### 会话 Goal

Goal 绑在当前 Pi 会话。权威源是会话 JSONL 里 `customType: "goal"` 且带 `kind` 的事件，由 `extensions/goal` 折叠为快照；续跑正文走 `customType: "goal-round"`。完成由本会话工作模型通过 `update_goal(complete|blocked)` 自报，没有独立裁判，也没有 AgentData Goal 表、Coordinator 或 Goal worker。重开默认 `disarmed`；仅当应用设置 `goal.autoContinueOnOpen === "true"` 且阶段为 `active` 时武装。旧 AgentData Goal 不迁移。详见 [Goal 回到 Pi 会话](./superpowers/specs/2026-09-13-goal-on-session-design.md)。

Goal 条和详情抽屉只存在当前会话页的输入区，不建立跨会话的 live Goal 页面。

## IM 接入（暂缓）

微信和 HTTP 网关源码仍保留，当前桌面端不加载，接回说明见 [IM 接入](./im-reintroduction.md)。

## 数据存储

| 数据 | 位置与归属 |
| --- | --- |
| Pi 会话记录 | `<agentDir>/sessions/` 下的 JSONL |
| AgentData（线程、回合、授权、插件） | `<应用数据目录>/agent-data.db`，由主进程内的运行时持有 |
| CodeGraph 项目索引 | `<工作区>/.codegraph/codegraph.db`，由 codegraph-host 使用 |
| 索引任务及熔断记录 | `<应用数据目录>/codegraph/index-tasks.sqlite`，由主进程的 IndexTaskStore 持有 |
| 用量账本 | `<agentDir>/usage/ledger.db` |
| 生成的图片、合成的音频 | `<工作区>/.pi/images/`、`<工作区>/.pi/audio/` |

## 用量统计口径

用量页读取本地账本：助手调用与缓存预热分列，费用区分供应商报告、目录估算和来源未知。外部导入历史可以展示，但不计入本机费用；生图、TTS 等工具结果不算助手模型用量。删除或回退会话不删除已记入的账本记录。归属及补录口径见 [请求观测与用量覆盖](./request-observability.md#用量覆盖)。

## 命令与规则

- **命令**是全局的 Pi prompt template，文件在 `<agentDir>/prompts/<名>.md`。正文里写了 `{参数}` / `{参数=默认值}` 的模板由 `extensions/prompt-commands` 在 `input` 钩子里接管：`/名 "值" …` 展开成 `<command name="…" args="{JSON}">正文</command>`，块后接补充正文；其余模板（包括 `$1` 写法）仍由 Pi 原生展开。语法在 `extensions/prompt-commands/syntax.ts`，扩展、主进程、渲染层共用。`splitArgs` 在双引号内只把 `\"` 和 `\\` 当转义，其它反斜杠原样保留；`findCommandBlocks` 线性扫描。
- 输入框里带参数的命令是 Lexical `CommandPillNode`（`src/features/chat/input/editor/CommandPill/`），只能放在输入开头，且输入框里最多一个：斜杠菜单与粘贴都要求光标 / 斜杠在整个输入开头且当前没有胶囊，不满足时带参数模板不出现在菜单里，粘贴按普通文本处理。胶囊内嵌原生 `<input>`：最后一个参数上 Tab、末尾 →、Esc 跳到胶囊后；第一个参数上 Shift+Tab、开头 ← 不动；离开胶囊时先 focus 编辑器根节点再移动选区；胶囊内 Ctrl/Cmd+Enter 透传 interrupt。
- markdown 写出时胶囊写私用区字符 U+E000。发送和存草稿时由 `readComposerText` 把标记换成调用文本，调用文本总在最前，标记前后的正文各自 trim 后用一个空格接在后面。气泡由 `messageTags.tsx` 把 `<command>` 块还原成只读胶囊，不显示正文。
- **规则**一条一个 Markdown 文件：全局 `<agentDir>/rules/*.md`，项目 `<工作区>/.pi/rules/*.md`，frontmatter 有 `title`、`enabled` 和可选的 `modes`（缺省/空值适用所有模式，显式未知模式报错）。`extensions/context-rules` 在每次 `before_agent_start` 把启用的规则追加到 `systemPromptOptions.contextFiles`（全局在前、项目在后，同范围按文件名），按文件 mtime 缓存。读文件失败（如 Windows 上的 EBUSY）不缓存，下一轮重试；YAML 解析错误按 mtime 缓存，日志去重。子代理同样加载。
- 主进程 `PromptLibraryService` 负责读写两类文件，原子写的临时文件名用 `randomUUID`，规则 id 冲突按大小写不敏感判断。IPC 命令：`list_prompt_commands` / `save_prompt_command` / `delete_prompt_command` / `list_context_rules` / `save_context_rule` / `set_context_rule_enabled` / `delete_context_rule`；开关不存在的规则返回「规则不存在」。管理界面是扩展面板的「命令」「规则」页签；命令改动通过 `PI_RELOAD_REV` 让会话重载，规则改动下一轮生效。
