# Agent Note: CodeGraph 运行在 codegraph-host 子进程

Status: implemented

## Problem

用户在代码索引面板点「同步」时窗口卡死。M0 埋点上线后的第一份日志（2026-10-16 11:47–11:48）记下了这次操作：`agentData_jobs_create` 之后，主进程一个 10 秒窗口里事件循环最长卡 **19.8 秒**，前后窗口还有 0.8 s、0.9 s 的卡顿；同一窗口里 AgentData 自己的同步耗时只有 6.7 ms。原因是 `CodeGraphJobs → CodeGraphEngine.runSync → graph.indexAll / sync` 在主进程里执行：SDK 只把 tree-sitter 解析放进 worker 线程，写库（`node:sqlite` 同步 API）、引用解析、FTS 都在宿主线程上。M0 的埋点只计 `codeRetrieval.call` 到第一次 await，看不到 `runSync` 续体里的这段，所以 `agentData` 字段几乎为零，卡顿却很大。

## Decision

CodeGraph SDK 只在 codegraph-host 子进程里加载和执行，主进程不再执行任何 SDK 调用。

- 子进程入口 `electron/app/codeGraph/hostEntry.ts`（构建产物 `out/main/codegraph-host.js`）：同一份 Electron 可执行文件加 `ELECTRON_RUN_AS_NODE=1`，Node IPC（`serialization: 'advanced'`），`RpcPeer`。进程里是原来那一个 `CodeGraphService`，读写互斥、取消、空闲回收、错误文案都没有改。不带任何 V8 参数（字节码入口，见 [agent-host 子进程](./2026-10-09-agent-host-child-process.md)）。
- 持有者：默认由 agentdata-host 子进程持有 `CodeGraphHostClient`（codegraph-host 是它的子进程），`GREN_AGENTDATA_PROCESS=inproc` 时由主进程持有；两边都用 `agentDataProcess/codeGraphClient.ts` 创建，见 [AgentData 运行在 agentdata-host 子进程](./2026-10-16-agentdata-host-process.md)。
- 门面 `CodeGraphHostClient`：方法与返回结构与原 `CodeGraphService` 相同（`projects / status / call / search / runSync / cancelSync / close`），`main.ts` 的注入点与 `CodeGraphJobs` 不变。`projects()` 只是 stat 探测，仍在主进程。
- 进程管理复用 `AgentProcessClient`：按需拉起（第一次查询或同步时）、`host.ready` 握手、60 秒内 3 次崩溃后冷却 30 秒、关停超时整树杀掉、Windows 进程树守卫。
- 线协议只从 `hostContract.ts` 取名字：方法 `codegraph.status / call / search / runSync / cancelSync`；事件 `codegraph.progress`（同步进度，按 jobId 回到 `CodeGraphJobs` 的 stage 回调）与 `codegraph.diag`（每 10 秒内存、事件循环延迟、在跑同步数，写进 `runtime-diag.jsonl` 的 `codegraph-host-sample`）；退出记 `codegraph-host-exit`。

### 子进程内的线程

子进程主线程不加载 SDK，只做 IPC 与调度（`CodeGraphThreads`）。SDK 在 `worker_threads` 里跑，入口 `workerEntry.ts`（产物 `codegraph-worker.js`，路径由主进程经 `CODEGRAPH_WORKER_ENTRY` 传入）：

