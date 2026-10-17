# Agent Note: runtime-diag 记录 AgentData 在主线程上的同步耗时

Status: implemented

## Problem

[AgentData 移出主进程](../architecture/2026-10-16-agentdata-host-process.md)的前提是「AgentData 的同步重活造成了主进程卡顿」。`runtime-diag.jsonl` 只记渲染层 IPC 命令的耗时；agent-host 里的扩展经环回 TCP 调 AgentData（记忆、Wiki、工具授权、线程持久化、代码检索），这些请求、AgentData 自己的定时器和任务队列在主线程上花了多少时间，日志里完全没有。拆 agent-host 之后仍有 0.94% 的窗口事件循环卡顿超过 200 ms，但没有办法算出其中有多少来自 AgentData。

## Decision

主进程每 10 秒一行的 `sample` 记录增加可选字段 `agentData`（窗口里没有任何 AgentData 调用时不写）：

```json
"agentData": {
  "syncMs": 969.9, "n": 36,
  "methods": [{ "method": "thread.read", "n": 1, "syncMs": 440.1, "syncMaxMs": 440.1, "totalMs": 440.1, "totalMaxMs": 440.1 }],
  "slow": [{ "method": "thread.read", "syncMs": 440.1, "at": 1792134504960 }]
}
```

- `syncMs` / `n`：本窗口顶层同步段的合计与次数。嵌套段（例如 `wiki.pageWrite` 里的 `wiki.rebuildPageIndex`）照常进方法行，但不重复计入合计；`slow` 里的嵌套段带 `nested: true`。
- `methods`：按同步耗时排序的前 15 个方法。`totalMs` 是含 await 的端到端时间，只有请求入口（socket 请求、`requestAdmin`）才有。
- `slow`：单次同步段 ≥ 50 ms 的记录，最多 20 条，`at` 是墙钟毫秒。

### 计什么、不计什么

- 计的是**同步段**：方法被调用到返回（或返回 promise）为止，加上应答序列化与写出。这正是挡住事件循环的时间。await 之后的续体不在请求入口的统计里，所以已知会在续体里做重活的地方在调用点单独计时：
  - `AgentDataRuntime.handleLine`（全部 socket 请求，含 agent-host 经主进程转来的 `item.upsert` 等）与 `requestAdmin`。
  - `task.<kind>.complete`（记忆任务完成后的结算）、`taskQueue.pump`（含每个任务启动前的同步写）、`taskQueue.settle`（结果校验与终态写入）。
  - `memory.timer.flush`、`memory.timer.scene`（空闲补抽与场景层定时器）。
  - `wiki.rebuildPageIndex`（每次写页的全量索引重建，ingest 续体里也会调到）。
  - `codegraph.<tool>`：只计到 `executeCodeGraphTool` 第一次 await 为止，explore / context 的后半段不在其中。
- 方法名来自 socket，调用方可以随便填：解析不出处理函数的请求统一记作 `rejected`，非法帧记作 `invalid`，未知管理方法记作 `admin.unknown`；单窗口最多 200 个键，超出的并入 `(other)`。统计表不会被调用方撑大。

### 涉及文件

- `electron-agent/electron/agentData/methodTiming.ts`（新）：`AgentDataTiming`、进程内单例 `agentDataTiming`、`timeSync`。
- `electron-agent/electron/agentData/runtime.ts`、`electron/app/appServer/taskQueue.ts`、`electron/app/memoryService.ts`、`electron/agentData/wikiEngine/service.ts`、`electron/app/codeGraph/codeGraphEngine.ts`：埋点，每处 1~10 行，不改返回值与错误。
- `electron-agent/electron/runtimeDiag.ts`：采样时取走并写入。
- `electron-agent/scripts/diag-agentdata-report.mjs`（新）：读日志，给出 M0 闸门结论。

### 闸门脚本

`node scripts/diag-agentdata-report.mjs [--dir <logs>] [--since <ISO>] [--json]`。默认从第一条带 `agentData` 的采样算起，规则：

- 有 Agent 活动的窗口少于 360 个（约 1 小时）：`INSUFFICIENT`。
- 卡顿窗口（≥200 ms）至少 10 个，且其中 ≥20% 含 ≥100 ms 的顶层 AgentData 同步段：`CONTINUE`。
- 或者 ≥200 ms 的顶层 AgentData 同步段平均每活跃小时 ≥1 次：`CONTINUE`。
- 否则 `STOP`：停在 M0，按方法榜对最重的几个方法做局部修复，不做进程迁移。

## Alternatives considered

