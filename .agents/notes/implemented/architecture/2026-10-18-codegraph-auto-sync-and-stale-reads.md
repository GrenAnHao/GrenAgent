# Agent Note: CodeGraph 自动同步，增量同步期间给旧结果

Status: implemented

## Problem

代码索引原来要用户手动点同步才会更新（[内嵌 SDK 的决定](./2026-09-07-embedded-codegraph-sdk.md)：「只有用户显式建立 / 同步才写索引，不启用 SDK watcher」）。模型改完代码马上调 `code_explore`，查到的还是旧代码，只能等用户想起来去面板点同步。

[codegraph-host 子进程](./2026-10-16-codegraph-host-process.md)把读写分到了不同线程，但同一工作区仍然读写互斥：有同步在跑时，这个工作区的读一律返回 `CodeGraph workspace is busy indexing`。手动同步偶尔一次还能忍。改成每次保存都自动同步之后，查询会频繁撞上 busy。

这篇是 [CodeGraph 自动同步提案](../../proposed/architecture/2026-10-16-codegraph-host-process-auto-sync.md)落地的第一批：给旧结果、写调度、触发器、状态字段、面板。持久化状态表、读队列与超时、资源守卫、配置项留在提案里。

## Decision

### 写调度（`syncScheduler.ts`，codegraph-host 主线程）

- 每个工作区最多一个在跑的同步加一个待执行的同步。重复请求并进待执行槽：路径取并集；只要有一个请求要求整树比对（paths 为 null），整批就按整树比对；路径超过 5000 个也退回整树比对。
- 优先级：手动 > 文件改动 > 激活 / 重试。**手动同步不受车道限制**，跨工作区照旧可以并发（与改动前一样）。**自动同步要等其它同步全部结束才开始**，所以全局同一时刻最多跑一个自动同步，长时间的全量索引期间不会再往写线程里塞自动同步。
- 等待执行的工作区最多 8 个。超出时丢弃新的自动请求，并给该工作区记一次「下次整树比对」。手动请求不受这个限制。
- 派发前先问写线程 `plan`，规则与原来 `runSync` 里的判断相同。手动同步按 plan 结果执行：没有索引、上次没建完、抽取器升级过，就全量重建，否则增量。**自动同步一律增量**：没有索引时什么也不做（不替用户建 `.codegraph/`）；抽取器升级后也不自己全量重建；上次被打断的索引交给 SDK 的 `sync()` 补（全树比对成功后它会把 `index_state` 写回 complete）。

### 读与写的关系（`codeGraphThreads.ts`）

- **增量同步期间**：同一工作区的读照常交给读线程，读到的是上一次提交的数据（WAL）。写线程派发过的同步一结束，不论成功失败，已启动的读线程都会收到 `refresh`：之后的读改用新连接，旧连接等手上正在进行的读结束后再关。必须换连接，是因为 SDK 的 `QueryBuilder` 在每条连接上缓存了最多 1000 个节点（`nodeCache`），别的连接写入不会让这份缓存失效。
- **全量重建期间**：保持原规则。新读返回 busy，先等在途的读结束、让读线程 `evict`，再派发；`status` 返回 `indexing` 加上一次的快照。
- 状态在原有字段之外只增不删：`phase`（idle / queued / syncing / rebuilding / backoff / failed）、`mode`、`trigger`、`progress`、`queuedAt`、`startedAt`、`lastAttemptAt`、`lastSuccessAt`、`lastError {message, at, code}`、`consecutiveFailures`、`nextRetryAt`、`pendingChanges`、`generation`、`watcher {active, degraded, reason}`、`servingStale`、`autoSync`。
  - 增量同步期间 `state` 保持 indexed / stale / partial，不再是 indexing。
  - 最近一次同步失败时，仍按原语义把 `state` 覆盖成 failed 并带上 message；被别的进程占锁不算失败，不覆盖。
