---
title: 交互 Agent 运行时从 Electron 主进程搬进单独的 agent-host 子进程
status: active
date: 2026-10-09
scope: electron-agent
files:
  - electron-agent/electron/agentProcess/rpcPeer.ts
  - electron-agent/electron/agentProcess/agentProcessClient.ts
  - electron-agent/electron/agentProcess/hostEntry.ts
  - electron-agent/electron/agentProcess/runtimeGraph.ts
  - electron-agent/electron/agentProcess/mainBindings.ts
  - electron-agent/electron/main.ts
  - electron-agent/electron/ipc/register.ts
  - electron-agent/electron.vite.config.ts
  - electron-agent/electron-builder.yml
supersedes:
superseded_by:
---

## 背景

2026-09-11 起交互 Agent 内嵌在 Electron 主进程（`docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design.md`）。之后建运行时、加载扩展、MCP 连接与工具注册、子代理流式快照都跑在主线程上。`runtime-diag.jsonl` 记到主进程事件循环最长卡 8.2 秒；开关一台 MCP 时 `upsert_mcp_config` 单条 5.98 秒，同时段事件循环延迟 5.6 秒；首次打开会话加载 MCP 时窗口直接「未响应」。主进程卡住时窗口、IPC、权限弹窗一起停。此前 `2026-10-03-main-process-heap.md`、`2026-10-04-runtime-diag-log.md`、`extensions/2026-10-04-permission-channel-timeout.md` 处理的都是同一根源的症状。

## 决定

主进程启动后 spawn 一个 agent-host 子进程：同一份 Electron 可执行文件，`ELECTRON_RUN_AS_NODE=1`，`stdio: ['ignore','pipe','pipe','ipc']`，`serialization: 'advanced'`，不带任何 V8 参数。所有工作区共用这一个子进程。

- 不带 V8 参数：生产构建的入口是字节码，V8 的代码缓存里记着编译时的参数指纹，加载时参数不同，整份缓存被拒（实测带 `--max-old-space-size=4096` 加载时 `cachedDataRejected` 为真），子进程第一条 `require` 就抛错。RunAsNode 下默认老生代上限按物理内存算，16GB 以上的机器就是 4096MB。

- 子进程原样运行原来主进程里的那一层：`AgentHost` / `WorkspaceHandle` / `PiRuntimeService` / `SubagentService` / jobs 桥 / MCP 管理器 / 审批与模式表 / 自动标题。这些文件不挪位置，只改由 `agentProcess/runtimeGraph.ts` 装配。
- 主进程只留窗口、IPC 分发、设置、AgentData（sqlite + TCP）、权限弹窗、CodeGraph、短调用用的 `ModelRuntimeHost`、终端 / git / 文件等与运行时无关的服务。主进程不再静态引入 `extensions/**` 的运行时模块。
- 两进程之间是一条对称 RPC（`rpcPeer.ts`）：请求 / 响应两个方向都有，另有单向事件。
  - 主 → 子：渲染层的 `agent_*` 等运行时命令按原参数转发，返回形状不变；另有 MCP 热重载 / 探测、会话释放、子代理收口、扩展清单、资源重载、关停。
  - 子 → 主：`broadcast`（`pi://event` / `pi://ui-request` / `pi://exit` / `pi://jobs`，主进程原样推给窗口），以及子进程需要主进程资源的几处回调：解析工作区、AgentData 令牌、MCP 运行配置、允许的扩展、`pi.*` 命令授权、回合入库、带锁合并 `runtime-settings.json`。
- 扩展到主进程的反向调用（权限、MCP 状态、记忆、知识库、代码检索）照旧走 AgentData TCP。主进程处理 `mcp.state.publish` 时向子进程查 cwd 对应的工作区。
- 拆开后不能再跨进程读的进程内状态，改为显式传递：
  - `ToolDecisionService` 不再读主进程的审批档表（主进程这份已经是空的），改信 safety 扩展在子进程里现读的 `preset`。
  - `PermissionManager.resolveProfile` 改成可异步，向子进程查会话的权限档。
  - `PiRuntimeService` 写 `runtime-settings.json` 走主进程的文件锁，不再在子进程里直接写。
  - `PiPackageService` 的内置扩展清单向子进程要，主进程不为它加载全部扩展。
