# Agent Note: AgentData 托管的 Repo Wiki KnowledgeKernel

Status: implemented

> **适用范围更新（2026-11-02）：** 本篇涉及的生成权威、依赖图、预算、全页发布与恢复合同适用于 legacy Wiki / 知识卡及其历史任务；不把它们作为 `qoder-wiki-local-v1` 的合同。native Wiki 的独立服务、部分发布和兼容边界见 [原版内核变更](../../proposed/architecture/2026-11-02-qoder-repowiki-native-replica.md)；该变更仍待整合和用户验收，旧任务不自动升级。原有历史证据仅证明当时的版本。

## Problem

此前 Repo Wiki 已接入 AgentData 的 agent_jobs、后台执行、应用启动恢复和逐页检查点，生成仍采用默认/人工计划、预选源码和每页一次 completion。用户要求内核与 UI 共同落地分阶段规划、受限工具会话、阶段/条目持久化、快照发布、增量和失败修复。Qoder 安装包仅提供静态架构参考，不作为产品依赖或代码来源。

## Decision

新任务的 readme、完整目录屏障、有界并行、用途预算和发布完成清单见 [Qoder 对齐实现](2026-11-02-repo-wiki-qoder-alignment.md)。本篇的 AgentData 权威、项目文件、权限和自动恢复边界保持；没有 executionPolicy 的 v1 任务继续冻结的旧图和预算。

完整边界与故障协议见 [设计规格](../../../../docs/superpowers/specs/2026-11-01-repo-wiki-knowledge-kernel-design.md)，文件责任和接口见 [实现计划](../../../../docs/superpowers/plans/2026-11-01-repo-wiki-knowledge-kernel.md)。代码已接入生产链路，真实工作流、定向 UI、兼容回归、严格类型、构建与独立复审已经完成；实际覆盖面见 [验收记录](../../../evidence/2026-11-01-repo-wiki-knowledge-kernel/ACCEPTANCE.md)。

由 AgentData 托管自有 KnowledgeKernel。agent_jobs 继续提供唯一任务身份、全局状态和用户任务视图，内核扩展同库的条目成果、输入 manifest、预算 reservation 与租约，不另建重复保存全局 run state 的任务表，不再让 workspace-runs.json 成为生产运行权威。独立 worker 执行扫描和构建工作，已发布正文、计划、基线与人工编辑仍保存于项目 docs/repo-wiki，经既有文件 token / journal 协议发布。

生成使用现有 Pi SDK 的受限工具会话，沿用系统知识模型及共享并发门；不能把返回纯文本的 completeKnowledge 接口直接当成工具会话协议。模型、任务、项目/克隆、分支与语言身份贯穿所有阶段。页面只发动作和消费后端投影，不持有任务生命周期。

保留用户要求的启动自动继续。用户手动暂停保持暂停；应用退出导致的暂停在启动时自动继续；取消不会自动重放。新增能力覆盖 Wiki 与知识卡两域，按同一契约分阶段交付并验证。

## Historical note audit

- [AgentData 持久化任务](2026-11-01-repo-wiki-agentdata-durable-tasks.md)：部分取代，任务身份、后台生命周期、模型共享调度、启动自动恢复保留；本篇替换逐页 completion、旧检查点和生产队列编排，不把前轮后台改动描述为只有 UI。
- [项目文件与按需服务](../../implemented/architecture/2026-10-31-repo-wiki-project-files-and-lazy-service.md)：文件事实源、按需准备、CAS/journal、克隆隔离和不扫描其他项目继续有效；新增运行记录不得退化为数据库独占正文。
- [独立进程接入](../../implemented/architecture/2026-10-31-repo-wiki-process-integration.md)：工作进程隔离、构建打包与许可边界保留；生成器替换范围由设计具体定义，不长期运行两套生产驱动。
- [宿主知识调度](../../implemented/bug-fix/2026-10-31-repo-wiki-host-workflow-alignment.md)：知识模型、配置身份、共享限流与取消保持；工具会话需扩展真实模型执行端口。
- [自有运行时](../../implemented/architecture/2026-08-31-self-owned-agent-data-runtime.md)：继续吸收架构思想而非接入另一通用平台，保持 AgentData 共享宿主。
- [Memory 裁撤](../../implemented/simplification/2026-10-31-remove-agentdata-memory.md)：不重建 Memory，也不改变旧资料 Wiki、CodeGraph、会话和权限职责。

## 实现现状

