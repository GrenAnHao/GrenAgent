# Agent Note: Repo Wiki 生成流水线与 Qoder 对齐

Status: implemented
Archived: 2026-11-13

> **适用范围更新（2026-11-02）：** 本篇涉及的生成权威、依赖图、预算、全页发布与恢复合同适用于 legacy Wiki / 知识卡及其历史任务；不把它们作为 `qoder-wiki-local-v1` 的合同。native Wiki 的独立服务、部分发布和兼容边界见 [原版内核变更](../../proposed/architecture/2026-11-02-qoder-repowiki-native-replica.md)；该变更仍待整合和用户验收，旧任务不自动升级。原有历史证据仅证明当时的版本。

## Problem

用户先要求只写笔记和实施计划，2026-11-02 随后批准按计划实现，并要求先暂停当前生成、暂不运行付费模型测试。目标是让大仓库的目录规划和正文生成能够有界并行，阶段有各自预算，失败后仍能复用成果。当前 AgentData 唯一任务权威、项目文件事实源和启动自动续跑继续保留。

当前实现有三处串行限制：`KnowledgeKernelCoordinator.run()` 每次只取 `ready[0]`；`KnowledgeWorkerHost` 按 taskId 登记一个 stage，并拒绝同任务的第二个执行；runtimeBridge 在每次 stage 返回时按整个 taskId 等待模型 drain，会让已完成项等待其兄弟。因此只把调度循环换成 `Promise.all` 无法实现空槽即补，还会破坏取消和登记清理。目录模型展开另有 `MAX_CATALOGUE_DEPTH=2` 的硬截断；预算则让 overview、plan、catalogue 和每篇正文共用一套 unit 上限。

### 参考材料纠正了原对比

可携带证据见 [Qoder 静态核验](../../../evidence/2026-11-02-repo-wiki-qoder-alignment/qoder-reference.md)。对象是已提取的本机 Qoder 0.5.1 / KnowledgeKit 材料，没有动态运行 Qoder。

| 方面 | 静态代码支持的结论 | 本提案的处理 |
| --- | --- | --- |
| 目录 | `FUn` 先生成根结构，再按最浅层逐节点并发展开，保存 tree/expanded 检查点 | 对齐完整目录屏障、层次展开、并发和检查点；不要求单次模型调用完成整棵树 |
| 正文 | `VUn` 经 `Ud` 按配置并发；release 内置目录/正文并发默认均为 3，debug 为 6 | 新任务两种并发均默认 3，不复制 debug 默认，不改变用户知识模型并发设置 |
| 预算 | 按 purpose 独立配置；观察到的默认额度可能相同 | 为用途分别冻结 profile，额度采用本项目的初始提案值，不声称复制 Qoder 的调优结果 |
| readme | 是前置归一化输入，不等于额外一次模型调用 | 增加本地 readme 阶段，提供受限 README 截取内容 |
| 最后校验 | completion manifest 参与发布；未见必须执行的独立 validation 模型 purpose | 本地核对完成清单，不恢复“让模型重读整仓”的最终校验 |
| 部分失败 | Qoder full manifest 可以纳入失败 checkpoint，仅把成功页列为 requiredPageIds | 保留 Pi 已确认的整批原子发布，所有必需页齐全才切换正式版本 |

原表中“Qoder 一次生成整套目录，比逐项调用更省请求”没有依据。目录请求数、生成速度、模型质量和费用要用同输入实测；静态并发调度不能直接证明倍数收益。

## Decision

采用**同一个 KnowledgeKernel 内的版本化流水线**：完整目录先冻结，目录节点和独立页面有界并发，预算按用途解析。保留两个现有子进程，不接入 Qoder 包、账号、SDK 或代码。