- 生命周期：
  - 子进程装配完发 `host.ready`。
  - 主进程退出时发 `host.shutdown`，等 10 秒，不退就整树杀掉。子进程收尾时等每个 MCP 连接关完再退出。
  - 主进程断开时子进程自己收尾退出。
  - 子进程意外退出时，主进程拒绝在途请求，对打开过的工作区广播 `pi://exit`，下一条运行时命令再拉起；60 秒内连续崩 3 次就停 30 秒再允许拉起。
  - 释放 / 查询类调用（关工作区、释放会话、子代理收口、权限档、MCP 热重载、后台任务快照）只在子进程在跑时转发，不在就直接给兜底值。子进程不在时没有活着的东西可释放，删会话不该因为子进程在冷却而失败，也不该为此拉起子进程。
  - 子进程每 10 秒报一次自己的内存与事件循环延迟，主进程写进 `runtime-diag.jsonl`（`agent-host-sample`）；退出记 `agent-host-exit`，带 stderr 尾巴。
- 子进程启动后删掉自己 `process.env` 里的 `ELECTRON_RUN_AS_NODE`，否则 bash、MCP 服务器这些孙进程里再启动的 Electron 应用（VS Code 等）都会被当成 Node 跑。子代理 worker 照旧在 spawn 时显式带上这个变量。

## 放弃的方案

- 回到 2026-09 的 sidecar（每工作区一个 `pi.exe` + `runRpcMode` JSONL）：会丢掉之后在宿主层写的会话路由、后台会话停靠、进程内子代理、后台 job 桥，事件和命令语义要全部重做。
- 每个工作区一个子进程：隔离更彻底，但 jobs / 子代理 / MCP 都是进程级单例，跨工作区的停靠、删除级联要多一层协调。先单进程，主进程不卡的目标已经达到。
- `utilityProcess.fork`：能直接把 MessagePort 交给渲染层。但仓库里 RunAsNode 子进程（pi-worker）已经在打包产物里跑通字节码和 asar 解包，utilityProcess 这条路没验证过。
- 给子进程显式设 4GB 老生代（`--max-old-space-size`，或放进 `NODE_OPTIONS`）：和主进程的做法一致，小内存机器上也有确定的上限。但它是 V8 参数，会让字节码缓存被拒；要设就得让 agent-host 及它加载的 chunk 不走字节码，代价比默认上限大。
- 渲染层经 MessagePort 直连子进程、绕开主进程转发：主进程转发的成本只是反序列化再 `webContents.send`，比原来在主进程里产生这些事件轻得多；直连要改 preload、处理多窗口和渲染层重载时重新发端口。等转发本身成为瓶颈再做。
- 只修 MCP 工具注册的平方级开销、不拆进程：MCP 只是最显眼的一处。建运行时（技能 realpath、扩展 `session_start` 的同步读写）、子代理快照同样占主线程，修一处还会有下一处。
- 子进程崩溃后弹窗让用户选择重启（DSH 的做法）：会话、子代理都能在下一条命令时重建，自动拉起对用户更省事；连续崩溃时停一会儿，避免死循环。

## 后果

- 主线程不再跑 Agent。首次加载会话、MCP 连接、子代理流式事件都不会让窗口未响应，但这些开销仍在子进程里：子进程忙时，Agent 事件会晚到，窗口照常可以操作。打开第一个工作区时子进程约 2 秒不响应（建会话运行时）。MCP 工具注册的平方级开销另行修掉了（`extensions/2026-10-10-mcp-tool-registration-batch.md`）。
- 每个渲染层到 Agent 的命令多一跳进程间消息；子进程到主进程的回调（授权、入库、取配置）每回合多几次往返。
- 两进程各持一份 `ModelRuntime`。改 provider 配置时两边都要刷新（`ProviderService.refresh` 已经两边都刷）。两边都会读写 `auth.json`；OAuth 刷新若被同时触发，两边会各刷一次。
- 打包时 `out/main/agent-host.js` / `.jsc` 要和 `pi-worker` 一样放进 `asarUnpack`。
- 主进程 4GB 老生代上限（`2026-10-03-main-process-heap-fixed.md`）不再是因为 Agent 需要。子进程用 RunAsNode 的默认上限：16GB 以上内存的机器是 4096MB，内存更小的机器会更低；子代理流式快照撑爆堆的问题若在小内存机器上复现，要回到「不走字节码 + 显式上限」那条路。
- 子进程意外崩溃（例如 OOM）时，它拉起的 MCP 服务器、后台 bash、pi-worker 子代理留下的子孙进程由进程树守卫清掉，见 `2026-10-10-agent-host-job-guard.md`。
- 生产 CJS 字节码产物在本机直接跑不起来（`2026-10-08-local-run-production-renderer.md`，pi 包只有 `import` 导出条件），agent-host 和 main、pi-worker 一样只能在打包后验证；本机冒烟用 `--mode localrun` 构建。
- 子进程崩溃会中断它里面所有工作区的回合。要是这种情况变多，或者一个工作区的负载拖慢了其他工作区，再考虑每工作区一个子进程。
- 主进程转发 Agent 事件的开销如果在诊断日志里显出来，再做渲染层直连。
