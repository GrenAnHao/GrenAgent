# Agent Note: 交互 Agent 运行时跑在 agent-host 子进程里

Status: implemented

## Problem

交互 Agent（pi SDK + 全部扩展）原来内嵌在 Electron 主进程里。建运行时、扩展的 `session_start`、MCP 连接与工具注册（每注册一个工具就全量重建一次工具表和 codemode 描述）、子代理流式快照，全都占主线程。`runtime-diag.jsonl` 记到主进程事件循环最长卡 8.2 秒，开关一台 MCP 时单条 `upsert_mcp_config` 5.98 秒。主线程一卡，窗口、IPC 和权限弹窗就一起未响应。

## Decision

主进程启动后用同一份 Electron 可执行文件加 `ELECTRON_RUN_AS_NODE=1` 拉起一个 agent-host 子进程（入口 `electron-agent/electron/agentProcess/hostEntry.ts`，构建产物 `out/main/agent-host.js`）。所有工作区共用这一个子进程。为什么这样拆、和 2026-09 sidecar 的区别，见 [docs/decisions/electron-agent/2026-10-09-agent-host-child-process.md](../../../../docs/decisions/electron-agent/2026-10-09-agent-host-child-process.md)。

### 进程归属

- 子进程持有：`AgentHost` / `WorkspaceHandle` / `PiRuntimeService` / `SubagentService` / jobs 注册表与 jobs 桥 / MCP 管理器 / 审批与模式表 / 自动标题监听。装配在 `agentProcess/runtimeGraph.ts`。
- 主进程持有：窗口与 IPC 分发、设置（`SettingsService` 与 runtime-settings 文件锁）、AgentData（sqlite + TCP）、`PermissionManager`、CodeGraph、短调用用的 `ModelRuntimeHost`、终端 / git / 文件等。
- 主进程 **never** 静态引入 `extensions/**` 的运行时模块（`runtime-config.js` 这类无状态小模块除外）。要用扩展里的东西，就经 RPC 问子进程；只在测试和单进程兜底路径里动态引入。构建后核对：`out/main/main.js` 的静态 import 里不应出现 `chunks/extensions-*.js`。

### 线协议

- 传输：Node IPC，`serialization: 'advanced'`（结构化克隆）。两端各一个 `RpcPeer`（`agentProcess/rpcPeer.ts`）：`{t:'req'|'res'|'evt'}`，两个方向都能发请求。
- 方法名只从 `agentProcess/contract.ts` 取：`AGENT_METHODS`（主 → 子）和 `HOST_METHODS`（子 → 主）。子进程的处理表类型是 `Record<AgentMethod, MethodHandler>`，增删方法必须两边同改。
- 子进程推给窗口的事件一律走 `broadcast` 通道 `{channel, payload}`，主进程原样 `webContents.send`。渲染层看到的 `pi://event` / `pi://ui-request` / `pi://exit` / `pi://jobs` 信封和原来一样。
- 错误跨进程只保证 `message` / `name` / `code` 原样还原。渲染层靠 `message` 判断 `SESSION_BUSY`、`SESSION_SWITCH_CANCELLED` 这类错误码。

### 运行时不变量

- 进程内单例只在子进程里有效。主进程里的 `getApprovalPolicy()`、jobs 注册表、MCP manager 表都是空的，主进程代码 **never** 读它们。审批档以 safety 扩展上报的 `facts.preset` 为准（`ToolDecisionService.evaluate`）。
- 子进程 **must not** 自己写 `runtime-settings.json`，要经 `host.mergeRuntimeSettings` 交给主进程，那把锁只在主进程里（`settingsService.ts` 的 `withRuntimeFileLock`）。
- 扩展到主进程的反向调用（权限、`mcp.state.publish`、记忆、知识库、代码检索）仍走 AgentData TCP。主进程处理这些请求时可以再向子进程发 RPC（例如 `mcp.workspaceForCwd`）：子进程在等 TCP 回复期间事件循环是空的，不会死锁。
- 子进程启动后删掉自己的 `process.env.ELECTRON_RUN_AS_NODE`，孙进程（bash、MCP 服务器）**must not** 继承它。子代理 worker 在 spawn 时自己显式带上。
- 拉起 agent-host（以及 pi-worker）**never** 带 V8 参数（`--max-old-space-size` 等，放进 `NODE_OPTIONS` 也一样）。生产入口是字节码，代码缓存记着编译时的 V8 参数指纹，参数不同整份缓存被拒，子进程第一条 `require` 就抛错。本机 `--mode localrun` 构建没有字节码，冒烟测不出来。
- 释放 / 查询类端口（`closeWorkspace`、`releaseSessions`、`controlPlane.*`、`permissionProfile`、`mcp.hotReload`、`mcp.workspaceForCwd`、`jobs.*`、`activeModel`、`ownsSession`、`listRunningTurns`）只在子进程在跑时转发，不在就返回兜底值，**never** 为它们拉起子进程（`mainBindings.ts` 的 `whenRunning`）。运行时命令（`pi.send`、`openWorkspace`、`mcp.probe`……）照常转发并按需拉起。
- 关停顺序：主进程先 `agentProcess.shutdown()`，再 `agentData.stop()`，因为子进程收尾时扩展还会经 AgentData 记账。子进程里 `disposeMcpManager` / `closeAll` 会等每个 MCP 连接关完（单个最多 `MCP_CLOSE_TIMEOUT_MS`）再退出。
- 子进程意外退出：主进程拒绝在途请求，对打开过的工作区广播不带会话的 `pi://exit`，下一条运行时命令再拉起。60 秒内崩 3 次就暂停 30 秒（`AgentProcessClient`）。退出在 `exit` 后最多等 200ms 的 `close` 再结算，让崩溃前最后的 stderr 进尾巴；不能只等 `close`，继承了 stderr 的孙进程不退它就不来。
- 诊断：子进程每 10 秒经 `host.diag` 报内存与事件循环延迟，主进程写进 `runtime-diag.jsonl`（`agent-host-sample`）。`app.getAppMetrics()` 不含 child_process 子进程。

