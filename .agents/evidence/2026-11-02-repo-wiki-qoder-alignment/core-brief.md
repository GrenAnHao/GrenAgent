# Repo Wiki 与 Qoder 生成机制对齐实施计划

> **面向 AI 代理的工作者：** 使用 subagent-driven-development 或 executing-plans 逐任务执行。用户于 2026-11-02 批准开始实现，要求先暂停现有生成，暂不运行付费模型测试；不提交、不推送、不发布。执行记录见本提案 evidence 目录的 IMPLEMENTATION.md。

**目标：** 先形成完整最终目录，再有界并行生成独立正文；按用途分配预算，同时保留已有恢复和原子发布契约。

**架构：** 同一个 AgentData KnowledgeKernel 持有图、账本和发布权；现有 Repo Wiki worker 支持同任务多个隔离 stage。模型请求仍共用 WikiService 并发门。新任务使用版本化策略，历史任务按冻结策略恢复。

**技术栈：** 现有 TypeScript、Pi SDK 1.4.0、SQLite、Electron、Vitest、ui-harness；不新增产品依赖。

**规格：** [proposed 笔记（设计、取值和验收）](../../notes/archived/architecture/2026-11-02-repo-wiki-qoder-alignment.md)。[Qoder 静态证据](../../../.agents/evidence/2026-11-02-repo-wiki-qoder-alignment/qoder-reference.md)。既有内核规格中未被本提案修改的存储、授权和恢复协议继续适用。

## 全局约束

- 本计划已获实施批准；付费模型测试仍未获准。先确认当前生成停止，保留草稿和恢复数据，再实施。
- Qoder 的目录阶段可逐节点并发展开，不把“整套目录”解释为只能请求模型一次。release 内置目录/页面并发 3 作为参考，不当作动态性能证据。
- 新任务 catalogue/page 并发均为 3；目录节点最多 64，深度 6；模型与工具额度逐字采用笔记 profile 表，run 仍为 1000 次请求、5000000 预算 tokens。
- 现有 unit 的公共上限、cache 预算折算、共享模型并发、文件事实源、journal/fence、人工编辑和四项状态边界不变。
- 历史任务没有 executionPolicy 时仍按其旧预算、旧图和串行规则恢复；repair 沿用父版本；只有新建/显式重新分析采用 v2。
- Git 差异不替代 dirty/untracked/源码 manifest；本轮不合并进程、不复制 Qoder 代码、不新增云同步或配置面板。
- 仅验证本需求；不跑全量 UI、不处理无关 dirty 文件。当前主目录有大量未提交成果，不能从缺少这些文件的旧 HEAD 重建“干净基线”。

## 审查重点

1. 同任务的第二项不能被 worker 拒绝或覆盖登记；第一项完成不能取消或清掉其兄弟。任务 2。
2. 并行结果不能丢 ACK/图更新；依赖只由持久化成果满足，失败不能卡死其他独立项。任务 4。
3. 最后一份 run 额度同时被多个请求预留时只能一方成功；旧任务恢复不能偷偷换 profile。任务 1、4。
4. 暂停/取消后不继续补槽，所有 HTTP/工具落定前不释放租约；旧 epoch 不能污染新页集。任务 2、4、7。
5. completed、prepared 与正式发布不同；漏页/空正文/伪 completion manifest 必须阻断整批发布。任务 5、7。

## 文件责任与执行顺序

下列产品路径均相对仓库根；新建文件只在现有模块需要独立职责时增加，不顺带重构。

