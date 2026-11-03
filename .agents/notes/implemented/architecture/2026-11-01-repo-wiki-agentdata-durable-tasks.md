# Agent Note: Repo Wiki 融入 AgentData 与持久化生成任务

Status: implemented

> **适用范围更新（2026-11-02）：** 本篇涉及的生成权威、依赖图、预算、全页发布与恢复合同适用于 legacy Wiki / 知识卡及其历史任务；不把它们作为 `qoder-wiki-local-v1` 的合同。native Wiki 的独立服务、部分发布和兼容边界见 [原版内核变更](../../proposed/architecture/2026-11-02-qoder-repowiki-native-replica.md)；该变更仍待整合和用户验收，旧任务不自动升级。原有历史证据仅证明当时的版本。

## Problem

Repo Wiki 虽复用 AgentData 的知识模型和并发门，但生成 run 仍绑定页面 context。关闭、切项目或重挂载触发 cancelContext 并释放模型 lease；进度事件先按当前页面过滤，任务中心没有记录。现有 workspace-runs.json 只能保留 run 快照，启动将活动 run 标为 interrupted，没有自动继续链。用户要求统一进 AgentData，重开可看到当前执行步骤，应用重启自动继续未完成部分且保留已完成结果。

## Decision

阶段生成、检查点、发布协调和生产编排由 [KnowledgeKernel](2026-11-01-repo-wiki-knowledge-kernel.md) 部分取代。本篇保留任务身份、产品入口、后台生命周期及当时选择的理由；下述旧逐页执行细节不再作为新生产任务的协议。

AgentData 的 agent_jobs 是生成任务、参数、阶段、取消意图与结果的权威账本；注册 repoWiki.generate 执行器，先落盘后执行。执行器通过现有主进程端口使用 Repo Wiki 工作进程，知识模型仍经过原 WikiService 共享并发门。页面 context 仅决定访问、编辑和订阅，生成使用独立任务 context，离开页面不会取消任务。显式取消、宿主项目撤销授权及应用停止仍会终止实际模型调用。

任务参数保存 projectId、language、target、force 和显式外发授权，以 AgentData taskId 直接作为 resume_run_id，避免执行已开始但 runId 还没记回的重复窗口。同 namespace/target 活动生成去重，同项目不同 target 由执行队列串行写入。该 kind 在 AgentData 重启后自动恢复，恢复取消意图，不重放终态；其他 kind 保留现有中断语义。引擎每页来源校验后即时保存 checkpoint，同任务 force 也复用已完成输出，整批结束后仍走原子发布、文件 token 和 journal。源码、计划或模型配置 fingerprint 变化会重新计算失效部分，人工编辑不回滚。

Repo Wiki 成为 AgentData 内的标签，使用全宽内容区，不重复渲染独立模块标题和关闭栏；项目栏保留明显的生成任务入口，运行横幅展示当前文档、进度和后台行为。任务中心可查看中文阶段、页名、百分比、已完成/总页数、取消、重试并返回项目。保留旧材料 Wiki，二者内容语义不同。文档事实来源仍是项目 docs/repo-wiki；扫描、生成和索引继续在独立工作进程，主进程不打开 SQLite。

任务资源携带 workspace 和 language；旧账本从已确认的 payload 派生语言。关联资源导航先等待宿主项目打开、当前项目 hydrate 完成，再切换到任务所属语言，每个导航请求只应用一次，隐藏页面不对旧项目误切 namespace。

实际跨项目导航暴露了宿主已有草稿恢复的早退缺口：applyOpenedProject 恢复 draftConversationId 时也要切回目标 activeWorkspace，保留既有草稿身份，不能在 Center 旁路补一套。重试确认按源码文档/知识卡片、项目和语言展示范围，不强求旧资料 Wiki 的来源数量；确认模型身份仍贯穿派发前校验。

事件先持久化任务进度，再映射到当前视图 token。后台单飞轮询仅作兜底，若等待响应期间已有新事件，则忽略旧快照。取消等待真正终态而非取消回执；应用关闭通过 pause 保持 AgentData 活动态与引擎 interrupted。尚未派发的取消不会调用模型，退出与派发交错也不留下挂死回调。排队任务取消只释放自身，队尾待前面的执行链结束后清理。

## Historical note audit

- [独立进程接入](../../implemented/architecture/2026-10-31-repo-wiki-process-integration.md)：部分重叠，独立进程、构建和文档语义保留；独立产品入口和任务分离由本篇取代。
- [宿主知识调度](../../implemented/bug-fix/2026-10-31-repo-wiki-host-workflow-alignment.md)：部分重叠，模型配置和共享并发门保留；页面取消与未接账本由本篇取代。
- [项目文件和按需服务](../../implemented/architecture/2026-10-31-repo-wiki-project-files-and-lazy-service.md)：部分重叠，文件事实源、CAS、按需准备保留；关闭页面取消任务的契约由本篇取代。
- [孤儿任务落定](../../implemented/bug-fix/2026-10-16-orphan-job-settle.md)：部分重叠，其他 kind 重启标中断保留；本篇仅为可恢复的 Repo Wiki 生成增加自动继续。
- [Memory 裁撤](../../implemented/simplification/2026-10-31-remove-agentdata-memory.md)：职责相邻但不重叠；不恢复已删除的 Memory，不清理共享数据库。

