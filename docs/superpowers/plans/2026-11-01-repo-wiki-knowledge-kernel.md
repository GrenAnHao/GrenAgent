# Repo Wiki KnowledgeKernel 实现计划

> **执行状态：** 用户已批准并按 subagent-driven-development 完成内核与 UI 改造。原始复选框保留规划粒度；实际完成范围和实跑证据以 [验收记录](../../../.agents/evidence/2026-11-01-repo-wiki-knowledge-kernel/ACCEPTANCE.md) 为准，不把计划中的每个故障注入场景都冒充已实跑。

**目标：** AgentData 托管具有自动规划、只读工具探索、阶段恢复、增量与修复能力的 Wiki / Cards 构建内核，页面和任务中心消费同一后端状态。

**架构：** agent_jobs 保持唯一任务身份与状态，AgentData 同库保存已校验阶段产物、输入 manifest、租约与计量。独立 repo-wiki-host 执行阶段与文件操作；Pi 官方 core Agent 经完整 AssistantMessage broker 使用现有知识模型和共享 LLM 并发门。项目文件继续保存正式知识与发布收据，journal/claim 协调跨存储恢复。

**技术栈：** 当前 TypeScript、Node SQLite、Electron、Pi SDK 1.3.0 的公开 Agent/ModelRuntime API；不接入 Qoder 运行包，不新增产品依赖。

**规格：** [设计规格](../specs/2026-11-01-repo-wiki-knowledge-kernel-design.md)。[实施决策](../../../.agents/notes/implemented/architecture/2026-11-01-repo-wiki-knowledge-kernel.md)记录历史取舍。

## 全局约束

- 使用当前未提交工作区作为功能基线，开工规划时已有 583 项 dirty。实施前保存状态和目标文件快照；不得还原、清理或自动提交这些改动。
- 用户后续已明确授权实施，未授权提交或发布。本轮在 `codex/repo-wiki-knowledge-kernel` 分支保留当前完整工作区基线，不从缺失新 Repo Wiki 的旧 HEAD 另建净工作区。
- 既有 agent_jobs、AgentData 启动恢复、项目 docs/repo-wiki、文件 token/journal、克隆/语言隔离、人工编辑保护保留。
- 用户手动暂停重启后仍暂停；应用退出导致的暂停自动继续；主动取消不复活。新的付费任务仍需要现有确认。
- 实际 SDK 版本以 lockfile/本地声明为准；当前为 1.3.0，不能按 cli 注释的旧版本设计。
- 只读工具为 Read/Glob/Grep/ListDir；无用户 extensions/MCP/skills、shell、网络或写文件工具。
- 每次 assistant 请求获取一次同一知识 LLM 槽；工具执行和整个 stage 不占该槽。provider retries=0，内核单层重试。
- 每项产物 <=512 KiB；固定预算取规格 §8 的确切值。恢复不得清零预算。
- source/model/plan 变化阻断旧任务，明确重新分析/确认，不静默扩大重做范围。
- 只跑当前需求 UI 场景及被直接修改的任务组件；全量 UI、发布、付费模型与用户真实数据迁移不在本次验证范围。

## 审查重点

1. **文件发布完成但任务未落定**：receipt/journal reconcile 必须直接结算，不调用模型或覆盖后续人工编辑。任务 7、8、12 验证。
2. **旧 worker/旧 epoch 迟到**：旧输出、模型请求和 publisher 不能越过新 fence；旧 HTTP 未 drain 不启动新预算。任务 2、3、7、8 验证。
3. **模型/源码身份变化或检查点缺失**：不能复用错误结果、凭配置“补造”授权或把缺文件当删除。任务 4、5、8、9 验证。
4. **部分失败与正式知识混淆**：prepared 成果不计 published，失败保留旧正式内容，repair 不重做已验证部分。任务 5、6、9、11 验证。
5. **取消/暂停/关停交错与预算**：排队取消、发布 pin、手动暂停和退出自动续跑各自落定，不能误完成、无限重试或提前释放并发槽。任务 3、8、10、12 验证。

## 文件责任与实施顺序

