# Agent Note: CodeGraph 读限制、补同步与熔断任务

Status: implemented

## Problem

[自动同步](./2026-10-18-codegraph-auto-sync-and-stale-reads.md) 让保存之后索引自己跟上，但还有几件会在后台同步变成常态以后放大的缺口：

- 读没有队列上限，也没有短于传输层 65 秒的超时。客户端放弃以后，读线程里的计算继续跑。
- 同一次查询可能跨过索引的一次提交（SDK 按文件分批提交），结果里看不出自己是不是混合的。
- 重启以后，登记过的工作区要等下一次查询才补同步；监听被淘汰或失效时，也没有定时兜底。
- 分支切换会先打出一串文件事件。按路径增量同步可能在 checkout 还没停的时候就开始。
- 连续失败熔断只写在状态和 `runtime-diag.jsonl` 里，任务中心看不到，也不能从那里重试。
- 写任务可以一直没有进度。解析线程数沿用 SDK 默认（接近吃满机器），子进程也没有 RSS 上限。

## Decision

沿用 2026-10-18 已经定下的写调度：手动同步不受车道限制、排在正在跑的自动同步后面；自动同步一律增量、全局一次一个；只有查询和搜索算激活；总开关仍是 `GREN_CODEGRAPH_AUTO_SYNC`。这篇只补那篇明确留在提案里的缺口。

### 读

`ReadAdmission` 在 codegraph-host 主线程上限制查询和搜索。状态查询不进这个队列，诊断和概览还是直接打到读线程。

- 排队上限默认 32。队满立刻返回 `CODEGRAPH_BUSY`，带 `retry after 1000ms`，不进队列。
- 同时占用的读线程不超过读线程数。同一个工作区最多占一半（向上取整）。队首被这个上限挡住时，后面别的工作区仍然可以开始。
- 超时从入队起算，默认 30 秒。还在排队的到点移除；已经在跑的停掉那条读线程并重建。这次停掉不算崩溃，避免三次超时就把读池冷却掉。
- 同一工作区、同一工具、规范化参数相同、同一 `generation` 的并发读共用一次执行。

### 混合读

读线程在工具调用前后，对同一条只读连接读 `PRAGMA data_version`。变了就整次重试一遍；第二次前后仍然变，就在 `structuredContent.meta.consistency` 标 `mixed`。这个计数是连接本地的，新开的连接会从 1 重新计，所以连接按库路径缓存，引擎关闭时关掉。读不到版本就当没变化，不重试。

### 补同步、轮询、分支

查询过的已索引工作区记在 `codegraph-state.json`，和 `agent-data.db` 放在同一目录。codegraph-host 不打开任务库。没把路径传给子进程时（单测）只记在内存里，不起启动定时器和轮询。

- 有登记文件时，就绪后 10 秒对已索引的登记工作区做一次增量补同步（`startup`）。
- 之后每 5 分钟再扫一遍（`poll`）。有监听处于降级时，下一轮改成 1 分钟。`pollIntervalMs: 0` 关掉轮询。
- 激活、文件事件、补同步和轮询时读 `.git/HEAD`（worktree 先解开 `gitdir:`）。第一次只记下。之后变了就等 3 秒，让 checkout 的事件停下来，再以 `branch_switch` 做整树比对。这 3 秒里的按路径同步让给这次整树比对。

优先级在原来的手动 > 文件改动 > 激活之上，插入分支切换：手动 > 分支切换 > 文件改动 > 激活 > 轮询 / 启动 / 重试。自动触发仍然共一条车道。

### 写停滞和资源

- 写任务默认 120 秒没有进度事件就取消，并记一次失败（`CODEGRAPH_STALL`）。有进度就重新计时。宿主里的 `onStall` 直接退出进程，父进程按已有的崩溃预算重拉。SDK 1.6 的 `sync` 不转发取消信号，只取消停不住。
- 拉起时把 `CODEGRAPH_PARSE_WORKERS` 设成 `min(2, max(1, floor(核数 / 4)))`，调用方已经设过就不覆盖。进程优先级降到 below normal。
- `--liftoff-only` 和 `--max-old-space-size=2048` 用 `v8.setFlagsFromString` 打在宿主主线程和每个 SDK 工作线程上。字节码入口不能把 V8 参数放进进程 argv。SDK 再拉起的解析线程是另一个 isolate，不一定带上这个旗标。
- 每 5 秒看一次 RSS。超过 `GREN_CODEGRAPH_MAX_RSS_MB`（默认 3072，0 关掉）就退出。读线程的老生代堆上限默认 512 MB。