- 一个写线程：收 `plan` / `runSync` / `cancelSync` / `watch` / `unwatch`。手动同步跨工作区在它里面照旧并发；自动同步与排队规则见 [CodeGraph 自动同步](./2026-10-18-codegraph-auto-sync-and-stale-reads.md)。
- N 个读线程：`status` / `call` / `search`，按在途数最少分派。N 默认 `clamp(核数 - 2, 1, 2)`，`GREN_CODEGRAPH_READ_WORKERS` 可覆盖（上限 8）。每个线程各持一条连接（SDK 库是 WAL）。
- （2026-10-18 起只适用于全量重建；增量同步期间读照常应答、写完读线程 `refresh`，见 [CodeGraph 自动同步](./2026-10-18-codegraph-auto-sync-and-stale-reads.md)。）同一工作区的读写规则不变：写期间读返回 `CodeGraph workspace is busy indexing`（`search` 返回带该消息的不可用视图），`status` 返回 `indexing` 加上次的快照。写开始前调度器先等该工作区在途的读结束，再让已启动的读线程 `evict`（关掉手里该库的连接），然后才把 `runSync` 交给写线程；写完读线程按需重开。写失败的原因记在调度器里，合并进之后的 `status`（与原引擎的 `failures` 语义相同）。参数校验在忙碌判断之前，错误顺序与原来一致。
- 线程崩溃：该线程上在途的请求以 `CODEGRAPH_WORKER_EXITED: <role> code=…` 失败（写线程崩了就是 job 失败、工作区释放），下一条请求重新拉起；60 秒内 3 次就冷却 30 秒（`CODEGRAPH_WORKER_CRASH_LOOP`）。
- 关停：取消在跑的同步并等它结束，再给已启动的线程发 `close`，线程关库后自己退出；15 秒不退才 `terminate`。不在 SDK 还在跑时 terminate：SDK 文档记录 Windows 上这样结束线程可能带走整个进程。
- 退路：`GREN_CODEGRAPH_THREADS=off` 让子进程退回单线程（SDK 直接在子进程主线程跑），用于工作线程在某个环境起不来时；冷烟也用它做对照。

### 运行时不变量

- 子进程在同步中崩溃：在途 `runSync` 以 `AGENT_HOST_EXITED: …` 拒绝，`CodeGraphJobs` 把 job 记为失败，不会停在 running。之后的请求重新拉起子进程；索引若停在 `partial`，下次同步走全量（SDK 现有逻辑）。
- `search()` 永远返回视图不抛错（子进程不可用时 `available: false` 带原因），与进程内实现一致。
- `cancelSync` 在子进程不在时是空操作：没有在跑的同步。
- 关停：`codeGraphJobs.close()` → `CodeGraphHostClient.close()` → `host.shutdown`；子进程里 `service.close()` 先取消在跑的同步、等它真正结束，再关图退出。主进程断开时子进程自己收尾退出。
- 打包：`codegraph-host.js` / `.jsc` 在 `asarUnpack` 里（`sourceCodeProtection.test.ts` 断言）。SDK 依赖从子进程入口所在目录向上解析，所以入口必须在应用目录内（打包后是 `app.asar.unpacked/out/main`，开发时是 `out/main`）。

### 涉及文件

- 新增：`electron/app/codeGraph/{hostEntry,hostContract,hostMethods,codeGraphHostClient,codeGraphThreads,workerEntry,workerProtocol}.ts`、`codeGraphHostClient.test.ts`、`codeGraphThreads.test.ts`、`codeGraphThreads.sdk.test.ts`、`scripts/codegraph-host-smoke.mjs`
- 修改：`electron/main.ts`（装配）、`electron/agent/workerEntry.ts`（`resolveCodeGraphHostEntry` / `resolveCodeGraphWorkerEntry`）、`electron.vite.config.ts`（两个入口）、`electron-builder.yml`（`asarUnpack`）、`electron/app/sourceCodeProtection.test.ts`、`codeGraphEngine.ts`（新增 `evict`）

## Alternatives considered

