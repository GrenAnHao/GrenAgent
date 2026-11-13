# Agent Note: 修复手动同步索引报退役错误、新鲜度永远未知

Status: implemented

## Problem

任务面下线重构留了两个没闭合的口子，用户在代码索引页实际撞上：

1. 点「同步索引」报 `RpcError: job creation is retired for codegraph.sync`。`main.ts` 给 `assembleAgentData` 传的是 `indexTasksPath`，而 `AssembleOptions` 只认 `indexTasks`（store 实例）；assemble 内部也没把 `indexTasks` 转发进 `AgentDataRuntimeOptions`。于是 `runtime.adminMethod('admin.jobs.create')` 因 `options.indexTasks` 缺失走退役分支（runtime.ts 的 `kind !== 'codegraph.sync' || !this.options.indexTasks`）。熔断留痕 likewise：`reportBreaker` 被置成无操作，`IndexTaskStore.recordBreaker` 没人调。
2. 「新鲜度未知」常驻。`codeGraphThreads` 的 watcher 在首次**查询**时才异步挂载（`touch()`），读 status 本身不挂监听（有测试守着这个无副作用决定）。页面挂载时先读 status（watcher active:false、phase idle），随后查询触发挂载，但页面缓存的 status 是 idle → `codeIndexSyncActive` 为 false → 不轮询 → 永远拿着「watcher 未激活」的旧状态，`indexFreshness` 判 unknown。

## Decision

- 装配闭合：`main.ts` 自己 `new IndexTaskStore(indexTasksPath)` + `settleOrphans()`，把实例传进 assemble；assemble 把 `indexTasks` 转发进 runtimeOptions；`reportBreaker` 接 `indexTasks.recordBreaker(event.workspace, event.message)`；退出顺序里 `inprocAgentData.close()` 之后 `indexTasks.close()`（创建者关闭，CodeGraphJobs 先停、它的结束回调还要写库）。
- 新鲜度：新增 `codeIndexWatcherPending(status)`（indexed 且 autoSync 非 false 且 watcher 存在、active:false、degraded:false），并入页面静默轮询条件。watch 挂载几秒内要么 active 要么 degraded，轮询自然停；degraded 走既有 stale + 横幅语义，autoSync off 不轮询。不改 `codeGraphThreads`「读 status 无副作用」的决定（见 [codegraph auto-sync and stale reads](../architecture/2026-10-18-codegraph-auto-sync-and-stale-reads.md)）。
- 回归测试：assemble 级路由测试（传 indexTasks 后 `admin.jobs.create` 落 index-tasks 库并派发执行器）；`codeIndexWatcherPending` 单测；harness code-index-sync 增加 `watch-starting` 阶段：未落定期间轮询继续、落定后新鲜度标签消失且轮询停。

## Alternatives considered

- **让 `status()` 自己挂 watcher** — 最强理由：页面读一次 status 就能拿到 active watcher，不用轮询补丁。否掉：推翻「读 status 不启动 watcher / 同步」的既有测试决定（诊断、概览读 status 不该有副作用），影响面比渲染层轮询大得多。
- **页面首查成功后一次性补读 status** — 最强理由：只多读一次。否掉：watch 挂载是异步的，补读太早仍拿 active:false；要再加延时/重试计数器，比把「未落定」并入既有轮询条件更绕。
- **assemble 收 `indexTasksPath` 自己建库** — 最强理由：main 少写两行。否掉：现有测试与 smoke-check 都传 store 实例，双入口（path/实例）要多一条所有权分支；main 建实例还能顺手接 breaker 与退出关闭。

## Consequences

- 收益：手动同步恢复，任务落 codegraph 自己的 index-tasks.sqlite；熔断有痕；重启孤儿落定；新鲜度在 watcher 落定后回到 current，不再常驻 unknown。
- 代价：watcher 未落定的几秒里页面按 1.5s 多读几次 status（静默、不闪标签）；main.ts 存量类型报错（`app.isQuitting`、mainMethods 返回类型）与本次无关，未顺带修。

## Verification

结果：通过。证据在 `.agents/evidence/2026-11-08-code-index-sync-and-freshness/`。

- `npx vitest run src/features/agentData src/features/codeIndex electron/agentData/codegraphTaskRouting.test.ts`：13 个文件 154 条全过，日志 `vitest-syncfix-final.log`。新增 assemble 路由测试在修复前会因退役分支红（`admin.jobs.create` 抛 METHOD_NOT_FOUND）。
- `npm run ui:check -- code-index-sync code-retrieval-panel`：26/26 与 71/71 全 PASS，日志 `ui-check-syncfix.log`；code-index-sync 新增断言守住「未落定轮询继续 / 落定后标签消失且停轮询」。
- `npx tsc -p tsconfig.node.json`：assemble.ts 与 codegraphTaskRouting.test.ts 无错误；main.ts 仅剩存量报错（HEAD 之外的未提交工作自带）。