### 熔断任务和状态事件

连续失败达到上限时，agentdata 这边把一条 `codegraph.sync` 直接写成 `failed`，`metadata.origin` 是 `breaker`。不走 `create`，避免执行器把它当成用户任务立刻跑起来。同一工作区已经有未结束的同步任务就不另建；已经有熔断失败就刷新错误。任务中心把它当成可重试的用户任务：系统任务那条路（`service_tasks`）不能按 `codegraph.sync` 重试。

调度阶段变化经 `codegraph.state` 送到客户端。面板仍用原来的 status 轮询。配置模块和面板开关这次没做。

## Alternatives considered

- **把登记写进 AgentData SQLite 的 `codegraph_state` 表（提案原文）。** 最强理由：和任务、配置在同一个库里，重启和概览都读得到。没选：codegraph-host 不持有 `agent-data.db`，启动补同步发生在它自己的进程里。在库旁边放一个 json，子进程自己就能读，不必为了补同步再加一轮 RPC。
- **熔断任务写成 `source: system` 的 service task（提案原文）。** 最强理由：和「不是用户点的」这个来源一致。没选：任务中心能重试的 `codegraph.sync` 只认 `agent_jobs` 里失败或取消的用户任务。系统任务重试不了这条路径。失败行标 `origin: breaker`，任务视图的 source 仍是 user。
- **停滞时只取消，不退出进程。** 最强理由：少一次崩溃和重拉。没选：增量同步的 `sync()` 不转发 signal，取消可能一直停不下来。退出后父进程按现有预算重拉，被打断的增量下次比对即可。
- **这次就把自动同步做成面板开关，走 `admin.config`。** 最强理由：提案里的配置表已经列了默认值，用户不用改环境变量。没选：总开关已经是 `GREN_CODEGRAPH_AUTO_SYNC`，面板开关还要新的 RPC 和 ui-harness 场景。原提案已关闭，不另开一篇把这个开关再立成待办。

## Consequences

- 查询和搜索最长等 30 秒。队满得到 `CODEGRAPH_BUSY`，超时得到 `CODEGRAPH_TIMEOUT`。同一个大项目不能占满所有读线程。
- 混合读会把同一次工具调用做两遍。第二次仍跨提交时，结果多一个 `meta.consistency: 'mixed'`。
- 重启后大约 10 秒开始补同步已登记、且磁盘上已有索引的工作区。没建过索引的仍然不自动建。
- 分支切换后大约 3 秒做一次整树比对，而不是跟着 checkout 的每个文件事件走。
- 熔断后任务中心里有一条失败的代码索引同步，可以按现有重试再跑手动同步。成功的自动同步仍然不建任务。
- 子进程 RSS 超过约 3 GB 会自己退出。解析线程默认最多 2 个。`--liftoff-only` 只保证打在我们自己的线程上。
- 面板行为不变：同步中仍可查，靠 1.5 秒轮询。没有按工作区关闭自动同步的界面。
- 一个监听降级时，所有已登记工作区的轮询都缩短到 1 分钟。

## 验证

`npx vitest run electron/app/codeGraph electron/agentData/jobStore.test.ts electron/agentDataProcess/host.test.ts --exclude **/*.sdk.test.ts`：通过。输出在 `.agents/evidence/2026-10-27-codegraph-catchup-and-read-limits/vitest.txt`。

覆盖了读队列与超时、单飞、`data_version`、启动补同步、HEAD 结算、写停滞、熔断失败任务、解析线程数默认值。没有改面板，所以没跑 `ui:check`。没有跑真实仓库上的自动同步冒烟。