## Alternatives considered

- 保留独立入口、只缓存页面状态最省改动，也能显示旧进度；不用，因为页面仍是执行所有者，后台运行和应用重启没有可靠调度。
- 合并两套 Wiki 文档表能够统一存储 API；不用，因为旧 Wiki 是材料知识库，新 Repo Wiki 是源码文档，强合并破坏既有文件格式、身份和编辑契约，统一任务与产品入口已能满足本次需求。
- 使用 service_tasks 可复用旧 Wiki 单页账本；不用，因为其输入和队列服务旧 ingest 语义，agent_jobs 已具备用户任务视图、取消与重试入口。
- 应用重启只标中断、等待手动恢复可避免自动模型调用；用户明确选择自动继续，故持久化原授权与 checkpoint，仅恢复未完成目标。

## Behavior

- 生成后离开页面、切换项目、同路径重挂载，后台任务继续；重开恢复同一任务和当前步骤。
- AgentData 先记录再派发，重复点击不重复生成；任务中心展示阶段、进度、取消与错误。
- 应用/AgentData 重启恢复活动任务与取消意图，已完成目标不重复调用或覆盖。
- 显式取消传递到模型并等待实际停止；旧页面 cleanup 和迟到事件不覆盖新任务。
- 原文件事实源、授权、namespace、模型配置隔离和草稿保护继续有效。

## 验证

按 test-driven-development 先观察任务缺失、取消派发竞态、排队越过前驱和进度倒退等关键失败，再验证修复。证据目录：`.agents/evidence/2026-11-01-repo-wiki-agentdata-durable-tasks/`。分组有重叠，不合计为总数。

- 最终宿主/任务/任务视图/模型配置、跨项目恢复、重试确认和真实双 OS 子进程联合验收 11 文件 115 项通过，见 acceptance-final.log。集成走生产 AgentData、WikiService、ModelRuntimeHost、Pi SDK 和 loopback HTTP，验证不开 Wiki 也自动恢复原任务，已完成页不重调，任务中心取消真正关闭 HTTP。此前 9 文件 87 项证据保留于 backend-final.log，原工作流 JSON 与日志见 integration-real-children.*。
- AgentData 任务侧 5 文件 57 项通过，其中新任务/取消/恢复测试 10 项；RED/GREEN、派发前取消证据见 repo-wiki-jobs-* 和 repo-wiki-cancel-race-*。
- vendor 正式 Electron-as-Node 套件 236/236 通过，见 engine-vendor-full.log；追加真实强杀恢复定向 1/1 通过，见 engine-hard-kill.log。每页 checkpoint 的 RED/GREEN 见 engine-resume-*。
- 原版 Repo Wiki 页面回归 9 文件 71 项通过，见 vendor-ui-regression.log。补齐任务语言资源后，后端 2 文件 21 项、UI 3 文件 46 项定向通过；RED/GREEN 及 namespace 导航记录保存在同一证据目录。
- 跨项目草稿恢复 12/12、任务中心重试确认及自动滚入可视区 15/15 通过，对应 project-navigation-*、repo-wiki-retry-drawer-*、repo-wiki-retry-scroll-* 日志保留先失败后通过证据。
- UI 首轮定向 7 文件 99 项通过；最终任务语言与重试交互回归 3 文件 50/50、实际静默 Electron repo-wiki 114/114、既有 AgentData 导航 15/15 通过，仅运行这两个相关场景。包含融合布局、草稿保护、进度百分比、离页后台推进、任务中心取消、跨项目精确英文 namespace 导航、模型确认重试、新 run 跟随与确认卡自动可见后的真实鼠标点击。最终证据见 ui-repowiki-namespace-tests-final.log、ui-repowiki-namespace-harness-final.log；初轮与既有导航见 ui-repowiki-harness-final.log、ui-repowiki-harness.log。reading-running / tasks-running / retry-confirmation 三张截图已人工查看。
- npm run typecheck:repo-wiki 通过，最终生产构建见 build-final.log。本地运行构建见 build-localrun.log；正在运行的 pi-job-guard.exe 被 Windows 锁定且 SHA256 与源一致，临时验证配置保留 out/main、不清空目录并跳过字节相同的资源，其他资源照常复制，三端完整编译成功。配置存 localrun-build.config.ts.txt，临时工作区配置已删除，正式构建配置未修改。

## Consequences

生成任务获得统一账本、操作入口和恢复路径，代价是多一层受信执行回调及检查点缓存。进程中断的未完成 HTTP 可能重新调用，已经验证并保存的页面输出在 fingerprint 未变时复用；不宣称具有供应商请求事务。索引/检查点文件被手工删除后，文档事实仍可重建，但未发布检查点需要重新生成。

旧 taskViewService.test.ts 的 4 项旧 Wiki 用例在修改前实现上同样失败，见 repo-wiki-taskview-baseline.log；不是本次新增回归。额外严格后端工程暴露旧依赖诊断，本次改动文件无诊断，见 backend-types.log；未宣称全仓类型和全仓测试通过。保留工作区原有未提交内容，不提交、推送或发布，不重启用户正在使用的应用，不调用付费模型。