实施任务见 [实施计划](https://github.com/GrenAnHao/GrenAgent/blob/7cea05eac673e7046ee92748c2f01bc649764ba4/docs/superpowers/plans/2026-11-02-repo-wiki-qoder-alignment.md)。本篇提供设计契约，计划提供文件、依赖和验证步骤；源码、定向验证和独立复审已完成；真实模型质量与费用验证按用户要求暂不执行。

### 1. 阶段与完整目录

Wiki 新流水线为：`prepare → readme → overview → plan → catalogue → generate → validate → publish`。update 仍在 prepare 后分析变更；Cards 保留 `prepare → plan → generate → relations → validate → publish`，模块卡可以并行，仓库综合卡和 relations 等待自己的依赖。

- **readme**：本地读取 frozen manifest 中的根级 README 文件，按语言匹配后稳定排序。最多 3 个文件、每个最多 400 行、合计最多 65536 UTF-8 字节；记录实际行范围和截断状态。输出 `present/excerpts/truncated`，每段含 path/hash/start/end/text。无 README 时 `present=false`，overview 继续读源码。沿用 manifest、路径和源码稳定性校验，不新增模型请求、不写用户仓库的 README。
- **plan**：形成主题、作者约束和依赖意图，不把尚未展开的父目录冒充最终正文页。
- **catalogue**：根节点 `catalogue:root` 形成初始树；v2 待展开节点使用独立内部命名空间 `catalogue:item:<logicalId>`，同一最浅未完成层最多 3 个在途。合法作者 ID `root` / `complete` 不会与控制节点碰撞，v1 仍使用原节点名。层内含在途项时不提前展开下一层；每项单独校验、持久化 ACK 后更新树。根结构已经完整时可以不继续拆分。
- **catalogue:complete**：本地检查重复 ID、标题冲突、未知依赖、环和层级，产出最终 `tree/pages/requiredPageIds/catalogueHash`。此节点 ACK 前不派发任何正文。输出顺序按稳定逻辑 ID/目录次序固定，不取决于响应先后。
- 新策略沿用 run 的深度 6、规划项 500 上限，另限制最多 64 个需要模型执行的 catalogue 逻辑节点（含 root、不含本地 complete；重试不另占节点名额，仍计模型/工具预算）。模型在接近边界时收到收敛提示；越界明确 `CATALOGUE_LIMIT`，不默默删页或把未完成展开当成功。v2 不再使用硬编码的两层自动叶子化。

### 2. 并行只发生在可独立执行的条目

同一任务只有一个协调器、一个写租约和一个发布者。新任务 `catalogueConcurrency=3`、`pageConcurrency=3`；正文按依赖 DAG 选择已就绪条目，空出槽位即补下一项，不等待整批最慢项。依赖只有在成果校验并持久化 ACK 后才满足。单个 Agent 内的四种工具仍顺序执行，不增加 shell、MCP 或写文件工具。

每个在途执行由完整元组标识：`taskId + fence + phase + itemId + attempt`。worker、宿主桥和控制器共同使用该键，登记/清理比较同一条记录，不能一项完成就清掉同任务其他项。既有 `stage.abort({taskId,fence})` 仍表示停止该任务在这个 fence 下的**全部**条目；不改变旧调用的范围。

正常 stage 返回只等待这个执行元组的模型与用量结算，不 drain 整个 taskId；B/C 仍运行时，A 的 ACK 和后继补槽必须可以完成。整任务 drain 仅用于任务结束、暂停/取消、关闭或 epoch 交接。

并发结果进入协调器的串行提交路径：用最新图校验 attempt/inputHash，调用 `commitItem`，再推进图与计数。不能并发修改各自复制的 graph 后互相覆盖。对外状态增加可选 `activeItems`，旧 `currentItem` 继续保留为稳定选中的首项；active 表示实际在途 stage，不能把“排队等模型槽”写成 HTTP 已并发发送。

每次 assistant 请求仍经过现有 WikiService 共享并发门。全局并发为 1 时 HTTP 同时最多 1 个；实现不自动把它提高。并行可能缩短有空余模型槽或工具等待时的总耗时，不降低模型必需请求数，也不保证 3 倍加速。

暂停/取消先持久化控制意图并停止补槽，再中止并等待全部在途 stage、模型请求和工具落定。终态、释放租约或启动新 epoch 必须在 drain 后发生。控制请求期间已完成且通过校验的成果可在终态前 ACK 留存，取消后不发布；终态后的迟到结果不能恢复运行。独立页失败不杀死其他独立页，只阻塞依赖者。

### 3. 预算按用途冻结，旧任务额度不变

保留 `KnowledgeBudgets.version=1`、`unit/run` 和旧调用入口；新增可选 `executionPolicy`，其 `version=2`，包含上述并发、目录节点上限和完整的用途 profiles。新任务创建时将完整 profile 持久化，不能在恢复时重新合并最新默认值。

`resolveKnowledgeUnitBudget(metadata, stageKind)` 为模型单元返回一个具体 unit；stageKind 只能是 overview、plan、catalogue、page、module-card、repository-card、relations，本地阶段不调用它。coordinator 从冻结图取得 kind，校验 domain/phase/itemId 后，在 beginAttempt 时将它写入构建项的 `stage_kind` 列；同项 kind 不可改变。store 和 runtimeBridge 按执行元组读取这个权威值，不能把请求计量的 model/tool/time 当作 stageKind，也不能相信 worker 自报的 profile。worker 只收到已经解析的有效 unit。

AgentData schema 6 升到 7，幂等增加可空 stage_kind，不新建任务表、不改旧行含义。没有 executionPolicy 的历史任务允许 stage_kind 为空，仍使用自己的 unit、串行图和原两层目录行为。新任务采用 `knowledge-kernel-qoder-v2` 配置身份；历史任务按其冻结身份恢复，不能因默认流水线升级就失去原来自动续跑的条件。repair 沿用父任务的图版本/profile；用户显式重新分析并确认后，才使用新默认。

当前内部默认值如下，数字是上限，不是质量或费用保证。token 列沿用当前 `knowledgeBudgetTokens()` 的预算口径（cache read 按 1/10 计），不能改称真实计费 tokens。

| 用途 | 模型请求 | 工具调用 | 输出 tokens/次 | 累计预算 tokens | 累计读取字节 | active 毫秒 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| overview | 12 | 40 | 8192 | 200000 | 2097152 | 600000 |
| plan | 6 | 16 | 8192 | 120000 | 1048576 | 300000 |
| catalogue（每节点） | 8 | 24 | 8192 | 160000 | 1048576 | 300000 |
| page / module-card（每篇/张） | 20 | 60 | 8192 | 300000 | 2097152 | 600000 |
| repository-card | 12 | 32 | 8192 | 200000 | 2097152 | 600000 |
| relations | 8 | 24 | 8192 | 160000 | 1048576 | 300000 |

各模型单元共同保留：2 attempts；单文件 262144 字节；400 行/次；32768 字节/工具结果；100 条搜索命中；200 个目录项；单次 provider active timeout 120000ms。实际输出还须受模型 maxTokens 和剩余额度限制。readme、prepare、change_analysis、validate、publish 本地执行，不取得模型槽。

整任务仍最多 1000 次模型请求、5000000 预算 tokens，maxItems/maxDepth 沿用当前 store 的口径。每节点额度不是“整阶段总额度”；所有节点还共同消耗 run 预算。`reserveExecutionBudget` 在同一 SQLite 事务内计算已用量与所有未结算 reservation，再准入下一请求；并发不能同时花掉同一份余额。store、runtimeBridge 的 timeout/token reservation、stageRuntime 的提示和输出限制必须解析同一份冻结 profile。重试、恢复、repair 的计量与未知用量沿用现有账本规则，不把已发送未结算请求记成零。

### 4. 最终校验使用完成清单，保留原子发布

v2 的 validate 不再只保存 `{valid:true}`。先建立 `KnowledgeCompletionRequirements`：domain、pipelineConfigHash、sourceSnapshotId、structureHash 和全部必需项的 phase/itemId/kind。Wiki 的必需页来自冻结 catalogue，structureHash 为 catalogueHash；Cards 的集合来自冻结 plan/图，包含模块卡、仓库综合卡及 relations，structureHash 为该冻结结构的摘要。不能从当前成功子集反推必需集合。repair 只复用输入仍有效的模型成果，validate 在目标任务本地重建，不能把父任务的 sourceSnapshotId 清单复制给新任务。

`KnowledgeCompletionManifest` 保存版本、以上身份、全部 required item 的 phase/itemId/kind/inputHash/outputHash，以及失败/阻塞项。仅 required 集合相等、输入身份一致且无失败/阻塞时允许发布；page/card 检查正文非空及来源/链接，relations 检查关系 schema、端点和证据，不要求 relations 有 Markdown 正文。旧 v1 流水线继续原发布检查，不强制补造新清单。

清单作为 validate checkpoint 持久化，并进入现有项目 baseline/发布 intent 的校验范围；不另建一套任务状态或数据库。项目文件端口在正式 journal 提交前再次核对清单、文件 token 和源码快照。文件收据、索引重建、任务结算仍沿用现有协议。

Pi 继续要求**全部必需页面准备齐全才切换整批正式版本**。有一项失败时成功成果保留为 staged，已有正式内容继续可读，repair 仅重做失败、依赖阻塞或已失效项。此处有意不对齐 Qoder 的部分发布策略。

### 5. 明确保留的差异

- **进程**：保留 AgentData + Repo Wiki 两个 OS 子进程，分别拥有任务账本和仓库 I/O；不为形式一致合并进程。
- **增量**：保留文件 manifest 为正确性依据，包含 dirty/untracked 和搜索范围变更；Git baseline/提交差异只用于候选分析和解释，不替代内容核验。本轮不新建 Git-only 增量驱动。
- **恢复**：保留启动自动继续、手动暂停不自动继续、取消不复活、模型/源码/计划变化阻断、相同 taskId 恢复和 repair 新 taskId。
- **知识卡**：本轮让独立模块卡复用并行调度和用途预算；仓库卡、关系仍按依赖串行收敛。已有 update intent 继续用增量图，不新增只为复刻 Qoder purpose 名称的产品入口。
- **界面**：保持内容/运行/动作/准入四项分离，仅补 readme 阶段与并行条目展示，不重做工作台外观。

## Historical note audit

- [KnowledgeKernel](../../implemented/architecture/2026-11-01-repo-wiki-knowledge-kernel.md)：部分重叠。保留所有权、身份、工具和恢复协议；本篇补充阶段、调度、清单和兼容规则；原所有权、存储和恢复决定继续有效。
- [真实模型实跑](../../implemented/bug-fix/2026-11-01-repo-wiki-real-model-shakedown.md)：部分重叠。保留路径错误可恢复、来源校验、最终校验不调用模型的理由；新图替代新任务的两层目录硬截断，并由 64 节点及全局预算约束调用量。
- [项目文件与按需服务](../../implemented/architecture/2026-10-31-repo-wiki-project-files-and-lazy-service.md)、[持久化任务](../../implemented/architecture/2026-11-01-repo-wiki-agentdata-durable-tasks.md)：存储、轻量首屏和后台生命周期不变。
- [统一知识 UI](../../implemented/bug-fix/2026-11-01-repo-wiki-unified-knowledge-ui.md)：正交状态保留，仅增加可选并行状态。
- proposed/rejected 的本主题检索未找到需吸收或撤销的其他提案。本篇不归档旧决定，也不修改冻结的 docs/decisions。

## Alternatives considered

1. **一次模型响应生成最终整套目录**：请求更少，目录跨模块一致性也容易整体表达；不选为默认，因为 Qoder 原实现也允许分层探索，大仓库更容易超过输出/读取预算，局部失败只能重做整棵树。允许根结构一次完成，但不能要求只能一次完成。
2. **仅提高 ready 数量并 Promise.all**：改动最少，适合没有控制/恢复要求的批处理；不采用，因为 worker 当前拒绝同 task 第二个 stage，宿主登记按 task 覆盖，图推进、预算和取消也必须一起修正。
3. **整体替换为 Qoder context 或合并子进程**：外形更接近参考实现，可能复用其调度；不采用，因为会替换已确认的 AgentData 权威、项目文件和 SDK 边界，也引入不必要的产品依赖。

## Behavior

- 文档准确区分 Qoder 静态事实、当前 Pi 行为和实施结果，目录不再表述成“固定单次调用”；本次按用户后续批准实施，真实付费模型测试除外。
- 新图具有 readme、目录完成屏障和持久化 completion manifest；无 README、嵌套 ID、目录越界、重复和依赖环均有明确结果。
- 用可控 loopback provider 证明目录及页面同时存在 3 个独立在途单元；HTTP 槽为 2 时峰值不超过 2，为 1 时峰值不超过 1。依赖项在父项 ACK 前不启动。
- 暂停、取消、失去授权、进程退出、旧 fence 迟到覆盖所有并行项；恢复复用已 ACK 项，旧 v1 任务继续按原规则运行。
- 不同 profile 的请求/工具/token/时间准入可分别耗尽；并发 reservation 不超卖 run 余额。输出预算、日志中实际 usage 和 cache 折算不混用。
- 缺必需页、失败页、空正文、伪清单、陈旧来源或文件冲突时不能发布；repair 后在同一正式版本中读到完整页集，原人工编辑保护继续有效。
- 真实模型验收同时检查任务、正式 Markdown 集合/正文/来源、界面可读状态和实际加载构建，不只断言 completed。真实模型调用须在实施验收时另获授权。

## 验证

证据目录为 [实施与验收记录](../../../evidence/2026-11-02-repo-wiki-qoder-alignment/IMPLEMENTATION.md)，各组存在重叠，不相加为全仓测试总数：

- core-report.md：核心前置 20 文件 170 项、接线后的定向 11 文件 114 项通过；最终三项审查修复后的受影响 8 文件 60 项通过。严格 KnowledgeKernel 类型通过。
- integration-report.md：9 个真实双 OS child、官方 Pi SDK 与本地 loopback 场景均有有效 GREEN；最终目录命名变化后重验目录屏障和既有增量，2 项通过。目录/page stage 峰值 3，HTTP 全局槽 1/2 时峰值分别 1/2；A ACK 后 E 补槽时 B/C 仍挂起。取消、SIGKILL 自动恢复、v1 预算/图兼容、增量和人工正文 repair 均有证据。
- 正式文件验收核对完整必需页集、completion manifest、非空 Markdown 和冻结源码来源；读取失败不再吞成空列表。任务 completed 不是唯一断言。
- ui-report.md：3 文件 46 项通过；真实 Electron repo-wiki 场景 163 PASS / 0 FAIL，只跑 1/44 个场景。窄屏截图已查看，长标题换行、真实鼠标/空格展开收起、暂停和旧记录显示通过。
- final-review.md：独立复审已关闭目录上限晚失败、repair 复制父 validate 身份、合法 ID 与控制节点碰撞三项 P2，无未解决 P1/P2。UI 单独审查修复的陈旧 currentItem 问题也已复核。
- npm run typecheck:repo-wiki 与 npm run build 通过；后者包含当前 Repo Wiki 类型检查和生产主进程/preload/renderer 构建，产物写 out-pkg。构建有既存 SDK import.meta/前端静态与动态导入警告，无失败。
- REPO_WIKI_REAL_E2E 显式清除，真实模型测试保持 skipped，没有发起新的付费生成。当前用户旧任务开工时已终态；未点重试、未修改用户模型设置。新构建载入用户实例的重启另待确认。

真实模型上的 JSON 合规率、生成质量、费用与同输入串行/并行耗时尚未验证，不从本地回环结果推导提速倍数。本轮交付是代码与获准测试完成，不是对原项目生成成功的复验。

## Consequences

并发会提高内存峰值、模型限流概率和同时预留的预算，未必降低请求数或费用。64 个目录节点和各 profile 是初始工程默认，须用同仓库、同冻结输入/模型记录质量、耗时和费用后再调整。新增图与 activeItems 需要旧记录兼容，不能用“升级后重新生成”替代原先自动续跑。readme 输入仍要遵守源码授权；部分工具错误可恢复，快照变化和越权内容不可绕过。
