# Repo Wiki Qoder 对齐：最终独立审查

审查对象：本次开工 dirty 副本对应的核心改动，以及当前跨进程、发布、UI 最终候选。只读审查生产代码，未重跑已有有效测试、未调用付费模型、未操作用户实例。

## 当前结论

**通过。** 初审发现的 3 项 P2 已修复并完成定向复核；无未解决 P1/P2。跨进程并发、共享模型槽、事务预算、串行 ACK、旧版本恢复和原子发布主合同符合本轮规格。UI 已有独立复核结论继续有效。

## 已关闭的问题（保留初审复现依据）

### P2：目录没有累计 500 个规划项上限，过晚失败会浪费正文生成

- 位置：`electron-agent/electron/agentData/knowledgeKernel/pipeline.ts:89-93`；迟到的兜底在 `store.ts:146-147`。
- v2 展开只核对深度和模型目录节点数，没有核对累计 definitions。根返回 501 个 `expand:false` 叶子可成功冻结目录并派发正文。第 501 个正文 `beginAttempt` 才触发 `CATALOGUE_LIMIT`，此前已经生成的正文仍无法整批发布。
- 本次纯内存调用生产 graph 函数，实际得到：`{"definitions":501,"requiredPages":501,"pageNodes":501,"modelCatalogueNodes":1}`。无数据库或文件修改、无模型调用。
- 修法：把冻结 `budgets.run.maxItems` 传入 v2 图，在根、每个分支展开累计越界时早拒绝，不能先进入正文阶段。保留旧图合同。补根边界、跨节点累计和未派正文回归。

### P2：repair 复制父任务 validate，清单仍绑定旧 taskId 的快照

- 位置：`electron-agent/electron/agentData/knowledgeKernel/coordinator.ts:79-83`；快照身份 `store.ts:240`；发布复核 `knowledgeProcess/projectPort.ts:86-87`。
- repair 复用父 prepared checkpoint 的分支位于本地 validate 分支之前，没有排除 validate。父任务在 validate 已 ACK、preparePublication 异步扫描时取消，会留下完整成果和旧完成清单。repair 创建新 taskId，图 inputHash 不包含 taskId，因此会复制旧 validate；旧 `sourceSnapshotId` 为父 taskId 前缀，目标发布要求新 taskId 前缀，必报 `COMPLETION_MANIFEST_MISMATCH`。
- 该时序可操作：发布未 pin 前 cancel 能力仍开放（`projection.ts:9`），取消意图使 `pinPublication` 拒绝发布（`store.ts:245`），父任务进入 cancelled，repair 能力开放。
- 修法：v2 repair 继续复用已 ACK 模型成果，但总是在目标任务重建本地 completion manifest。补“validate 已 ACK 后取消 → repair 成功发布、模型成果不重发”回归。

### P2：合法目录 ID 与 root / complete 控制节点冲突

- 位置：`electron-agent/electron/agentData/knowledgeKernel/pipeline.ts:81,86-96`。
- 顶层 logicalId `root` / `complete` 通过现有 ID 校验；`expand:true` 时分别创建同名 `catalogue:root` / `catalogue:complete`。前者被已完成根节点的 ID 误命中，后者被协调器当作本地完成屏障，待展开内容不再运行。
- 本次纯内存生产函数复现结果：
  - `root`：目录节点为 `[catalogue:root, catalogue:root, catalogue:complete]`，ready 直接进入 complete，requiredPages 为空。
  - `complete`：待展开 definition 挂在 `catalogue:complete`，ready 被当作完成屏障，requiredPages 为空。
- 修法：使模型逻辑节点和控制节点身份不碰撞；若明确保留顶层 ID，必须在写图前明确拒绝，并同步模型说明，而不能将未展开项当完成。补两种冲突与普通 nested ID 回归。

## 修复候选定向复核

复核范围为 `core-review-fix.diff` 的 6 个文件及直接消费者，不重复整套检查。