AgentData 的 `KnowledgeBuildStore` 以 `agent_jobs` 为唯一任务状态，同库保存阶段条目、源码快照、用量预留和带 generation 的写租约；`KnowledgeKernelCoordinator` 负责规划图、控制、恢复、增量与 repair。手动暂停保持暂停，应用退出的暂停按原授权恢复；repair/reanalyse 使用新任务并保留 lineage。源码、计划或模型身份不一致时不拼接旧成果。

知识工作进程通过官方 Pi `Agent` 执行 `Read` / `Glob` / `Grep` / `ListDir`，按已确认快照限制可访问文件。主进程完整模型端口保留工具调用、停止原因与用量，沿用 `WikiService` 并发门；旧资料 Wiki 仍走原有短调用。worker 与模型真正停止后才能释放写租约，启动采用 epoch 排空和用量对账。

项目文件仍是正式文档事实源：一次发布在 fence、journal 和 receipt 保护下提交所有必需页面，先重建可丢弃索引再结算任务；失败与冲突保留旧正文和候选。源码 manifest 的内容哈希、搜索范围、旧新依赖边与计划身份决定增量复用。知识卡正式 ID 使用 `cards/` 前缀；嵌套 Wiki ID 和目录组依赖解析保留既有计划语义。阅读页和任务中心消费同一版本化投影，分别表达内容、运行、动作与准入。
## Alternatives considered

- 继续在原 vendor engine 内追加规划与工具调用：能最大程度复用现有文件提交、类型和回归；不推荐作为长期结构，因为运行权威、阶段恢复和通用任务视图仍散落在多个宿主中，新增增量/修复会继续拉长同一编排器。
- AgentData 托管自有 KnowledgeKernel、复用现有项目文件和扫描边界：能保留已验证的存储与宿主约束，又让运行状态和阶段协议统一；推荐，代价是明确跨进程执行、模型与文件发布协议并提供迁移验证。
- 直接接入 Qoder 的 context 运行包：已经有完整构建内核；不采用，因为其模型 SDK、账号、宿主服务和数据库事实源都与当前产品绑定，无法作为本项目可控的自有实现，也违背项目文档随源码保存的已确认边界。

## Behavior

- 全量 Wiki / 知识卡按可观察、可恢复阶段构建，模型能够受限地读取和搜索当前仓库。
- 一处权威控制状态；应用重启、worker 强杀、重复派发、旧事件和跨项目/分支/语言操作不导致重复发布或越界写入。
- 文件发布与数据库完成记录之间发生中断时可协调恢复，不覆盖人工编辑，不把索引错误冒充生成成功。
- 根据 baseline 与真实源码差异增量处理；可补齐失败项，同时继续读取上次已发布内容。
- 页面正确区分产物、运行、动作提交和准入状态；任务中心和阅读页使用同一后端投影。

## 验证

已运行的证据保存在 `.agents/evidence/2026-11-01-repo-wiki-knowledge-kernel/`。`task-12-integration-green.log` 记录 2026-11-01 18:41 的三条真实双 OS child、生产模型桥、官方 Pi Agent 和 loopback HTTP 测试：覆盖 Wiki 全量、应用退出后自动恢复、已 ACK 成果复用、dirty 源码增量、两次 HTTP 500 后定向 repair、手动暂停和实际 HTTP 取消，以及 Cards 模块卡、仓库综合卡、关系和正式文件读取。

`final-kernel-worker.log` 记录 25 文件 138 项通过，`knowledge-pipeline-final.log` 记录最终 6 文件 43 项，涵盖租约排队恢复、源码 URI、Cards 命名空间与层级依赖；分组重叠，不相加。正式 vendor 后端 238/238、UI 71/71，宿主兼容 98/98，严格工程与生产/本地构建通过。仅运行 Repo Wiki 和直接影响的 AgentData 导航 Electron 场景；证据与限制统一记录于验收文件，未声称全仓测试通过。独立复审发现的问题均已修复，复核后无未解决 P1/P2。

## Consequences

模型工具会话与现有短调用不是同一协议，必须先验证 SDK/鉴权/并发适配；文件与 SQLite 不存在跨存储原子事务，需要显式发布协调；持久化检查点只能保证已记录结果复用，不能承诺供应商 HTTP 请求 exactly-once；分支、外部源码编辑和模型配置改变时必须有明确失效与阻塞规则。

旧 plan 没有区分默认与人工来源的字段。内核保留合法嵌套 ID、目录与依赖，并把完整原计划作为作者约束交给规划阶段；不将全部默认 ID 硬编码为必选页面，以保留自动规划。新增任务使用明确知识模型/计划确认；不能验证原确认的旧活动记录进入待确认状态，不恢复第二套生产驱动。旧资料 Wiki、CodeGraph、会话、权限和已删除的 Memory 边界保持。