| 交付物 | 主要文件 |
| --- | --- |
| 冻结策略、预算、执行身份 | `electron-agent/shared/knowledgeKernelContracts.ts`；新增 `electron-agent/electron/agentData/knowledgeKernel/executionPolicy.ts` 及测试；现有 store.ts、runtimeBridge.ts、contracts.test.ts、store.test.ts；`electron-agent/electron/agentData/storage.ts`、storage.test.ts |
| 多 stage 宿主与取消 | `electron-agent/electron/knowledgeProcess/host.ts`、host.test.ts；`electron-agent/electron/app/repoWikiService.ts`、repoWikiService.test.ts |
| readme 与目录图 | `electron-agent/electron/agentData/knowledgeKernel/pipeline.ts`、wikiPipeline.test.ts、coordinator.ts、validation.ts；`electron-agent/electron/knowledgeProcess/pipelinePrompts.ts`、projectPort.ts、projectPort.test.ts |
| DAG 调度与恢复 | 新增 `electron-agent/electron/agentData/knowledgeKernel/readyScheduler.ts`、readyScheduler.test.ts；coordinator.ts、runtimeBridge.ts、recovery.ts 及对应测试 |
| 完成清单 | 新增 `electron-agent/electron/agentData/knowledgeKernel/completionManifest.ts`、completionManifest.test.ts；validation.ts、coordinator.ts、projectPort.ts、publication.integration.test.ts；`electron-agent/vendor/repo-wiki/packages/core/src/project-files.ts` 的 baseline/发布校验入口 |
| 并行状态 UI | knowledgeKernel/projection.ts；shared 契约；`electron-agent/src/features/repoWiki/knowledgeProjection.ts`；`electron-agent/vendor/repo-wiki/apps/web/src/workspace/GenerationOverview.tsx`；AgentData 任务投影/详情；现有 repo-wiki 场景与 probe |
| 生产链路验收 | 现有 repoWikiKnowledgeKernel.integration.test.ts、repoWikiRealModel.e2e.test.ts、repoWikiHostBuild.test.ts，及 `.agents/evidence/2026-11-02-repo-wiki-qoder-alignment/` |

顺序：1 → 2 → 3 → 4 → 5 → 6 → 7。同一人负责 coordinator/graph/store 的串行化契约，不能把共享状态机按文件分给多个同时写入者。UI 可在任务 4 的投影接口稳定后独立实现，再整体集成。提交操作仅在另获授权时进行，不使用全仓 `git add`。

### 任务 1：冻结策略、预算解析和旧任务兼容

**接口：** 保留 KnowledgeBudgets v1。新增 `KnowledgeExecutionPolicyV2`（version=2，catalogueConcurrency/pageConcurrency/maxCatalogueNodes 与完整 profiles）和可选 metadata.executionPolicy。`resolveKnowledgeUnitBudget(metadata,stageKind): KnowledgeBudgets['unit']` 为预算唯一解析器；stageKind 是笔记列出的 7 个模型用途，与 model/tool/time 计量种类不同。`knowledgeExecutionKey(scope: KnowledgeExecutionScope): string` 只编码 task/fence/phase/item/attempt。

- [ ] RED：新增 executionPolicy.test.ts，断言旧 metadata 无 profile 时仍得到原 unit；overview/plan/catalogue/page/Card 各返回笔记中的确切额度；未知版本或不完整 profile 拒绝。改变默认值再恢复旧任务，额度和并发不变。
- [ ] RED：在 store.test.ts 用两个独立条目争最后 1 次模型请求/剩余 token，断言只有一次 reservation 成功；重发相同 requestId 幂等。profile 单元余额与 run 余额分别耗尽，重试不重置。
- [ ] RED：同为 generate 的 module-card 与 repository-card 在 store 准入处分别得到 20/60/300000 与 12/32/200000 的请求/工具/token 上限；worker 自报其他 kind 不影响预算。v1 空 kind 行仍按原 unit 准入；schema 6→7 重复迁移不丢行。
- [ ] 实现 metadata schema 可选扩展与冻结存储；pipelineConfigHash 包含图/提示词/profile 版本。旧 metadata 严格解析和旧外部调用继续可用；repair 复制父策略，不升级。
- [ ] AgentData schema 6→7，为 knowledge_build_items 幂等增加 `stage_kind TEXT NULL`。beginAttempt 保留原参数，并增加末尾可选 `{stageKind}`；仅 coordinator 从冻结图登记 v2 kind，校验 domain/phase/ID 与该图一致。store 的预算/剩余额度和 runtimeBridge 从条目读取 kind，禁止依赖 worker 提供的用途。新策略记录缺 kind 明确失败，不降级套用默认预算。
- [ ] 把 store 的 beginAttempt/reserve/budgetRemaining、runtimeBridge 的 timeout/token reservation、coordinator 下发的有效 unit、stageRuntime 的预算提示统一接到解析器。不得仅换 Agent 提示而不改持久化准入。
- [ ] GREEN：`cd electron-agent; npx vitest run electron/agentData/knowledgeKernel/contracts.test.ts electron/agentData/knowledgeKernel/executionPolicy.test.ts electron/agentData/knowledgeKernel/store.test.ts electron/agentData/storage.test.ts electron/agentData/knowledgeKernel/runtimeBridge.test.ts electron/knowledgeProcess/stageRuntime.integration.test.ts`。

