# Agent Note: 上一个进程留下的任务在启动时落定，取消孤儿任务直接落定

Status: implemented

## Problem

任务中心里一条「代码索引同步」（`E:\linghoumiaohui-kefu-extract`，130733 / 264572）永远显示「正在取消，等待确认」，取消、重试、删除都没用。

库里的记录说明了经过：任务 06:08:00 创建，06:09:18 应用重启（`runtime-diag.jsonl` 的 `start`）。同步当时跑在主进程里，随进程一起没了，但 `agent_jobs` 里的状态停在 `running`。11:47 用户点取消：`admin.jobs.cancel` 先 `requestCancellation`（写 `cancellationRequested: true`），再调 `CodeGraphJobs.cancel`，它发现本进程没在跑这个任务就直接返回。没有任何执行者会再调 `admin.jobs.markCancelled`，任务就永远是「运行中 + 已请求取消」：

- 运行中：删除不可用，同一工作区再建同步报 `JOB_ALREADY_RUNNING`，重试报 `TASK_TARGET_BUSY`。
- 已请求取消：界面一直写「等待确认」。

启动时只把 `wiki_page_generate` 的未结束任务置为失败（`runtime.ts`），用户任务里有执行器的种类（`codegraph.sync`）没人收尾。[CodeGraph 自动同步方案](../../proposed/architecture/2026-10-16-codegraph-host-process-auto-sync.md)里列过这个缺口。

排查时还发现第二个问题：任务视图只看库里的 `cancellationRequested` 标记，不看状态；`JobStore.cancel` 落定为已取消时不清这个标记。所以**正常取消成功**的任务同样会一直显示「正在取消，等待确认」、删除按钮被禁用。

## Decision

- `AgentDataRuntime.start` 在建好 `JobStore` 后调用 `settleOrphanJobs()`：执行器（`jobRunners`）都在本进程里，启动时仍是 `pending` / `running` 且该种类有执行器的任务，一定是上一个进程留下的。请求过取消的记为 `cancelled`，其余记为 `failed`，错误为 `JOB_INTERRUPTED: 应用重启时任务仍在运行，已中断`（任务视图显示 `JOB_INTERRUPTED：任务执行未完成`，可重试）。没有执行器的种类只落库、不归本进程管，不动。
- `CodeGraphJobs.cancel` 收到本进程没在跑的任务时，直接回调 `cancelled` 落定，不再静默返回。进程内不会出现这种情况（`createUserJob` 在同一个微任务链里就调了 `run`），只用来兜住孤儿。
- `TaskViewStore` 投影：`cancellationRequested` 只在任务仍处于活动状态（pending / queued / running / blocked）时为真。库里的标记不清，投影层统一处理，历史记录不用迁移。

### 涉及文件

- `electron-agent/electron/agentData/runtime.ts`（`settleOrphanJobs`）
- `electron-agent/electron/app/codeGraph/codeGraphJobs.ts`（`cancel`）
- `electron-agent/electron/agentData/taskViewStore.ts`（`cancellationRequested` 投影、`JOB_INTERRUPTED` 进入可显示的错误码）

## Alternatives considered

- **只在取消时兜底（`CodeGraphJobs.cancel` 落定孤儿），启动时不动。** 最强理由：改动最小，正好覆盖用户这一次的操作路径。没选：没被取消的孤儿任务仍然永远「运行中」，同一工作区再也建不了同步，用户得先发现要点一次取消才能解开。
- **启动时把孤儿任务重新派发给执行器，接着跑。** 最强理由：用户不用手动重试。没选：用户可能就是因为它卡住才重启；自动重跑一个大仓库的全量索引，用户没有确认。失败并可重试把决定留给用户。
- **`JobStore.cancel` 落定时清掉 `cancellationRequested`。** 最强理由：数据本身干净。没选：只对之后的记录有效，已经落定的历史记录照样显示「正在取消」；投影层按状态判断，一处改动新旧都对。

## Consequences

- 应用每次启动，若上次退出时有代码同步在跑，它会显示为失败（`JOB_INTERRUPTED`），可重试；请求过取消的显示为已取消。
- 被打断的全量索引在 `.codegraph` 里是 `partial` 状态，下次同步按现有逻辑走全量。
- 需要重新构建并重启应用后生效；重启时这条卡住的任务会自动落定为「已取消」。

## 验证

证据目录：`.agents/evidence/2026-10-16-orphan-job-settle/`

- 真实数据：在用户 `agent-data.db`（468 MB）的副本上启动修复后的 `AgentDataRuntime`（注册 `codegraph.sync` 执行器），任务 `c16b0249…` 变为 `cancelled`、`cancellationRequested: false`、可重试可删除，活动任务数 0，结果通过（`real-db-run.txt`，脚本 `real-db-run.mts`）。
- 新增 `runtime.orphanJobs.test.ts`：按现场构造上一个进程留下的四条任务（运行中且已请求取消、运行中、等待中、无执行器种类），启动后分别为已取消 / 失败（显示 `JOB_INTERRUPTED：任务执行未完成`）/ 失败 / 原样不动；同一工作区可以重新建同步并派发；失败那条可以重试预览；审计里有 `job.cancel` 与 `job.fail`。干净启动无副作用。
- `codeGraphJobs.test.ts` 新增：取消本进程没在跑的任务会回调 `cancelled`，不碰引擎。`taskViewStore.test.ts` 新增：取消落定后不再显示正在取消，且可删除。
- 回归 `npx vitest run electron/agentData electron/app/codeGraph electron/app/taskViewService.test.ts electron/app/agentDataService.test.ts src/features/agentData`：758 个用例中 744 个通过，14 个失败，部分通过（`vitest.txt`）。这 14 个失败在 `auditViewStore`、`jobCleanup`、`runtime.test`、`taskViewService` 四个文件里，与 [runtime-diag 记录 AgentData 同步耗时](../process/2026-10-16-agentdata-sync-timing-diag.md) 当时把改动还原到 HEAD 跑出的基线是同一组，本次无新增失败。
