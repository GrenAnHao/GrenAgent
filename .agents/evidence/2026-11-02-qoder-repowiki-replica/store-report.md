# Native Wiki store 与调度交付（静态实现，未执行）

## 接口与权威

`electron-agent/electron/wikiService/contracts.ts` 定义版本化输入、operation、fence、checkpoint、usage、manifest、publication、runner/admission ports。每项目由宿主传独立 dataDir 构造 `new WikiStore(dataDir)`，数据库为 `wiki.sqlite`；branch + locale 为分区，宿主必须校验并冻结 projectId 与 canonical repositoryRoot 的对应关系。只接收模型身份与用户授权、费用策略和有效配置，不保存模型凭据。

`new WikiService(store, ports)`：`start` 同步持久化 queued 并返回；相同 requestId、相同冻结输入返回相同身份；`query`、`partition`、`publication`、`outbox`、`ackOutbox` 不驱动模型；`run` 显式派发，先取得 admission 的跨版本锁和任务投影身份，再取得 native lease。`control(id, action, revision)` CAS 写入控制，pause/cancel 中断 runner；runner 必须停止派发、排空全部内部请求并结算用量后返回，服务才转 paused/cancelled。`recoverInterrupted` 仅供宿主在确认旧 executor 退出、锁释放后调用，当前 child 必须没有 active executor；确认旧 executor 已退出后可解除该 operation 的旧租约，其他 owner 的有效租约仍拒绝；未知 dispatched 变 unknown，不触发新请求。resume 是同一 operation 从 paused 回 queued，不清 checkpoint 或 usage；取消不可恢复。

Runner 的 context 暴露原始及解析 checkpoint、历史尝试、usage、上一正式分区、stage、fenced ACK、publish 和 AbortSignal。实际业务 runner 必须在发模型前写 dispatched，并在排空时写 actual/unknown；`publish` 必须在池排空之后调用。租约续期失败即 abort，过期或被替换的 owner 无法 ACK、结算或发布。host admission 的 release 必须直到 worker 排空后才释放旧版共享锁。

SQLite 表：operations（冻结请求、状态、revision、publication）、runs（每次调度）、leases（分区 generation/expiry）、checkpoints（最新业务项）、checkpoint_history（每次 ACK 原始及解析结果）、usage（逐请求）、publications（完整目录、逐页结果、成功集合、合并后的页面、失败债务及 baseline）、partitions（当前正式版本指针）、outbox（单调 seq、事件 id、消费状态）。服务 SQLite 是 native 内容事实源；项目文件和 AgentData 是消费者投影。发布在一个 `BEGIN IMMEDIATE` 事务里检查 fence、阶段/页面、合并成功页和显式删除、更新 baseline/指针、结算和写 outbox；提交后响应丢失查 operation/publication 可识别，不重新生成。文件投影需主进程 consumer 按 id 幂等处理并维护冲突语义。

## 覆盖与整合状态

本地基础已编写：operation 幂等及修复 CAS、分区租约与心跳、显式派发、控制/排空、resume、已确认的 repair checkpoint 拷贝、raw/parsed/history、用量状态、部分发布及失败债务、原有失败页保留、显式删除、事务性 publication/outbox。非空 full 全失败拒绝发布。事件包含 operation、stage 和 publication；重放只补投影。

代码整合已接入主进程 admission/AgentData 投影、共享模型槽、outbox 消费、reference runner、冻结 prior publication 和发布 CAS、增量恢复及 ProjectFiles 投影/冲突处理。它们尚未运行验收，不能将静态实现作为真实闭环证据。`requiredStages` 及原版最小正文/cite 校验依赖 runner，store 自身只校验声明的 stage、非空正文与逐页 checkpoint；不能将其作为原版完整 validator 验收。repair 的历史 usage 仍在 parent operation 中，消费者聚合时须沿 parentOperationId 展示，不能重复计费。接受时目前严格比较序列化输入，调用方应稳定构造输入。

## 未执行用例

`store.test.ts`：接受重放/冲突、部分发布。`service.test.ts`：暂停先持久化并 drain 后终态、保留 checkpoint、恢复、取消阻止发布、过期 fence、全失败不发布、11 页 9 成功及旧页保护。测试、类型检查、构建、真实数据库、模型和应用均未运行；这些是待用户执行的用例，并非通过证据。

## 追加：费用准入、宿主准入与退出

`WikiSpendingPolicy` 的 `maxModelRequests`、`maxTotalTokens` 均可选且默认无限制；没有继承旧内核累计上限。发起模型请求之前，runner 必须同步写入 `usage({requestId, state:'dispatched', reservationTokens})`，reservation 是有效 context window 加输出上限，用于风险预留而不是记账费用。存储事务沿 parentOperationId 验证项目、仓库、分区、目标身份并汇总祖先 actual 与 unknown/在途预留；超限抛 `SPENDING_LIMIT`，本次 dispatch 不落账。实际用量按供应商 totalTokens 结算，unknown 保留预留，不支持回退已结算用量。context 的 `usageRecords()` 和 `aggregateUsageRecords()` 均返回祖先到当前的完整记录，store 的 `usageRecords(id)` 只读该 operation。