### 任务 2：让同任务多个 stage 可独立登记、共同停止

- [ ] RED：host.test.ts 发送同 task/fence 的两个不同 item，二者都实际进入 runKnowledgeStage；完全相同元组重复派发拒绝/复用现有在途 promise，不启动第二个 Agent；过期 fence 拒绝。A 完成后 B 仍在登记表中。
- [ ] RED：repoWikiService.test.ts 覆盖两项完成交错、任务级 abort 全覆盖、撤销根授权和 worker 故障；B 不能因 A 的 finally 清理而失去停止能力。旧 `stage.abort({taskId,fence})` 行为对单项调用不变。
- [ ] 将 host.stages、canceledStages、RepoWikiService.knowledgeStages 改为完整执行元组登记；保留 task/fence 反查或分组以实现原有整任务 abort。删除记录时核对 entry 身份。
- [ ] task-wide abort 先登记拒绝后续派发的 task/fence tombstone，中止全部匹配项，`allSettled` 后返回；close/drain/授权撤销同样等待全部项。业务单项失败不转成整个 worker 退出。
- [ ] GREEN：`npx vitest run electron/knowledgeProcess/host.test.ts electron/knowledgeProcess/host.integration.test.ts electron/app/repoWikiService.test.ts`。

### 任务 3：readme 输入和完整目录屏障

**接口：** 新增 readme phase/本地 artifact；`CatalogueArtifact` 包含 tree、pages、requiredPageIds、catalogueHash。新增 `catalogue:root`、稳定的展开节点及本地 `catalogue:complete`。新旧图在同一 coordinator 内按冻结 pipeline 身份选择，不另建第二个生产队列。

- [ ] RED：wikiPipeline.test.ts 覆盖 README 缺失/截断/源码变化、根结构直接完整、两层以上嵌套、目录展开无序返回。断言 `catalogue:complete` 未 ACK 前没有 ready generate，完成后的页集/依赖及顺序确定。
- [ ] RED：重复/非法 ID、标题冲突、环、未知依赖、超过 64 catalogue 节点或深度 6 阻断；不能靠截断或自动叶子化宣称完整。旧 v1 图仍保持旧节点/输入身份。
- [ ] 在 projectPort 增加 `readReadme(projectId, sourceSnapshot, signal)`：只读授权 manifest 的根 README；最多 3 文件、各 400 行、合计 65536 字节，返回实际证据和截断标记。将 `project.readReadme` 接入 host.invoke 的授权方法表与 runtimeBridge 的项目端口；readme 不取得模型槽，不新建 README 文件。
- [ ] 更新 stagePrompt：plan 给主题/约束，catalogue 输出可结束的整树/子树与依赖；提示优先保留合理粗粒度，接近节点/深度预算时收敛。移除 v2 的两层隐式叶子化；保留旧图恢复分支。
- [ ] GREEN：`npx vitest run electron/agentData/knowledgeKernel/wikiPipeline.test.ts electron/knowledgeProcess/projectPort.test.ts electron/agentData/knowledgeKernel/coordinator.test.ts`。

### 任务 4：空槽即补的有界 DAG 调度、ACK 和控制

**接口：** `selectDispatchableItems(graph, activeIds, failedIds, policy): StageNode[]` 是纯就绪选择器：目录选最浅未完成层（含在途项，不提前进入下一层），正文按稳定顺序选依赖满足的项，各最多 3 在途。执行和提交仍归 coordinator；不让 selector 持有另一份任务状态。