1. **规划项上限已修复。** `coordinator.ts:51` 从冻结预算传入 `maxItems`；`pipeline.ts:90` 在写入新增 definitions 之前检查累计数；`projectPort.ts:80-82,92` 使用同一上限重放并校验图身份。500 项成功、501 项早拒绝、自定义冻结上限和跨节点累计回归均覆盖。无正文派发后才发现超限的问题。
2. **repair 清单身份已修复。** `coordinator.ts:80` 排除 validate 的父 checkpoint 复用，目标任务走本地清单重建。回归真实保留 validate ACK、取消父任务，再 repair；正式发布 1 页、模型 calls 不增长、清单 sourceSnapshotId 使用新 taskId。其 RED 确实为 `COMPLETION_MANIFEST_MISMATCH`，GREEN 已通过。
3. **目录命名碰撞已修复。** `pipeline.ts:93` 仅 v2 逻辑节点改为 `catalogue:item:<logicalId>`；控制项仍为 `catalogue:root` / `catalogue:complete`。`root`、`complete`、`normal/nested` 都保留作者逻辑 ID，必须逐项完成才出现屏障；旧 v1 命名未变。调度、预算的 phase/kind 校验、replay 和增量复用均按完整节点 ID 运作，未发现新的命名假设破坏。

证据：`core-red/green-max-items.log`、`core-red/green-validate-repair.log`、`core-red/green-catalogue-namespace.log`；最终 `core-green-review-fixes-affected.log` 为 8 文件 60 项通过，`core-typecheck-review-fixes.log` 严格类型通过。未重跑这些有效检查。

## 已核对的主合同

- v1 无 executionPolicy 继续原 unit、串行图、两层目录；graphHash、恢复和 repair 使用冻结 pipelineConfigHash；新建/reanalyse 使用 v2。repair 的冻结 policy/budgets 复制保留，目标任务重新构建 validate，未见版本升级强迫旧任务重建。
- v2 profile 数值与规格表一致；stage_kind 在 schema 7 可空迁移，由协调器图 kind 写入，store 按 domain/phase/itemId 校验；worker 不能自选用途。SQLite `BEGIN IMMEDIATE` 中总计已结算/未结算 reservation，run 余额不被并发重复出售。
- worker host、宿主服务和 vendor client 使用 task/fence/phase/item/attempt 完整身份，清理只删除同一登记；正常 runtimeBridge 只 drain execution，整任务停止/收尾 drain 全部。授权撤销按任务 fence 合并 abort，既有共享 HTTP 槽不被 stage 并发数绕过。
- readyScheduler 只用 ACK 后的 completed DAG；目录最浅在途层阻止下一层；单一协调器按 Promise.race 串行提交并补槽。独立失败不终止其他独立条目。
- v2 Wiki/Cards 必需集合来自冻结图；发布端重放 checkpoints、再次核对清单与正文/关系证据；项目文件原有 journal、fence、人工编辑合并与收据恢复路径保留。
- activeItems 是 stage 在途项，非 HTTP 数；UI 已修复暂停/终态单项回退，legacy 缺字段兼容仍保留。复用 UI 任务 6 的独立有效审查，未重跑其场景。

## 已复用的有效证据

- `core-report.md` / `core-final-targeted.log`：最终受影响核心 11 文件 114 项通过；前置 20 文件 170 项仅对未受后续改动影响部分复用。
- `core-typecheck.log`：严格 KnowledgeKernel 类型通过。
- `integration-report.md` / `integration-summary.json`：9 个双 OS child + 官方 SDK + loopback 场景；stage 峰值 3，HTTP global=1/2 峰值分别 1/2，补槽与 ACK、目录屏障、取消、SIGKILL 恢复、v1 恢复、人工编辑 repair、增量复用已有有效 GREEN。
- `ui-review-fix.md` / `ui-report.md`：46 项定向单测、真实 Electron repo-wiki 163 PASS；UI 原 P2 已修。

## 交付与范围

本次独立代码审查无未解决项，可交根 owner 整合构建与笔记门禁结果后交付。真实付费模型、用户实例加载验证、重启和发布不在本次授权内，不作为扩大授权的阻塞理由。

