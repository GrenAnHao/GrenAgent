# Agent Note: AgentData 运行在 agentdata-host 子进程

Status: implemented

## Problem

AgentData（sqlite 存储、扩展的 RPC 服务、记忆与 Wiki 的后台任务和定时器、工具授权、线程持久化、CodeGraph 的任务与检索入口）全部跑在 Electron 主进程里，用同步的 `node:sqlite` 和同步 fs。实测在真实库（468 MB）上：线程读 0.44–1.75 s、每个 item 落库 12 ms、每次工具授权 5 ms、Wiki 写页随页数线性增长到秒级，都直接挡住窗口与 IPC。分析、任务归类和备选方案见 [AgentData 整体移出主进程](../../proposed/architecture/2026-10-16-agentdata-out-of-main-process.md)。

M0 闸门（[runtime-diag 记录 AgentData 同步耗时](../process/2026-10-16-agentdata-sync-timing-diag.md)）原定先攒线上数据再决定是否迁移；用户在数据到位前决定直接迁移（在 worktree 里做，保留进程内退路）。闸门脚本仍保留，用来在迁移后对比。

## Decision

主进程启动时拉起 agentdata-host 子进程（同一份 Electron 可执行文件加 `ELECTRON_RUN_AS_NODE=1`，Node IPC，`RpcPeer`，进程树守卫，不带 V8 参数），由它独占 `agent-data.db`。入口 `electron/agentDataProcess/hostEntry.ts`，构建产物 `out/main/agentdata-host.js`（已进 `asarUnpack`）。

- 默认 child 模式；`GREN_AGENTDATA_PROCESS=inproc` 退回主进程内（与原来同一份装配）。
- 两种模式共用 `agentDataProcess/assemble.ts` 装配运行时：`SystemWorkerManager`、`CodeGraphJobs`、`codeRetrieval`、注入的 socket 方法接法完全相同。
- codegraph-host 改由 agentdata-host 拉起（孙进程），CodeGraph 任务回写状态走运行时的进程内入口 `requestJobAdmin`，不再绕 TCP。见 [CodeGraph 运行在 codegraph-host 子进程](./2026-10-16-codegraph-host-process.md)。

### 四条通道（名字只从 `agentDataProcess/contract.ts` 取）

1. **扩展与主进程的 socket 类请求 → agentdata-host**：命名管道（Windows `\\.\pipe\grenagent-agentdata-<pid>-<随机>`，POSIX 为 0700 临时目录里的 socket），帧格式、令牌校验、方法分派与原来的环回 TCP 完全一样。端点 JSON 多了可选的 `path` 字段；`agentData/client.ts` 与 `extensions/memory/client.ts`（wiki-rag、code-retrieval、desktop-control 复用它）有 `path` 时连管道。
2. **主进程 → agentdata-host（管理面，私有 IPC）**：`agentdata.admin`（原 `requestAdmin` 的全部方法，错误形状仍是 `Error("CODE: message")`）、`agentdata.registerWorkspace`、`agentdata.registerKnownWorkspace`、`agentdata.resolveDiagnosticPath`、`agentdata.plugins.load/save`、`host.shutdown`。
3. **agentdata-host → 主进程（反向端口）**：`main.model.describe / complete / abort`、`main.resolveSession`、`main.method`（`turn.start` / `permission.authorize` / `mcp.state.publish`，审批 UI、渲染层广播、问 agent-host 都必须在主进程）。模型调用的 `signal` 变成 `main.model.abort { requestId }`；`onUsage` 变成主进程在同一 IPC 通道上先于应答发出的 `agentdata.model.usage` 事件，失败的调用也记账。
4. **agentdata-host → 主进程（诊断）**：`agentdata.diag`，每 10 秒 `agentdata-host-sample`（内存、事件循环延迟、M0 的 `agentData` 方法耗时），以及转记 codegraph-host 的采样与退出；退出记 `agentdata-host-exit`。

### 运行时不变量