- 查询结果：索引落后于磁盘时（同步在排队、在跑、在退避，或者监听报过的改动还没进索引），`structuredContent.meta` 写上 `{ servingStale, generation, phase, pendingFiles, files（最多 20 个） }`。监听报过的具体文件还没进索引时，再在 `content` 末尾追加一句英文提示，列出最多 5 个文件，让模型直接去读这些文件。

### 触发器

- **激活**：`call` / `search` 访问一个已索引的工作区（判断依据是 `.codegraph/codegraph.db` 存在）。`status` 不算访问，因为诊断和项目概览会批量读状态，不能顺手把每个项目都挂上监听。面板打开后先查文件列表，那次就是一次 `call`。
- 第一次访问时挂上监听，同时补一次整树比对（trigger: activate）。之后只要监听正常，就不再补；监听没挂上或失效时，距上次检查满 5 分钟后，再被访问才补一次。
- 监听：SDK 的 `FileWatcher` 跑在写线程里（新增 `watch` / `unwatch` 两个 op），防抖 1000ms。Windows 上传入 SDK 的 `isIndexedFileStateCurrent`，滤掉 NTFS 访问时间戳造成的误报。它的 syncFn 不同步，只把 `changed {paths | null}` 发给主线程，然后立刻返回；重试、退避都由调度器负责。挂着监听的工作区，写线程里的连接不随空闲回收。`onDegraded` 回调、或 `start()` 返回 false（例如 WSL 的 /mnt 盘），都记成 `watcher.degraded` 并带上原因。
- 最多同时监听 3 个工作区，按最近使用淘汰。被淘汰的工作区清掉检查时间，下次访问时补一次整树比对。写线程退出时，监听登记全部清掉，下次访问重新挂上并补一次。

### 失败、延后与取消

- **普通失败**：失败次数加一，记下 `lastError`，发 `failed` 事件。失败那次里的自动触发部分并回待执行槽，按指数退避重试：30 秒起，每次翻倍，上限 30 分钟，±20% 抖动。连续失败 6 次熔断（phase failed），丢掉攒着的自动触发，记成下次整树比对，并发 `breaker` 事件。熔断期间，自动触发（文件改动、激活）每 5 分钟最多重新试一次；手动随时可以试。任意一次成功就清零。手动任务所在的那次同步失败时，任务直接失败，不自动重试。
- **被别的进程占锁**：SDK 的 `sync()` 抛 `LockUnavailableError`；`indexAll` 返回「Could not acquire file lock」时，由引擎改名成同一个错误。这种情况算延后，不算失败：按 10 秒起、每次翻倍、上限 2 分钟退避，不计入失败次数，不熔断。连续占锁满 5 分钟才发一次 `locked` 事件。
- **取消**：AbortError 不算失败。被取消的那次如果带着具体路径，这些路径就丢了，所以记成下次自动同步整树比对。
- 失败、熔断、长时间占锁这三种情况经 `codegraph.syncEvent` 通道送到 `CodeGraphHostClient.onSyncEvent`，写进 `runtime-diag.jsonl`（kind: `codegraph-sync-event`）。自动同步成功时不建任务，也不发事件。

### 手动任务

`CodeGraphJobs` 调 `runSync`，在调度器里就是一个 manual 请求。同一工作区已经有同步在跑时，它排到后面：进度先报 `queued`，任务阶段显示「排队等待」，不再报 busy。取消排队中的任务只移除这一个任务，不碰正在跑的同步；取消正在跑的任务会停掉整次同步，并进这次同步的自动触发也一起停。

### 面板（`codeIndexPresentation.ts`、`CodeRetrievalPanel.tsx`）

- phase 为 syncing / queued 时，标签显示「同步中」（title 写上阶段与进度），可以照常查询。
- 调度器在推进时（syncing / queued / rebuilding / backoff），面板每 1.5 秒静默读一次状态，不显示「检查中」，回到空闲就停。
- 被别的进程占锁时显示「等待重试」。失败横幅写明连续失败次数，以及多久后自动重试或已经熔断。监听失效时提示需要手动同步。全量重建期间（state 为 indexing）显示「索引中」，不能查询。