## Alternatives considered

- **回到 2026-09 的 sidecar（每工作区一个 `pi.exe` + `runRpcMode`）**——隔离最彻底，协议是 pi 自带的。但之后宿主层写的会话路由、后台会话停靠、进程内子代理、jobs 桥都要按 rpc 协议重做，事件语义也会变。
- **每工作区一个子进程**——一个工作区崩了或忙不影响别的。jobs、子代理控制面、MCP 都是进程级单例，跨工作区的停靠与删除级联要再加一层协调；单子进程已经让主线程不再卡。
- **`utilityProcess.fork` + 渲染层经 MessagePort 直连**——主进程连转发都不做。仓库里 RunAsNode 子进程（pi-worker）已经在打包产物里跑通字节码和 asar 解包，utilityProcess 没验证过；转发在诊断里显出成本之前不值得改 preload 和多窗口端口管理。
- **只修 MCP 工具注册的平方级开销**——改动小。但建运行时、扩展的同步读写、子代理快照同样占主线程，修一处还会有下一处。工具注册也一起修了，见 [MCP 工具增量注册、批量刷新](../bug-fix/2026-10-10-mcp-tool-registration-batch.md)。
- **给子进程设 `--max-old-space-size=4096`**——和主进程原来的做法一致，小内存机器上也有确定的上限。但它让字节码缓存被拒、子进程起不来；RunAsNode 的默认上限在 16GB 以上内存的机器上已经是 4096MB。

## Consequences

- **收益**：主线程不再跑 Agent。冒烟（`electron-agent/scripts/agent-host-smoke.mjs`，1000 个工具的桩 MCP）里，主进程事件循环全程最长 25ms。真实 Electron 里打开工作区、开关 MCP，主进程 IPC 往返最长 131ms。原来同类操作卡 5 到 8 秒。
- **代价**：
  - 每条运行时命令多一跳 IPC；每回合多几次子 → 主回调（授权、入库、取配置）。`pi.*` 授权还会再问一次子进程的权限档，每条命令多两次往返。
  - 两进程各持一份 `ModelRuntime`，改 provider 配置要两边刷新。
  - 子进程崩溃会中断所有工作区的回合。它拉起的进程留下的残留由守卫清掉，见 [agent-host 的子孙进程由主进程持有的 Job 收尾](2026-10-10-agent-host-job-guard.md)。
  - 子进程用 RunAsNode 的默认堆上限，小内存机器上低于 4GB。
  - 子进程打开第一个工作区时约 2 秒不响应（建会话运行时、加载扩展与技能），不随 MCP 工具数增长；这期间该进程里所有工作区的事件都晚到，窗口照常可用。
- **重访信号**：子进程负载拖慢了别的工作区，或子进程崩溃变频繁，就考虑每工作区一个子进程；诊断日志里主进程转发 Agent 事件的开销显出来，就做 MessagePort 直连；小内存机器上子进程 OOM，就让 agent-host 不走字节码并显式设堆上限。

## Verification

- 单测：`npx vitest run electron/agentProcess`（RPC 往返、拉起 / 就绪 / 崩溃重启 / 关停 / 超时杀树）。
- 冒烟：`npx electron-vite build --mode localrun --outDir <临时目录>` 之后跑 `node scripts/agent-host-smoke.mjs --entry <临时目录>/main/agent-host.js --tools 300`。生产 CJS 字节码产物在本机跑不起来（pi 包只有 `import` 导出条件），字节码路径只能在打包后验证。它在临时 HOME 里用真实 agent-host、pi SDK 和扩展跑完拉起 → 打开工作区 → MCP 开 / 关 / 开 → 读状态 → 关停，并断言主进程事件循环不超过 200ms、关停后 MCP 进程跟着退出。不要用真实 Electron 主进程做这类测试：`app.getPath('home')` 不认 `USERPROFILE`，会写到真实的 `~/.pi`。