- **端点在主进程生命周期内不变**：管道名、host 令牌、每个工作区的令牌都由主进程生成并持有；子进程每次拉起（含崩溃重拉，`AgentProcessClient` 的 `env` 现在可以是函数）都带着当前的令牌表与已知工作区。新工作区的令牌先 `agentdata.registerWorkspace` 到子进程、确认后才交给 agent-host。扩展写进只读工作区上下文的 `AGENT_DATA_ENDPOINT` 因此在重拉后继续有效。
- **主进程不打开 `agent-data.db`**：`PluginManager` 的持久化改为 `state: { initial, save }` 端口，经 agentdata-host 读写同一张 `plugin_state` 表；`mainBoundary.test.ts` 静态断言 `main.ts` 不引入 `AgentDataStorage`、不建 `DatabaseSync`。
- **生命周期**：启动顺序 agentdata-host（迁移库、监听管道后报 ready）→ PluginManager → agent-host；关停顺序 agent-host → agentdata-host（子进程内先停 CodeGraph 同步与模型任务、再关库）。崩溃预算沿用 `AgentProcessClient`（60 秒内 3 次后冷却 30 秒）；重拉时运行时启动逻辑照常把上一个进程留下的任务落定（[孤儿任务落定](../bug-fix/2026-10-16-orphan-job-settle.md)）。
- **共享连接上的超大应答**：主进程所有 AgentData 请求共用一条 `AgentDataClient` 连接。超过 1 MiB 的应答现在只让它自己那条请求以 `FRAME_TOO_LARGE` 失败，连接保留；以前会销毁整条连接，同时在途的请求一起失败。进程内时请求几乎不重叠所以没暴露；拆进程后真实并发了，冒烟里一次最大线程读让 4 条并发的 `item.upsert` 跟着失败。

### 破坏性变更

`AgentDataService.agentEndpoint` 变为异步（调用方只有 `main.ts`）；`HostDeps.agentDataEndpoint` 可返回 Promise；child 模式下端点是 `{ path, token }`；`recordJobStage` / `runServiceTask` 只在 inproc 下可用（调用方都已随装配进子进程）；`PluginManager` 增加 `state` 选项（`storage` 选项保留）。数据格式、表结构、帧协议与版本、令牌语义、错误码不变。

### 涉及文件

- 新增：`electron/agentDataProcess/{assemble,codeGraphClient,contract,host,hostEntry,pipePath}.ts`、`host.test.ts`、`mainBoundary.test.ts`、`electron/app/plugin/pluginStateStore.ts`、`scripts/agentdata-host-smoke.ts`
- 修改：`electron/main.ts`、`electron/app/agentDataService.ts`、`electron/agentData/{runtime,protocol,client}.ts`、`client.test.ts`、`electron/agentProcess/{agentProcessClient,mainBindings}.ts`、`electron/app/plugin/pluginManager.ts`、`electron/agent/workerEntry.ts`、`electron.vite.config.ts`、`electron-builder.yml`、`electron/app/sourceCodeProtection.test.ts`、`electron/app/agentDataService.test.ts`、`extensions/memory/client.ts`

## Alternatives considered

- **在迁移前等 M0 闸门数据。** 最强理由：如果 AgentData 对线上卡顿贡献小，迁移的代价（多一个进程、端点稳定、反向调用）就不值。没选：用户决定直接迁移；用 worktree 隔离、保留 `inproc` 退路，并用真实库副本上的对照冒烟给出收益证据。闸门脚本仍可在迁移后用来看 agentdata-host 自己的负载。
- **复用上次的 TCP 端口 / 端口变化时通知 agent-host。** 最强理由：不改两个客户端。没选：临时端口在重拉的空档里可能被占；端点已写进只读工作区上下文和子代理 env，通知了也换不掉。命名管道名由主进程定，重拉不变。
- **主进程保留 TCP 监听、把字节转发给子进程。** 最强理由：端点完全不变。没选：又把主进程放回数据路径上。
- **CodeGraphJobs 留在主进程、经 TCP 回写任务状态。** 最强理由：少动一处。没选：任务状态在子进程里，回写多两跳；放进同一子进程后用 `requestJobAdmin` 直接调。
- 进程形态、`worker_threads`、合并进 agent-host、按能力拆多进程、`utilityProcess` 等，见 [AgentData 整体移出主进程](../../proposed/architecture/2026-10-16-agentdata-out-of-main-process.md) 的 Alternatives。

## Consequences

- 收益（真实库副本、同一负载）：主进程事件循环 p99 162 ms → 25 ms，最长卡顿 482 ms → 36 ms。
- 代价：
  - 子进程内部仍是单个事件循环，AgentData 自己的请求互相排队。原来主进程里的 `requestAdmin`（任务列表、审计、记忆列表）是同步直调、实际上插队；现在要在子进程里排在重请求后面。冒烟的极端负载下（每 1.5 s 读一个 900 KB 线程）`tasks.list` p50 从 5 ms 变成 241 ms：窗口不卡了，但面板在 AgentData 繁忙时加载变慢。若实际使用中明显，下一步是把只读查询放到读连接 / 线程上，或对 `thread.read` 做分页。
  - 冷启动多约 250 ms（子进程拉起 + 库迁移）；agent-host 等它就绪后才拉起。
  - 多一个常驻进程；崩溃时扩展的 AgentData 请求在重拉前失败，授权按现有逻辑转为拒绝。
  - 每条管理请求多一次 IPC 往返。