### 开关与退路

- `GREN_CODEGRAPH_AUTO_SYNC=off`（也认 `0`、`false`）关掉监听和激活补同步。手动同步与增量同步期间给旧结果不受影响。
- `GREN_CODEGRAPH_THREADS=off` 的单线程退路里没有调度器，也没有自动同步，读写互斥与改动前相同。

### 涉及文件

- 新增：`electron/app/codeGraph/syncScheduler.ts`（+ test）、`ui-harness/scenarios/code-index-sync.tsx`、`ui-harness/probes/code-index-sync.mjs`、`scripts/codegraph-auto-sync-smoke.mjs`
- 修改：`codeGraphEngine.ts`（`plan`、`runSync` 带 mode / paths 并返回结果、`refresh`、`watch` / `unwatch`、占锁错误改名）、`workerProtocol.ts`、`workerEntry.ts`、`codeGraphThreads.ts`、`codeGraphJobs.ts`、`hostContract.ts`、`hostEntry.ts`、`hostMethods.ts`、`codeGraphHostClient.ts`、`agentDataProcess/codeGraphClient.ts`、`agentData/codeRetrievalResult.ts`、`src/lib/agentData.ts`、`codeIndexPresentation.ts`、`CodeRetrievalPanel.tsx`

## Alternatives considered

- **手动任务附着到正在跑的自动同步，一起完成（提案原文）。** 最强理由：少跑一次同步，任务完成得更快。没选：正在跑的那次可能在用户最后一次保存之前就扫描完了，任务显示完成，索引里却没有这次改动。排到后面多花一次同步，大部分情况下只是一次没有改动的扫描。
- **启用 SDK 自带的 `graph.watch()`。** 最强理由：官方路径，代码最少。没选：它直接调 `graph.sync`，绕过了调度器，做不了全局只跑一个、统一的状态与失败出口、写完让读线程换连接。
- **FileWatcher 的 syncFn 等到真正同步完再返回。** 最强理由：能复用 SDK 自带的 `pendingFiles`（防抖窗口内的改动也能报出来）和占锁重试。没选：SDK 的监听有自己的一套重试预算，持续失败后会自己停掉，和调度器的退避、熔断互相打架；跨线程等待也让合并变复杂。现在待进索引的路径由调度器记，代价是防抖窗口（1 秒）内的改动提示不出来。
- **读线程清掉 nodeCache，不换连接。** 最强理由：省一次打开数据库。没选：`QueryBuilder` 是 `CodeGraph` 的私有字段，伸手进去依赖 SDK 内部实现。重开连接用的是公开 API，开销也小（grammar 已经初始化过，只多一次打开数据库）。
- **保留「写之前先让读线程 evict、写期间 busy」。** 最强理由：最简单，而且已经验证过。没选：自动同步之后，每次保存都会让查询在同步期间报 busy。
- **查状态也算激活（提案里面板切换项目时调 touch）。** 没选：诊断（`agentDataDiagnostics`）和输入框的项目概览会批量读状态，会把每个已知项目都挂上监听、跑一遍同步。改成由查询和搜索触发，面板打开时的文件列表查询正好就是一次。
- **自动同步遇到索引不完整或抽取器过期时升级为全量（提案的 planFor）。** 没选：全量重建要停读几分钟，不该在用户没要求时自己开始。SDK 的 `sync()` 能补上次被打断的索引；抽取器升级后的重建，提案本来就默认手动（`rebuildOnEngineUpgrade: manual`）。
- **防抖 2000ms（SDK 默认值、提案原值）。** 没选：调度器自己会合并请求，防抖只需要盖住一次保存产生的那串事件。1 秒能让模型改完再查之间的滞后更短。

## Consequences