- **等 AgentData 整体移出主进程再把 CodeGraph 放进 agentdata-host。** 最强理由：AgentData 迁移方案的排序原定先迁 AgentData，避免先在主进程接一个 CodeGraph 客户端、之后再搬一次。没选：用户已经在日常操作里遇到 19.8 秒的窗口卡死，而 AgentData 迁移还卡在 M0 闸门等数据；CodeGraph 单独拆出只动 CodeGraph 自己的文件，之后如果 agentdata-host 落地，`CodeGraphHostClient` 换个持有者即可，返工很小。后来确实如此：[AgentData 运行在 agentdata-host 子进程](./2026-10-16-agentdata-host-process.md) 落地时只换了持有者。
- **主进程里的 `worker_threads`。** 最强理由：少一个进程。没选：SDK 自己记录了 Windows 上结束 worker 线程可能让整个进程崩溃，宿主是主进程时风险落在窗口上；单个线程也不能单独限内存和降优先级。
- **一次做完 [CodeGraph 自动同步方案](../../proposed/architecture/2026-10-16-codegraph-host-process-auto-sync.md)**（写调度、FileWatcher、状态模型、增量同步期间给旧结果）。最强理由：线程化是那篇的一部分，一起做只改一轮。没选：那篇大部分假设没验证，范围也大；用户要解决的是「同步时卡」，这两步（子进程 + 读写线程分离）就解决了，而且同一工作区的读写语义与原来完全一致。「同步期间仍给同一工作区的旧结果」会改变 `busy indexing` 语义和面板呈现，留给那篇。
- **用 SDK 自带的 `QueryPool`（`mcp/query-pool`）作读池。** 最强理由：上游实现，带崩溃重试和忙碌兜底。没选：它不在 SDK 的公开导出里，要深引 `dist` 路径；它跑的是 SDK 的 MCP 工具处理器，不是本仓库的 `executeCodeGraphTool`，结果形状不同。
- **每个工作区一个线程。** 最强理由：工作区之间完全隔离，不用 evict。没选：线程数随打开过的项目增长，每个线程都要加载一份 SDK；同一工作区的并发查询反而只能排队。

## Consequences

- 收益：同步与检索不再占主线程（见验证：同一份代码全量索引期间主进程最长卡顿 452 ms → 25 ms）。CodeGraph 的崩溃、内存增长、WASM OOM 只影响子进程。
- 代价：多一个常驻（按需拉起后不退出）的子进程，冷启动约一秒；每次查询多一次 IPC 往返（8 路并发检索 25 ms → 34 ms）。
- 一次长同步期间，其它工作区的查询在读线程上并行，不再排在同步后面；同一工作区仍互斥（`busy indexing`）。两个工作区同时同步时共用一个写线程，彼此仍会交替占用。
- 内存：每个已启动的线程各加载一份 SDK 与自己的连接；读线程按需启动、不自动退出。
- 生产字节码产物里的 worker 线程入口已验证可加载（见 [AgentData 运行在 agentdata-host 子进程](./2026-10-16-agentdata-host-process.md) 的验证）；仍留退路 `GREN_CODEGRAPH_THREADS=off`。
- `--liftoff-only` 仍未传给 SDK（字节码入口不能带 V8 参数），与改动前相同；大仓库的 WASM Zone-OOM 现在只会让子进程退出、job 记为失败，不再带走主进程。

## 验证

证据目录：`.agents/evidence/2026-10-16-codegraph-host-process/`

- 冒烟 `scripts/codegraph-host-smoke.mjs`（`electron-vite build --mode localrun` 产物里的真实 `codegraph-host.js`、真实 SDK、应用自带 Electron Node 加 `--liftoff-only`；本仓库 `extensions/` 的副本，617 个文件，不碰仓库里的 `.codegraph`）：8 项全部通过（`smoke.txt`、`smoke.json`）。

  | 主进程事件循环 | child（本改动） | inproc（改动前做法） |
  | --- | --- | --- |
  | 全量索引期间 p99 / 最长 | 23 ms / 25 ms | 251 ms / 452 ms |
  | 增量同步期间 最长心跳间隔 | 22 ms | 326 ms |
  | 8 路并发检索 耗时 | 34 ms | 25 ms |

  另验证了：增量同步后新增符号可查、状态 `indexed`、收到 1153 条进度事件、关停后子进程以 0 退出、全量索引期间每 300 ms 一次的并发检索 0 失败。第一轮冒烟「新符号可查」失败，原因是脚本把测试文件写进了 `.codegraph/` 目录（建索引后它排在目录列表第一个），已修正脚本；同时用独立探针确认 SDK 的 `sync()` 能发现新增文件。