- 最大线程的 `thread.read` 仍超过 1 MiB 被丢弃（只影响它自己了），线程分页不在本次范围。

## 验证

证据目录：`.agents/evidence/2026-10-16-agentdata-host-process/`

- 冒烟 `scripts/agentdata-host-smoke.ts`（应用自带 Electron Node + tsx；扮演主进程，child 模式用 `AgentProcessClient` 拉起构建产物里真实的 `agentdata-host.js`；在真实 `agent-data.db` 副本上跑 20 秒负载：每 50 ms 一条 7 KB `item.upsert`、每 200 ms 一次 `permission.tool.evaluate`、线程读、审计、记忆列表与检索、任务列表），`smoke-localrun.txt`，7 项全部通过：

  | 主进程事件循环 | child | inproc（对照） |
  | --- | --- | --- |
  | p99 | 25 ms | 162 ms |
  | 最长卡顿 / 心跳最大间隔 | 36 ms / 36 ms | 482 ms / 540 ms |

  另验证：负载中 0 个请求错误；kill 子进程后主进程下一条请求在约 200 ms 内自动重拉；扩展手里原来的端点（同一管道、同一令牌）重拉后仍可用；关停后 `PRAGMA integrity_check` 为 ok。第一轮冒烟有 5 个请求错误，查出是共享连接上超大应答连带失败（见上文），修复 `AgentDataClient` 并补测试后复跑通过。
- 生产字节码产物：`npx electron-vite build` 后用 `out/main/agentdata-host.cjs` 跑同一冒烟（10 秒），7 项全部通过（`smoke-bytecode.txt`）；同时用 `codegraph-host.cjs` + `codegraph-worker.cjs` 跑 `scripts/codegraph-host-smoke.mjs`，10 项全部通过（`codegraph-smoke-bytecode.txt`），补上了上一轮「worker 线程在字节码产物里能否加载」的缺口。worktree 用的是已提交的 `electron.vite.config.ts`，生产入口文件名是 `.cjs`（主工作区里他人未提交的改动把它改成 `.js`）。
- 单测 `npx vitest run electron/agentData electron/agentDataProcess electron/app/codeGraph electron/app/appServer electron/app/memoryService.test.ts electron/app/toolPermission electron/app/taskViewService.test.ts electron/app/agentDataService.test.ts electron/app/plugin electron/app/sourceCodeProtection.test.ts electron/agentProcess electron/runtimeDiag.test.ts electron/ipc electron/main.config.test.ts src/features/agentData`：1008 个用例中 994 个通过，14 个失败，部分通过（`vitest.txt`）。14 个失败是迁移前就有的同一组（`auditViewStore` 4、`jobCleanup` 2、`runtime.test` 4、`taskViewService` 4），worktree 基线上同样失败，无新增。新增 `host.test.ts` 8 个用例：管道 + 主进程签发令牌、管理面错误形状、崩溃后同端点继续可用、模型反向调用与 usage 先于应答（失败也到）、abort 传到主进程、`permission.authorize` 回到主进程、插件状态经子进程持久化、重拉后项目列表保留；`client.test.ts` 新增超大应答只影响自己一条。
- 扩展客户端 `npx vitest run memory wiki-rag code-retrieval _shared/desktop-control`（extensions 目录）：16 个文件 102 个用例通过（`vitest-extensions.txt`）。
- `npm run test:codegraph`：10 个文件 66 个用例通过（`test-codegraph.txt`）。
- 类型检查 `npx tsc -p tsconfig.node.json --noEmit`：158 个错误，与 worktree 基线逐文件相同，无新增，通过（`tsc.txt`）。
- 未做：没有在真实 Electron 窗口里跑（开发版数据目录是用户日常用的那个）；合并后需要用户重新构建、重启，确认 `runtime-diag.jsonl` 出现 `agentdata-host-sample`、主进程 `sample` 不再带 `agentData` 字段，以及记忆、Wiki、代码面板、工具授权弹窗正常。