admission 失败时 operation 保持 queued 并持久化安全错误码、递增 revision 并发 operation outbox；再次 run 仍需宿主主动决定。`service.close()` 拒绝新 start/run，将 active 的 queued/running 操作持久化为 application_exit pause、中止信号并等待 runner 和 admission release 排空，完成后状态 paused、error 为 `APPLICATION_EXIT`，重开后由调用方决定恢复；它不关闭 store，宿主应 await close 后再关闭 store。原异常文本不落库。新增费用拒绝/祖先统计、admission 错误、退出排空用例；均未执行。

每次成功发布必须有 `stage: source, itemId: '', disposition: done` 的 checkpoint，其 parsed 是 `{path, hash}[]`；发布事务将它冻结为 `WikiPublication.sourceManifest`，供后续增量比较。读取不含该字段的旧数据时由 runner 明确拒绝增量而不是伪造基线。


## Repo Wiki host RPC

现有 `repo-wiki-host` 通过 `knowledgeProcess/hostEntry.ts` 注册 `NativeWikiHost`；vendor process 的 v1 native 帧不改变 legacy knowledge 或 Workspace 协议。主进程 `RepoWikiProcessClient.setNativeRequestHandler(handler)` 处理 `native.admission`、`native.release`、`native.model`、`native.event`；`invokeNative(method,input)` 发送 native 请求。`native.configure {enabled}` 为进程级开关，默认 false；除 configure 外参数均含绝对项目 `dataDir`。接口：start `{dataDir,input}`、list `{dataDir}`、query/dispatch `{dataDir,operationId}`、control `{dataDir,operationId,action,expectedRevision}`、partition `{dataDir,branch,locale}`、publication `{dataDir,publicationId}`、outbox `{dataDir}`、ack `{dataDir,id}`、recover `{dataDir,operationId,previousExecutorExited:true}`。dispatch 返回当前 operation，不等待模型；身份和路径绑定、退出旧进程证明由可信主进程负责。若某 dataDir 已有不同 projectId/root 的任务，start 拒绝。

反向 admission `{dataDir,operation}` 返回 `{leaseId}`；成功表示主进程已持久化任务投影并获得跨版本锁；release 带 `{dataDir,operation,leaseId}`。model 含 `{dataDir,...WikiModelRequest}`（去掉 signal，requestId 与本次 usage 相同）；主进程返回 WikiModelTurn。取消发 `nativeReverseCancel`，只 abort handler signal，子进程直到 handler 确认真正完成才结束请求；主端不可在 provider 未排空时提前返回。event `{dataDir}` 是尽力通知，消费者始终从 outbox 拉取并按 id 去重/ack。启动和只读查询不自动调度；执行开关需主进程显式打开。

退出：native service.close 先持久化 application_exit pause、abort 并等待工作和 admission release；随后关闭 SQLite；一旦 supervisor 启用过 native，stop 不套用 legacy 三秒强杀截止，防止旧模型未排空却转移锁。主 IPC 突然断开时 child 无法确认远端 provider 排空，主进程必须持有锁直至自己的模型请求实际结束；不能仅凭 child 退出放锁。同步已保存 transport 原始文件于 `transport-preimage/`。`host.test.ts` 提供 gate、只读/幂等投影、目录身份冲突用例，尚未执行；真实 RPC/打包与主进程模型和跨版本锁接线需合并后手动验证。

大数据读取：outbox 事件只保存轻量身份/版本/阶段，`native.outbox` 支持 `afterSeq` 和 `limit`，默认及上限均为 100。`native.partition` 传 `summary:true` 返回 id/baseline/coverage 等轻量信息；`native.publicationChunk` 按 UTF-16 code-unit 偏移返回 JSON 分片（最大 262144 单元，不拆代理项；nextOffset 为 null 表示完成）。`native.project.project` 可传 dataDir/publicationId，子进程直接取快照交项目适配器，不必把大正文经 IPC 往返。关闭排空期间仍提供这些只读/投影/ack 路由，使主进程在 release 前可完成投影。分页和 Unicode 重组 fixture 已编写，未执行。

后续接口：publication 必须带 `expectedPriorPublicationId`（首次 null），服务在同一发布事务检查现有 partition identity，变更则 `BASELINE_CHANGED`。runner 通过 context.publication 读取已冻结版本。`native.inspect` 含 active 与分页 checkpoint 摘要、业务 session/模型/工具 accounting；详细事件 `native.events` 分页，正文 `native.draftChunk` 按 UTF-16 code-unit 分片。`native.requestDispatched` 要求当前有效 fence、dispatched usage 和已提交 event，由模型桥真正获槽时调用。`native.drain` 停止新派发并等待排空，但保持读取、投影、ack；`native.recover` 再次拒绝当前进程 active。已加入 baseline CAS 未执行 fixture；模型桥与实际 UI 投影仍由主进程 owner 接线。

收尾：inspect 的 waiting/inFlight 只计当前 active run 的已提交请求；paused 可经 revision CAS 取消并保留成果与用量。`native.list` 传 `summary:true` 使用 offset/limit 分页轻量记录（默认/上限 100）；无 summary 仍保留完整旧响应。三份本模块 fixture 已静态对照当前必填接口，未执行。实际 provider 排空、宿主跨版本锁/投影以及大数据端到端行为仍需主进程集成与用户手动验证；非增量 full 范围外历史页面仍保留，readable 统计目前包含这些旧页，需由集成方决定如何在 UI 区分活跃目录与保留内容。