| 区域 | 新建文件 | 修改已有入口 |
| --- | --- | --- |
| 跨层契约 | shared/knowledgeKernelContracts.ts | electron/agentData/operationsContracts.ts、jobStore.ts、taskViewStore.ts、src/lib/agentData.ts |
| AgentData 内核 | electron/agentData/knowledgeKernel/{store,coordinator,pipeline,projection,recovery,incremental,validation}.ts | storage.ts、runtime.ts、agentDataProcess/{assemble,host,contract,modelPort}.ts |
| 模型请求 | electron/agent/knowledgeModelTurn.ts、electron/agentData/knowledgeKernel/modelRequests.ts | modelRuntimeHost.ts、createAgentDataModelPort.ts、wikiEngine/service.ts、main.ts |
| worker 阶段 | electron/knowledgeProcess/{stageRuntime,readTools,stageProtocol,pipelinePrompts}.ts | agent/repoWikiHostBuild.ts、vendor/repo-wiki/packages/process/src/{client,child}.ts |
| 项目事实端口 | electron/knowledgeProcess/projectPort.ts | vendor/repo-wiki/packages/core/src/{engine,project-files,scanner}.ts、packages/service/src/service.ts |
| UI/任务中心 | src/features/repoWiki/knowledgeProjection.ts | RepoWikiWorkspace.tsx、vendor App.tsx / GenerationOverview.tsx、AgentDataTaskProvider/JobsPanel/TaskDetailDrawer/operationsPresentation |

表内路径除 docs 外均相对 electron-agent。新模块围绕职责建文件，不顺带拆分其他旧模块。

依赖：1 → {2,3,4}；{2,3,4} → 5 → 6；2 → 7；{2,3,5,6,7} → 8 → 9 → 10 → 11 → 12。2/3/4 可分文件并行，7 在存储契约固定后可与阶段实现并行；生产切换集中在 10，不长期保留双驱动。

### 任务 1：固定跨层契约与严格检查范围

**文件：** 创建 `shared/knowledgeKernelContracts.ts`、`electron/agentData/knowledgeKernel/contracts.test.ts`、`tsconfig.knowledge-kernel.json`；修改 operationsContracts.ts、jobStore.ts、src/lib/agentData.ts、package.json。

**接口：** 采用规格的 KnowledgeDomain、KnowledgeIntent、KnowledgePhase、KnowledgeKey、ExecutionFence、KnowledgeBudgets、KnowledgeTaskMetadata、KnowledgeMessageInput。新增 `StartKnowledgeTask`、`KnowledgeActionInput`、`RepoWikiKnowledgeSnapshot`、`StageExecutionRequest/Result`、`PublishClaim/Receipt`，所有请求包含 version、taskId/idempotency key 与适用的 revision/fence，payload 不含凭据。

- [ ] RED：合法 v1 DTO round-trip；未知版本、缺原确认、非法 phase/branch/language、伪造 fence 和过大 payload 被拒绝；旧 JobMetadata 读回不被裁掉。
- [ ] 实现纯数据契约及 allowlist parser；`JobState` 加 paused/blocked、TaskStatus 加 paused，其他 kind 语义不变。Start 请求为 requestId、projectId、domain、language、intent、confirmExternal、expectedModelIdentity、expectedPlanToken；预检提供当前模型展示身份和 digest，复用现有确认窗口。
- [ ] `StageExecutionRequest` 固定包含 taskId、key、fence、phase、itemId、attempt、inputHash、sourceSnapshotId、model binding、budget；Result 包含 disposition、payload、outputHash、evidence/dependencies、usage 摘要。模型 turn transcript 使用 SDK TranscriptContext，响应完整 AssistantMessage。
- [ ] 将 shared、内核、模型 broker、worker 及直接修改的 UI 文件纳入严格工程；新增 `typecheck:knowledge-kernel`，不以根 files=[] 工程替代验证。
- [ ] GREEN：`npx vitest run electron/agentData/knowledgeKernel/contracts.test.ts`；`npm run typecheck:knowledge-kernel`；确认无新的 SDK/runtime 产品依赖。

### 任务 2：AgentData 阶段存储、租约与单调确认