- 单测 `npx vitest run electron/app/codeGraph/codeGraphHostClient.test.ts electron/app/codeGraph/codeGraphJobs.test.ts electron/app/codeGraph/sdkPackaging.test.ts electron/app/sourceCodeProtection.test.ts electron/agentProcess electron/main.config.test.ts`：9 个文件 79 个用例通过（`vitest.txt`）。新用例覆盖真实线协议上的转发、错误文案原样还原、子进程不在时 search 不抛错、进度路由与结束后停止、取消、同步中子进程崩溃 job 记为失败、关闭后拒绝新请求。
- `npm run test:codegraph`（真实 SDK 套件）：8 个文件 55 个用例通过（`test-codegraph.txt`）。
- 类型检查 `npx tsc -p tsconfig.node.json --noEmit`：156 个已有错误，新增与修改的文件零错误，通过。
- 构建：`npx electron-vite build --mode localrun --outDir <临时目录>` 产出了 `codegraph-host.js`；随后 `copyPiAdjacentAssets` 因正在运行的应用锁住 `out/main/pi-job-guard.exe` 报 EBUSY（插件固定写仓库的 `out/main`），与本改动无关（`build-localrun.txt`）。
- 线程化（同日第二轮）：
  - 冷烟增加「A 全量索引期间每 200 ms 查一次已索引的工作区 B」，延迟从应发出的时刻算起；三种模式对照，10 项检查全部通过（`threads-smoke.txt`、`threads-smoke.json`）。第一版把延迟从实际发出算起，单线程的等待被漏掉（定时器本身晚到），已修正。

    | 查 B | p50 | p95 | 最长 |
    | --- | --- | --- | --- |
    | child（多线程） | 14 ms | 25 ms | 36 ms |
    | child-single（`GREN_CODEGRAPH_THREADS=off`） | 19 ms | 320 ms | 354 ms |
    | inproc（最初的主进程做法） | 16 ms | 208 ms | 280 ms |

    同一轮里 child 模式主进程全量索引期间 p99 27 ms、最长 29 ms，inproc 为 207 ms / 310 ms。
  - `npm run test:codegraph`：10 个文件 70 个用例通过（`threads-test-codegraph.txt`），含新的 `codeGraphThreads.sdk.test.ts`：真实 SDK 上两条连接，读方 evict 后写方增量同步（修改文件 + 新文件），读方重开能看到；写方持连接时读方可并发读；evict 等在途读。
  - `npx vitest run electron/app/codeGraph electron/app/sourceCodeProtection.test.ts electron/agentProcess electron/main.config.test.ts`：16 个文件 133 个用例通过（`threads-vitest.txt`）。`codeGraphThreads.test.ts` 的 12 个用例用假线程覆盖：同步与他工作区查询并行且分到不同读线程、写期间 busy 与 indexing 快照、参数校验先于 busy、写前等在途读并只对已启动的线程 evict、失败合并进 status 与成功后清除、派发前取消不碰写线程、派发后取消转发、读线程崩溃与重拉、连续崩溃冷却、写线程崩溃 job 失败且工作区释放、进度路由、关停顺序与不 terminate、线程数配置。
  - 类型检查：156 个已有错误，其中 `codeGraphQuery.ts(91)` 是工作区里他人未提交改动引入的，本轮文件零错误，通过（`threads-tsc.txt`）。
- 字节码产物：之后在 AgentData 迁移那一轮补上，`codegraph-host.cjs` + `codegraph-worker.cjs` 冒烟 10 项全部通过（证据在 `.agents/evidence/2026-10-16-agentdata-host-process/codegraph-smoke-bytecode.txt`）。没有跑完整的安装包。
- 真实应用：用户 2026-10-17 重新构建、重启后确认代码面板与同步正常（口头确认，日志未收进证据目录）。