- [ ] RED：readyScheduler.test.ts 使用 A/B/C 独立、D 依赖 A 的图；最多 3 在途，C 先结束时补入独立 E，不等待 A/B，D 只能在 A 的持久 ACK 后开始。失败 A 只阻塞 D。
- [ ] RED：在 coordinator.test.ts 制造逆序响应、重复响应、usage 与 item ACK 交错，断言页集、图 outputHashes、计数无丢失/重复；旧输入 attempt 拒绝。
- [ ] 将 `ready[0]` 循环改为有界 active 集合及结果队列；模型/工具执行并行，图推进、commitItem、计数和下一项选择在唯一串行提交路径中执行。每次补槽前重读控制/预算/授权状态。
- [ ] runtimeBridge.requests 记录完整执行元组；正常 executeStage 的 finally 仅调用 `drainExecutionModels(scope)`，等待本项模型/usage，不等待 B/C 兄弟。保留整任务 drain 用于最终收尾、暂停/取消、关闭和 epoch 交接，不能用删除 drain 的方式漏掉计量落定。
- [ ] 在 runtimeBridge.test.ts 用 deferred provider 挂住 B/C，先完成 A；断言 A 已 ACK 且 E 已派发时 B/C 尚未放行。该测试必须走真实 bridge，不能只测 selector；最终 drain 仍等待全部兄弟和用量 ACK。
- [ ] 新增可选 `activeItems: {phase,itemId,title}[]` 投影；currentItem 保留为按图顺序首项。只有调度器真实在途 stage 入列；该计数包括等模型槽的 stage，不表示同时发送的 HTTP 请求数。
- [ ] RED/GREEN 控制：暂停/取消先落盘再禁补槽，停止所有匹配 stage/HTTP/工具；终态前可 ACK 已通过校验的成果，终态后迟到结果拒绝。重启先 drain 旧 epoch，再复用 ACK 项；模型/源码/计划变化沿用 blocked。
- [ ] GREEN：`npx vitest run electron/agentData/knowledgeKernel/readyScheduler.test.ts electron/agentData/knowledgeKernel/coordinator.test.ts electron/agentData/knowledgeKernel/runtimeBridge.test.ts electron/agentData/knowledgeKernel/recovery.integration.test.ts electron/agentData/knowledgeKernel/modelRequests.integration.test.ts electron/agentData/knowledgeKernel/currentItem.test.ts`。

### 任务 5：用完成清单阻断漏页和空发布

**接口：** `buildCompletionManifest(requirements: KnowledgeCompletionRequirements, checkpoints: VerifiedArtifact[]): KnowledgeCompletionManifest`；`validateCompletionManifest(manifest,requirements,checkpoints): void`。requirements 的 domain/身份/structureHash/必需集合由冻结图提供：Wiki 取 catalogue 的全部页，Cards 取 plan/图的模块卡、仓库卡和 relations。清单字段由笔记定义，作为 v2 validate artifact 保存并传入现有 preparePublication；v1 发布不强制新清单。

- [ ] RED：completionManifest.test.ts 逐项删除必需页、置空正文、伪造 outputHash、替换 catalogue/sourceSnapshot/pipeline 身份、留下 failed/blocked 项，均不能通过；完整集合才通过。确认从成功子集重建 requiredIds 不能绕过检查。
- [ ] RED：cardPipeline.test.ts 与 completionManifest.test.ts 验证 Cards 不需要 catalogue；模块卡/仓库卡/relations 缺任一必需项均阻断。relations 用关系 schema/端点/证据校验，不要求 Markdown 正文。旧 v1 发布 fixture 不含新清单仍保持原契约。
- [ ] 替换 `{valid:true}` 本地占位成果。沿用每页 schema/来源/链接校验，增加跨页集合、依赖和输出身份检查；不调用模型做最终校验。
- [ ] 更新 projectPort 和现有 vendor core baseline/发布入口，把清单纳入发布 intent/事实 baseline；在 journal 前再次校验，保留现有收据和人工编辑/token 流程。不增加独立 completion 状态表或第二套 manifest 文件事实源。
- [ ] RED/GREEN：publication.integration.test.ts 验证一页失败时旧正式版本不变，成功页留 staged；定向 repair 复用成功页，补齐后一次发布；journal/receipt 中断和之后的人工编辑仍可恢复。
- [ ] GREEN：`npx vitest run electron/agentData/knowledgeKernel/completionManifest.test.ts electron/agentData/knowledgeKernel/cardPipeline.test.ts electron/knowledgeProcess/publication.integration.test.ts electron/agentData/knowledgeKernel/repair.test.ts electron/agentData/knowledgeKernel/recovery.integration.test.ts`。


## 执行边界
你是任务1–5紧耦合核心的唯一写入者；不要写UI、ui-harness、app集成e2e、笔记/计划。根代理拥有这些区域。不得提交、推送、发布、调用付费模型或重启用户应用。共享shared契约和core projection.ts由你修改；activeItems接口定为可选数组{phase,itemId,title}。早交接口。保持旧v1任务/外部调用语义。保存RED/GREEN日志与core-report.md，不创建重复笔记。