**文件：** 创建 knowledgeKernel/store.ts、store.test.ts、lease.test.ts；修改 storage.ts、jobStore.ts、storage.test.ts。

**接口：** `KnowledgeBuildStore.createTask(input): Job`、`claim(scope,taskId,ownerId,diskFloor): ExecutionFence`、`commitItem(result,expectedItemAttempt): ItemAck`、`readCheckpoint(ref): VerifiedArtifact`、`pinPublication(claim:PublishClaim)`、`settlePublication(receipt:PublishReceipt)`。共用 AgentData 现有 DatabaseSync 连接。

预算接口为 `beginAttempt(taskId,phase,itemId,fence)`、`reserveExecutionBudget(request)`、`finishExecutionBudget(requestId,actual)`；request kind=model/tool/time，time 每片最多 5000ms。预算与成果分别持久化，不能等待 commitItem 才记已发生的调用。

- [ ] RED：schema 5 fixture 升级两次均成功且旧表计数不变；两连接抢同 scope 仅一方成功；旧 generation/owner/revision 写入无效；同 item ACK 重发不重复计数。
- [ ] 实现规格 §5 四张新增表和索引、metadata.repoWiki 版本化读写。`putSourceSnapshot(taskId,fence,manifest)` 校验<=4 MiB manifest 并返回 snapshotId，prepare item 只存引用。commitItem 按 fence/stageAttempt/inputHash 校验，在同事务读取当前 job revision、写 item、推进 revision/count，再允许事件/ACK；模型 usage 更新不得导致有效条目被旧 revision 错拒。
- [ ] payload >512 KiB 或 hash 不符失败；source manifest 不保存整仓代码；model attempt requestId 去重。删除任务检查 paused/blocked 与 repair 引用，发布后仅回收可由文件 manifest 重建且无引用的 payload。
- [ ] knowledge_execution_requests 覆盖模型、工具、读量与时间片 reservation；先持久化再派发，已发未结算记 unknown。强杀于 HTTP/工具已执行但 item 未 ACK，证明 2 attempts/40 tools/2 MiB/10min 剩余预算不重置。
- [ ] 测试 DB 清理/重建不删除项目 guard floor；无 job/确认记录不得从 guard 自动建任务；清索引后 AgentData 成果仍可恢复。
- [ ] GREEN：`npx vitest run electron/agentData/knowledgeKernel/store.test.ts electron/agentData/knowledgeKernel/lease.test.ts electron/agentData/storage.test.ts electron/agentData/jobStore.test.ts`。

### 任务 3：完整消息 broker、共享限流与 epoch drain

**文件：** 创建 agent/knowledgeModelTurn.ts、knowledgeModelTurn.test.ts、knowledgeKernel/modelRequests.ts、modelRequests.integration.test.ts；修改 modelRuntimeHost.ts、createAgentDataModelPort.ts、wikiEngine/service.ts、agentDataProcess/{modelPort,host,contract}.ts、main.ts。

**接口：** `KnowledgeMessagePort.bind/request` 按规格 §7；私有 `agentdata.knowledge.message`、`main.knowledge.message`、`main.knowledge.abort`、`main.knowledge.bindEpoch/activateEpoch/ackUsage`。`withKnowledgeModelSlot<T>(work,signal):Promise<T>` 复用现有同一 refreshing limiter。