- 收益：真实宿主冒烟（`extensions/` 副本 551 个文件）中，从新增文件到符号可查用了 660 ms，删除文件后 463 ms 查不到。一次新增 400 个文件，3.9 s 同步完，期间同一工作区查询 54 次，0 次 busy、0 个错误，其中 36 次结果带 servingStale 标记。别的进程持锁期间状态是 backoff，没有被记成失败，锁释放后约 9.5 s 自动补上。自动同步在跑时发起的手动同步排在后面，正常完成。
- 代价：
  - 写线程在第一次查询已索引的工作区时就会启动，以前要等到第一次同步才启动，多加载一份 SDK。
  - 最多常驻 3 个递归 `fs.watch`。
  - SDK 构建忽略规则时，会在写线程里调用 `git`（与原来手动同步时的行为相同，只是现在更频繁）。
- 已知上限：
  - 增量同步期间，读可能看到部分文件已更新、部分还没更新（SDK 按文件分批提交）。还没有用 `PRAGMA data_version` 检测这种混合读。
  - 没有持久化：重启后，第一次查询会触发补同步，而这一次查询本身拿到的仍是补同步之前的结果。
  - 熔断只在状态和诊断里可见，不会在任务中心建失败任务。
  - 自动同步要等所有手动同步结束才开始。
- 需要重新评估的信号：
  - `runtime-diag.jsonl` 里频繁出现 `codegraph-sync-event`（failed / breaker）。
  - `watcher.degraded` 常见（EMFILE、WSL）。
  - 用户在任务中心找不到熔断后的失败。

## 验证

证据目录：`.agents/evidence/2026-10-18-codegraph-auto-sync-and-stale-reads/`（见其中 README）。

- 冒烟 `scripts/codegraph-auto-sync-smoke.mjs`：用 `electron-vite build --mode localrun --outDir out/cg-smoke` 构建出的真实 `codegraph-host.js` 和 `codegraph-worker.js`、真实 SDK、应用自带的 Electron Node，17 项全部通过（`smoke.txt`、`smoke.json`）。
- `npm run test:codegraph`：11 个文件 108 个用例通过（`test-codegraph.txt`）。其中 `codeGraphThreads.sdk.test.ts` 在真实 SDK 上确认了这些事实：
  - 两条连接，一条做增量同步时，另一条读 300 个文件的变更不出错；`refresh` 之后能看到新符号。
  - 带路径的同步只比对给出的路径。
  - FileWatcher 能把真实的编辑报成路径，而且自己不触发同步。
  - 别的活进程持有 `codegraph.lock` 时，`sync()` 抛 `LockUnavailableError`。
- 单测：
  - `syncScheduler.test.ts` 15 个用例：合并、整树比对吸收路径、手动排队、手动按 plan 而自动只走增量、不建索引、车道、优先级、退避序列、熔断与重新试、占锁延后、取消、队列上限、关停。
  - `codeGraphThreads.test.ts` 22 个用例：增量期间可读并 refresh、全量期间 busy、第二个手动任务排队、首次查询挂监听并补同步、只读状态不激活、change 事件转成带路径的同步与给模型的提示、LRU 淘汰、监听失效后补同步、写线程崩溃后重新挂监听。
  - 另外还有 `codeGraphEngine.test.ts`、`codeGraphJobs.test.ts`、`codeGraphHostClient.test.ts`、`codeIndexPresentation.test.ts`。
  - 相关目录合跑结果见 `vitest.txt`：516 个通过，10 个失败，失败的都在 `electron/agentData/{auditViewStore,jobCleanup,runtime}.test.ts`，在干净的 HEAD 上同样失败，与本改动无关。
- UI：`npm run ui:check -- code-index-sync` 22 项通过，`npm run ui:check -- code-retrieval-panel` 全部通过。
- 类型检查：改动涉及的文件里，只剩一条已有的 `codeGraphQuery.ts(91)` 错误（`tsc-node-changed.txt`、`tsc-renderer.txt`）。