- **`async_hooks` 按 ALS 归属每段回调的 CPU 时间。** 最强理由：能把 async 方法 await 之后的续体也算到发起它的方法头上，不需要在调用点逐个埋点。没选：promise hook 对主进程所有异步操作都有开销，而这是常驻埋点；按调用点补计时只覆盖已知的重活，但没有全局代价。
- **只看现有的 `ipc` 统计与事件循环延迟做相关分析。** 最强理由：零改动。没选：已经做过，得出的只有相关性（有活动的窗口卡顿率高约 9 倍），TCP 请求和后台任务根本不在 `ipc` 里，归因做不出来。
- **把 AgentData 的耗时写成单独的 `kind: 'agentdata-sample'` 记录。** 最强理由：不改 `sample` 的形状。没选：闸门要按窗口把 AgentData 的阻塞和同一窗口的 `lag.maxMs` 对上，放进同一行最直接；字段是可选的，旧的读取方忽略即可。

## Consequences

- 收益：可以按窗口回答「这次卡顿里有没有 AgentData 的长同步段、是哪个方法」，迁移与否有了可机械判定的依据。AgentData 已迁到 agentdata-host 子进程（默认 child）：同一个单例在子进程里计数，字段形状不变，但写在 `agentdata-host-sample` 上，衡量的是子进程自己的事件循环；主进程 `sample` 只有 `GREN_AGENTDATA_PROCESS=inproc` 时才带这个字段。闸门脚本只读主进程 `sample`，对迁移后的日志不再适用；闸门本身因用户决定直接迁移而没有用上，见 [AgentData 运行在 agentdata-host 子进程](../architecture/2026-10-16-agentdata-host-process.md)。
- 代价：每次请求多两次 `performance.now()` 和一次 Map 更新；有调用的窗口每行日志多约 1~2 KB（文件 20 MB 轮转不变）。
- 计时是同步段，不是 CPU 时间；`codegraph.*` 与 async 方法的续体只覆盖到已埋点的位置，结论里偏低的方向是已知的。
- 实跑时附带发现：最大线程（14.9 MB）的 `thread.read` 在主线程上同步 440 ms，然后因应答超过客户端 1 MiB 上限被 `FRAME_TOO_LARGE` 丢弃——代价付了，结果没拿到。这是已有问题，不在本篇修复范围，记录在迁移笔记的现状证据里。

## 验证

证据目录：`.agents/evidence/2026-10-16-agentdata-sync-timing-diag/`

- 新增单测，`npx vitest run electron/agentData/methodTiming.test.ts electron/agentData/runtime.timing.test.ts electron/runtimeDiag.test.ts electron/agentData/diagReport.test.ts`：4 个文件 17 个用例通过（`vitest-m0.txt`）。覆盖嵌套去重、异常时仍记录且嵌套深度不失衡、键与条数上限、socket 请求按方法记录且未解析的名字折叠、`requestAdmin` 错误形状不变、`runtimeDiag` 有调用的窗口写入字段而空闲窗口不写、闸门四种结论与嵌套段不计入。
- 回归，同一条 vitest 命令跑 `electron/agentData`、`app/appServer`、`app/memory*`、`app/toolPermission`、`taskViewService`、`agentDataService`、`codeGraphEngine`、`codeGraphJobs`、`ipc/register`：55 个文件中 51 个通过，567 个用例中 553 个通过，14 个失败（`vitest-regression.txt`）。失败集中在 `auditViewStore`、`jobCleanup`、`runtime.test`、`taskViewService` 四个文件。把本次改动的 6 个文件临时还原到 HEAD 再跑这 4 个文件，结果完全相同：14 个失败、29 个通过（`vitest-baseline-without-m0.txt`），是改动前就存在的失败（测试仍在走已被禁止的 `wiki.*` job 创建路径，审计排序断言与现有实现不符），与本篇无关，结论为部分通过且无新增失败。
- `npm run test:codegraph`（应用自带 Electron Node + 真实 SDK）：7 个文件 46 个用例通过（`test-codegraph.txt`）。
- 实跑：在真实 `agent-data.db`（468 MB）的临时副本上启动真实 `AgentDataRuntime`，经 TCP 客户端发 30 次 `item.upsert`、3 次 `memory.conversations.search`、`admin.audit.query`、`memory.conversations.list`、最大线程的 `thread.read`，取到的样本见 `real-db-run.txt`：`thread.read` 440 ms 进入 `slow`，`item.upsert` 单次最大 18 ms、30 次合计 301 ms，结果通过。脚本 `real-db-run.mts` 在同目录。
- 类型检查 `npx tsc -p tsconfig.node.json --noEmit`：全工程 156 个已有错误，本次涉及文件里只有 `wikiEngine/service.ts` 一处，是 HEAD 已有的 `log.info` 参数个数错误（行号因新增 4 行后移），新增文件零错误，通过（`tsc-node.txt`）。
- `node scripts/diag-agentdata-report.mjs` 对本机现有日志：`NO_DATA`（埋点版本尚未在应用里运行），符合预期（`report-dry-run.txt`）。
- 未做：没有在真实 Electron 应用里跑出主进程 `sample` 带 `agentData` 字段的日志，闸门报告也没有跑出结论：数据攒够之前 AgentData 就迁进了子进程。迁移后用户在真实应用里确认 `agentdata-host-sample` 正常出现（2026-10-17，口头确认，见迁移笔记的验证）。