- [ ] RED：真实官方 Agent 经 broker 走两轮 toolCall/toolResult 后结束；调用 ID、thinking signature、tool arguments、stopReason 和 usage 保真；error/auth/aborted 以 SDK error event 结束而非 reject streamFn。
- [ ] 提取现有模型身份 resolver，主进程保留真实配置，worker 只拿 public descriptor+opaque bindingId。`streamSimple(...).result()` 原样返回完整消息；旧 completeKnowledge 的 string 契约不变。
- [ ] global concurrency=1：旧 Wiki 请求占槽，新 turn 等待；工具运行可让出槽；排队取消不发 HTTP，在途取消等待实际 settle；429 最多受内核 2 attempts 约束，provider maxRetries=0。
- [ ] 在获得槽位后、HTTP 发送前持久化首个 active-time reservation，实际请求期间续领；loopback provider 到达时可查到 reservation，排队期间无 provider 时间扣减。
- [ ] 模型/自定义 headers 改变在派发前和 transformHeaders 拒绝；正常 OAuth 刷新成功。usage 成功/失败/取消均按 requestId 落账，重复响应不加倍。
- [ ] 旧 epoch 崩溃后，bindEpoch 仅等待 provider settle/worker 退出，不等待死 controller 的 DB ACK；新 AgentData 禁止派发地接收旧 usage reports，事务 reconcile 后 activateEpoch。main report 丢失沿 reservation 记 unknown。测试 provider 返回前/后、usage ACK 前/后故障均不死锁、不漏预算、不越并发。所有私有端口不进入通用 extension socket 白名单。
- [ ] GREEN：点名新增两文件，并回归 `electron/agentData/createAgentDataModelPort.test.ts electron/agentData/knowledgeCompletion.test.ts electron/agentDataProcess/host.test.ts electron/app/repoWikiWorkflow.integration.test.ts`；全程本地 provider。

### 任务 4：受限工具和官方 Agent 阶段运行时

**文件：** 创建 knowledgeProcess/readTools.ts、readTools.test.ts、stageRuntime.ts、stageRuntime.integration.test.ts、stageProtocol.ts；修改 repoWikiHostBuild.ts、vendor process client.ts/child.ts。

**接口：** `createKnowledgeReadTools(policy,manifest): AgentTool[]`、`runKnowledgeStage(request,ports,signal): Promise<StageExecutionResult>`。复用公开 SDK 工具参数 schema，execute 由授权 wrapper 实现。

- [ ] RED：Read/Glob/Grep/ListDir 正常循环可生成带证据结果；`..`、绝对路径越界、UNC、junction/symlink、大小写别名和指向输出目录均被拒绝，provider 看不到被拒内容。
- [ ] Agent 只装四个工具，sequential 执行；不导入 makeGrenRuntimeFactory/WorkspaceHandle/AgentSession 资源发现。Grep 固定 shell=false 参数与文件 manifest，不能通过 context=0 绕过检查。
- [ ] 落实规格预算：12 model turns、40 tools、2 attempts、8192 output、120000 total tokens、256 KiB/2 MiB read、400 lines、32 KiB result、100 matches、200 entries、120s request/10min active deadline。模型/工具先获持久 reservation；active-time 每次预扣<=5000ms，排队不续领，断联中止。输出截断标识必须参与验证；两次尝试与重启不重置累计预算。
- [ ] 工具观测输出直接/传递来源和搜索 scope digest；每次读文件 hash 与 pinned snapshot 不符停止该单元。未知 usage 不是零消耗。
- [ ] 只给 supervisor 增加私有 stage/model/item ACK 帧，不放入 renderer ACTIONS；旧 epoch/伪造 scope 帧拒绝。更新 host bundle 严格工程和构建测试。
- [ ] GREEN：新增两个文件 + `electron/agent/repoWikiHostBuild.test.ts`；实际 Electron child 发真实工具调用，不能仅用 mock Agent 证明循环。

### 任务 5：Wiki 阶段图、目录规划与条目检查点

**文件：** 创建 knowledgeKernel/pipeline.ts、validation.ts、wikiPipeline.test.ts、knowledgeProcess/pipelinePrompts.ts；修改 core engine.ts 的可复用事实/扫描端口，停止向旧 monolithic generator 堆编排。

**接口：** `buildWikiStageGraph(input): StageGraph`、`selectReadyItems(graph,checkpoints): Item[]`、`validateStageResult(request,result): ValidatedItem`；stage ID 严格使用规格集合。

- [ ] RED：隔离多模块仓库自动得到 overview/plan/catalogue，逐层展开可恢复，ID/标题冲突、依赖环和悬空引用失败；作者计划约束仍有效。
- [ ] 实现 prepare→overview→plan→catalogue→generate→validate 的冻结图；每个展开节点和页面独立 ACK，已确认 item 不重复调用，目录未冻结时不伪造总进度。
- [ ] 冻结整任务上限：500 个规划单元、目录深度 6、1000 次模型请求、2000000 累计 tokens；先预扣任务与单元两级预算，目录循环/膨胀或跨重试不会绕过上限。达到上限保留成果并返回明确 reason，不静默截断目录。
- [ ] 单页失败继续无依赖页、阻塞依赖者；staged 可预览，必需条目不齐不会发布或推进 current。模型输出须通过 schema、来源行范围、目录/链接和非空/完整输出验证。
- [ ] 每个 phase/item ACK 后强杀，恢复仅重做未确认单元；length/invalid JSON/预算耗尽不能成为合法 checkpoint。源码、计划 token 或配置改变返回明确 blocked reason。
- [ ] GREEN：`npx vitest run electron/agentData/knowledgeKernel/wikiPipeline.test.ts`；已有 engine/project-files 回归使用正式 `npm run test:repo-wiki` runner，保留原断言。

### 任务 6：Cards 阶段、模块卡与关系校验

**文件：** 创建 knowledgeKernel/cardPipeline.ts、cardPipeline.test.ts；复用任务 5 graph/validation/prompt 设施。

**接口：** `buildCardStageGraph(input): StageGraph`；item ID 区分模块/类别卡、仓库综合卡和 relation batch，不能与 Wiki 页 ID 冲突。

- [ ] RED：模块规划→类别卡→仓库综合→关系→验证；关系端点不存在、自环、非法类别和重复边被拒绝。
- [ ] module/card/relation 批次均独立确认，综合卡依赖项明确；Cards 使用同一知识模型预算、source manifest 和暂停/修复语义，不额外建任务表。
- [ ] 卡片部分失败时旧正式卡继续读，成功 staged 卡与失败项保留；恢复/repair 不重复已验证卡或关系批次。
- [ ] GREEN：`npx vitest run electron/agentData/knowledgeKernel/cardPipeline.test.ts`；点名 vendor cards 相关回归由正式 runner 实跑，结果独立记录。

### 任务 7：发布 fence、journal v2 与收据协调

**文件：** 创建 knowledgeProcess/projectPort.ts、publication.integration.test.ts；修改 core project-files.ts、对应 project-files/migration tests；复用任务 2 store pin 接口。

**接口：** `installExecutionFence(scope,fence,expectedGuard)`、`preparePublication(taskId,fence,manifest): PublishClaim`、`commitPublication(claim,facts,expectedTokens): PublishReceipt`、`reconcilePublication(claim): PublicationRecovery`。

- [ ] RED：同语言 Wiki/Cards/不同 branch 两写者互斥；旧 owner 迟到发布失败；新 DB generation 必须高于磁盘 floor。
- [ ] 保持 facts schema_version=1，仅新增版本化 baseline/inputManifest/last_publication；journal v2 加 claim/generation/intent/output hash，仍能恢复 v1。guard 是协调记录，不是调度源，不自动删除。
- [ ] publication pin 后服务端关 cancel/pause；锁内检查 fence/claim/token，prepared 后按已有 journal 完成 roll-forward，TTL 不抢活锁。project.json 收据最后写，outputSetHash 排除收据自身。
- [ ] 对 prepared 前、每个 rename 后、receipt 后但 ACK 前、索引 COMMIT 失败和 task COMMIT 失败注入故障。恢复先 journal 再 receipt，再结算；模型调用次数保持不增加。
- [ ] receipt 已完成后发生合法人工编辑再丢回执：保留新编辑，原发布任务按已发生的历史结算，不重新发布旧正文。未知外部内容仍阻断并保留备份。
- [ ] GREEN：`npx vitest run electron/knowledgeProcess/publication.integration.test.ts` + 正式 vendor project-files/migration 回归；实际 child 强杀和重新进程验证，不能只 mock rename。

### 任务 8：内核协调器、控制、启动恢复与兼容迁移

**文件：** 创建 knowledgeKernel/coordinator.ts、recovery.ts、coordinator.test.ts、recovery.integration.test.ts；修改 runtime.ts、assemble.ts、host.ts、JobStore/任务清理相关函数。

**接口：** `KnowledgeKernelCoordinator.start(input):Promise<RepoWikiKnowledgeSnapshot>`、`execute(taskId)`、`act(input)`、`recoverPending()`、`close()`。任务 runner 仅调用 execute；所有终态由 coordinator 条件事务结算，不再按“runner return即complete”处理。

- [ ] RED：重复 requestId/同目标不重复派发；queued 暂停/取消、运行暂停、暂停后重启、退出后重启、cancel/close 交错分别达到规格状态。
- [ ] 启动先 bind epoch/drain、确认旧 worker 退出、恢复 pinned publication，再按原模型/来源/预算恢复合格 auto task。手动 paused 不重放；无原确认/模型变化/未知发布进入 blocked。
- [ ] 旧 metadata、workspace-runs 和 generation_checkpoints 仅按当前任务迁移；可证明的旧成果转入 AgentData item 后才 ACK，无法证明则明确 confirmation_required，不运行旧第二驱动。
- [ ] tests 覆盖缺失 artifact、旧 generation/旧 revision、DB 被删除/恢复旧备份、权限撤销/克隆/分支/语言变化、controller drain 失败；不能凭 guard 恢复付费任务。
- [ ] 新 paused/blocked 状态不被 clearCompleted/孤儿清理误删；其他 job kind 和 Memory 裁撤保持原语义。
- [ ] GREEN：新增协调与恢复测试 + `runtime.repoWikiJobs.test.ts jobStore.test.ts jobCleanup.test.ts`，使用临时双进程和 loopback。

### 任务 9：增量影响图与定向 repair

**文件：** 创建 knowledgeKernel/incremental.ts、incremental.test.ts、repair.test.ts；修改 scanner.ts 以暴露 coverage/manifest，保留原排除规则与异步取消。

**接口：** `analyseKnowledgeDelta(baseline,current,definitions): DeltaPlan`、`prepareRepair(parentTask,currentIdentity): RepairSelection`。DeltaPlan 返回 noop/advance/replan/affected 之一，并列出可复用、失效与删除理由。

- [ ] RED：Git commit 变化但内容不变不发模型；dirty baseline 恢复 HEAD 仍检测变化；staged/unstaged/untracked、non-Git、rename/delete 和旧/新边并集正确传播。
- [ ] 按规格 §10 计算影响，结构性变化重新规划；unknown coverage 不归档页面，不把 Git 错误当 non-Git。每项来源、搜索 scope、依赖输出与计划 hash 共同决定复用。
- [ ] repair 新 taskId+retryOf，引用父任务已验证成果；改变模型/来源/计划时显示重做范围并重新确认。不得复用旧 taskId 命中旧 completed 快捷返回或删除父任务检查点。
- [ ] 人工编辑页继续三方合并，冲突保留正文与候选。修复成功后由同一 publication 路径原子发布。
- [ ] GREEN：`npx vitest run electron/agentData/knowledgeKernel/incremental.test.ts electron/agentData/knowledgeKernel/repair.test.ts`；补实际 Git temp repo、dirty/non-Git 与 Windows 大小写 fixture。

### 任务 10：生产入口切换、统一读模型与能力

**文件：** 创建 knowledgeKernel/projection.ts、projection.test.ts；修改 repoWikiService.ts、main.ts、runtime.ts、assemble.ts、taskViewStore.ts、taskViewService.ts、vendor service.ts/contracts/src/index.ts。

**接口：** `admin.knowledge.{prepare,start,action,snapshot}` 仅可信宿主；renderer 沿现有 repoWiki_* 桥调用。`projectTaskSnapshot(key)` 返回规格四维 DTO；TaskPage 增 pollingCount。通用 extension socket 不可直接调用生成私有端口。

- [ ] RED：开始后查任务/阅读页得到相同 taskId/revision/count；动作 accepted 不等于任务已完成；发布期 task center cancel/pause 均关闭；paused 不造成无限高频轮询。
- [ ] repoWiki_generate 不再直接 bare admin.jobs.create，TaskView retry 不再绕过 coordinator；未携带冻结输入/原确认的旧创建调用明确拒绝或走受控迁移。
- [ ] 移除生产 RepoWikiService 内 taskTails/私有终态队列、vendor workspace-runs 的独立派发与恢复；保留 standalone 上游接口所需兼容代码，但 embedded 模式不可达，测试证明无双执行。
- [ ] 旧完成记录仍可查看，旧资料 Wiki、代码索引和默认任务视图不重写。发布文件状态与运行状态独立；刚恢复文件只标 available，验证后才 current。
- [ ] GREEN：projection/task view tests + repoWikiService/lazyHost/durable/workflow 集成；只读状态不扫描，已有七项目首屏行为保持。

### 任务 11：Repo Wiki 与任务中心的四维 UI

**文件：** 创建 features/repoWiki/knowledgeProjection.ts 及测试；修改 RepoWikiWorkspace.tsx、AgentDataTaskProvider.tsx、JobsPanel.tsx、TaskDetailDrawer.tsx、operationsPresentation.ts、vendor App.tsx/GenerationOverview.tsx，以及 ui-harness repo-wiki 场景/probe。

- [ ] RED：已发布+生成中、已发布+失败、无正式结果+部分草稿、paused、blocked、queued、发布 pin、未知总数、available 未检查等组合展示正确。
- [ ] 根据统一 DTO 显示阶段、当前条目、准备/发布数、失败项和服务端能力；目录未冻结使用不定进度，100% 等结算完成。动作提交中只锁当前请求，不伪造 runState。
- [ ] 生成/更新/暂停/继续/取消/修复路径贯通；修复确认模型/项目/语言/重做范围自动可见，草稿预览标未发布；旧正式内容和编辑草稿不因刷新丢失。
- [ ] 当前项目事件优先、单飞读取兜底；隐藏停读、重开补读、跨项目语言跳转、迟到轮询与旧事件隔离保持；paused/blocked 不永久高频刷新。
- [ ] GREEN：相关组件定向 vitest，`npm run ui:check -- repo-wiki`。只在共享任务导航/状态枚举被修改时追加 `agentdata-memory-retirement`；不跑全量 UI。检查深浅色、窄屏、长抽屉与真实 hit test。

### 任务 12：完整工作流、发布验证与决策落地

**文件：** 新增/更新 app/repoWikiKnowledgeKernel.integration.test.ts、现有真实 workflow fixture、构建/许可/严格配置测试、docs/repo-wiki.md 与架构；更新本提案后按真实结果转 implemented。

- [ ] 使用真实 AgentData child + repo-wiki child + 官方 Agent + 主进程 ModelRuntime/Pi SDK + loopback HTTP，完整跑自动规划、工具探索、全量 Wiki/Cards、逐阶段强杀恢复、增量、partial repair、暂停/取消及旧资料 Wiki 并发。
- [ ] 按规格 §13 五类最高风险矩阵记录实际 PID、请求/工具次数、检查点复用、receipt、输入/输出 hash 和时间顺序。不得用 UI 桩当成 SDK/调度证据。
- [ ] `npm run typecheck:knowledge-kernel`、`npm run typecheck:repo-wiki`、`npm run test:repo-wiki`、`npm run test:repo-wiki-ui`、`npm run build`；验证开发和 app.asar.unpacked 形式资源路径，worker 退出与取消无遗留。
- [ ] 只对更改影响的 UI 场景验收；保留开工时旧失败/类型诊断基线，不以跳过原用例换绿。检查对外注册工具是否实际新增，若有静态 pi.registerTool 改动才额外跑 extensions/prompt-metadata.test.ts。
- [ ] 证据落 `.agents/evidence/2026-11-01-repo-wiki-knowledge-kernel/`，记录每组结果、限制与未覆盖面；`npm run verify-notes` 和定向 `git diff --check` 通过。转 implemented 前完成独立审查，不能因里程碑 A/B 通过提前宣称全内核完成。

## 执行记录

任务 1–11 已实现，任务 12 的实际执行命令、结果、独立复审和验证边界见验收记录。Wiki/Cards 真实双进程工作流覆盖全量、应用退出后断点恢复、增量与失败修复；其余故障窗口由对应存储、模型、发布和协调器定向测试覆盖。

共享契约固定后按存储、模型/worker、pipeline/协调器分工并行，跨存储发布与主进程接线集中集成；独立审查发现的问题已经修复并复核。未提交、推送或发布客户端，未调用付费模型或改动真实用户项目数据。
