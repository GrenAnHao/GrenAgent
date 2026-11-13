# Agent Note: 裁撤 Repo Wiki 全功能与知识卡执行链

Status: implemented

## Problem

用户要求裁撤 Repo Wiki 相关功能，明确包含 UI 层。该功能横跨四层：vendored 引擎（`vendor/repo-wiki/`）、主进程服务与原生生成引擎（`app/repoWikiService.ts`、`wikiService/`）、独立 OS 子进程（`knowledgeProcess/`）、渲染层模块（`src/features/repoWiki/`），并经 `electron/main.ts` 与 AgentData 运行时深度接线。此外，产品里还存在两个同名概念：本次目标是项目级 Repo Wiki；资料 Wiki（`wiki-rag`）早已下线，只剩文档与否定断言残留，不属裁撤范围。

必须先确定的边界是 `electron/agentData/knowledgeKernel/`。`electron/main.ts` 明确标注它「当前用于知识卡」，`coordinator.ts` 按 `domain === 'wiki'` 分派到 Wiki 阶段图或 `buildCardStageGraph`。因此「删掉 Repo Wiki」与「是否可以整目录删内核」不是同一件事。[轻量解耦评审](../../proposed/architecture/2026-11-03-agentdata-lightweight-decoupling-review.md)的 D2 曾建议 cards 先保留 Kernel，属于上一轮未落地的建议，不构成对本次裁撤的约束。

## Decision

用户拍板三点：**全量物理删除**、**知识卡一并裁撤**、**运行数据与历史资产全部保留**。

1. **代码按「删除本体 + 拆解反向接线」两层执行。** 删除 vendored 引擎整包、`wikiService/`、`knowledgeProcess/`、`knowledgeKernel/`、`app/repoWikiService.ts` 及 native 配套、`shared/knowledgeKernelContracts.ts` 与 `wikiLinks.ts`、`src/features/repoWiki/`、专用测试与 fixtures、UI harness 场景、专用构建钩子/打包条目/tsconfig/vitest 配置/npm 脚本。同步拆解 `main.ts` 的装配与 IPC、`assemble.ts` / `runtime.ts` / `jobStore.ts` / `operationsContracts.ts` 的类型与分支、UI 的菜单/路由/设置/模块联合类型。
2. **知识卡随 Repo Wiki 一并下线。** 不保留 `cardPipeline`、`admin.knowledge.*`、`knowledge.sqlite` 的读取与启动自动恢复；内核整目录删除，不做「只删 wiki 分支」的半裁撤。这样共享合同与知识子进程可以整体移除，不会留下只服务已删功能的悬空抽象。
3. **数据、内容与历史记录一律不动。** `userData/repo-wiki/*.sqlite`、项目 `docs/repo-wiki/` 下的人工编辑与已发布正文、`.agents/notes/`、`.agents/evidence/`、`docs/decisions/`（冻结只读）、`docs/superpowers/`、`openspec/changes/` 历史规格、`.pi/visual/` 原型均保留。代码不再读取这些数据库，但不做删除、迁移或归档，也不清理用户目录。
4. **历史笔记不改写、不归档。** 用户明确选择「只在新笔记里标注功能已裁撤」；本笔记的归属审计表承担取代说明，避免为标注状态而批量修改冻结或历史文件。

## Scope

**删除**：`electron-agent/vendor/repo-wiki/`、`electron-agent/electron/wikiService/`、`electron-agent/electron/knowledgeProcess/`、`electron-agent/electron/agentData/knowledgeKernel/`、`electron-agent/src/features/repoWiki/`；`electron/app/repoWikiService.ts`、`nativeWikiController.ts`、`nativeWikiModel.ts`、`repoWikiKnowledgeModel.ts`、`electron/agent/repoWikiHostBuild.ts`、`agentData/nativeWikiProjection.ts`、`shared/knowledgeKernelContracts.ts`、`shared/wikiLinks.ts`；上述目录内全部测试与 fixtures；`ui-harness/scenarios|probes/repo-wiki*`；`tsconfig.repo-wiki.json`、`tsconfig.knowledge-kernel.json`、`vitest.repo-wiki*.config.ts`、`scripts/test-repo-wiki*.mjs`、`scripts/verify-repo-wiki-catalogue.mjs`、`scripts/fixtures/repoWikiWorkflowAgentDataHost.ts`。

**修改**：`electron/main.ts`、`electron/agent/workerEntry.ts`、`electron/agentData/{assemble,runtime,jobStore,operationsContracts,operationsProjection,knowledgeModelPort}.ts`、`electron/ipc/contracts.ts`；`src/stores/moduleStore.ts`、`src/features/layout/ModuleRail.tsx`、`src/features/workspace/ModuleContainer.tsx`、`src/features/settings/settingsSchema.ts`、`src/features/agentData/operationsPresentation.ts`、`src/lib/agentData.ts` 及对应单测断言；`electron.vite.config.ts`、`electron-builder.yml`、`electron-agent/package.json`、`vitest.config.ts`、`tsconfig.node.json`、`scripts/collect-third-party-licenses.cjs`；`AGENTS.md`、`docs/architecture.md`、`README.md`、`extensions/README.md`、现行 `docs/repo-wiki*.md`、第三方许可证说明。

**保留**：线程 / 回合 / 条目 / 权限规则 / 工具审计 / 插件状态等 AgentData 共享基础设施；CodeGraph 索引与 `code_explore`；已冻结的 `docs/decisions/`；资料 Wiki 残留的否定断言（它们描述的是另一个已下线功能）。

## Related notes

已检索 `proposed` / `implemented` / `rejected` 中的 repo-wiki、Kernel、裁撤关键词。以下记录描述的功能均已随本决定下线；按用户要求原文件保留作历史考据，不改写、不归档，取代关系以本节为准。

- 完全被取代：`implemented/architecture/2026-10-31-repo-wiki-process-integration.md`、`2026-10-31-repo-wiki-project-files-and-lazy-service.md`、`2026-11-01-repo-wiki-agentdata-durable-tasks.md`、`2026-11-01-repo-wiki-knowledge-kernel.md`、`2026-11-02-repo-wiki-qoder-alignment.md`；`implemented/bug-fix/2026-10-31-repo-wiki-host-workflow-alignment.md`、`2026-10-31-repo-wiki-windows-git-identity.md`、`2026-10-31-repo-wiki-windows-stream-and-wal-tests.md`、`2026-11-01-repo-wiki-git-safe-directory.md`、`2026-11-01-repo-wiki-partial-tool-output.md`、`2026-11-01-repo-wiki-real-model-shakedown.md`、`2026-11-01-repo-wiki-token-budget-estimate.md`、`2026-11-01-repo-wiki-unified-knowledge-ui.md`、`2026-11-03-repo-wiki-catalogue-failures.md`、`2026-11-05-repo-wiki-retired-task-import.md`。
- 前提消失的提案：`proposed/architecture/2026-11-02-qoder-repowiki-native-replica.md`、`proposed/bug-fix/2026-11-02-repo-wiki-generation-validation-repair.md`。二者状态保持 proposed，不再推进。
- 部分重叠但仍有独立价值：[退役 AgentData 产品面](2026-11-04-retire-agentdata-surface.md)记录的共享基础设施保留边界继续成立，仅其「Repo Wiki 与知识卡各自持有运行时」这一前提失效；[轻量解耦评审](../../proposed/architecture/2026-11-03-agentdata-lightweight-decoupling-review.md)的代码证据与 CodeGraph 结论仍有效，其 Wiki/cards 改造路线不再推进；[移除长期记忆](2026-10-31-remove-agentdata-memory.md)与本次无关。

## Alternatives considered

- **只断产品入口、代码留存** — 改动面最小、回滚最快，且能立刻从 UI 移除功能。否决：留下整套不可达的引擎、IPC、子进程与测试，与「裁撤」语义不符，后续维护者无法判断哪些代码是死代码。
- **仅裁 UI 层** — 最快。否决：主进程仍会装配服务、构建仍会打 `repo-wiki-host.cjs`、启动仍会创建数据库目录，功能并未真正下线。
- **保留知识卡，只删 Wiki 分支** — 保护 cards 功能，且能避免误停仍在恢复的旧任务。否决：用户明确要求一并裁撤；半裁撤需要保留整条 Kernel 运行时、共享合同、模型端口与子进程，仅为支撑一个同样要下线的功能，属于为一个已删除域保留全部脚手架。
- **顺带清理用户运行时数据与历史笔记** — 表面最干净。否决：数据库与项目正文含人工编辑且删除不可逆；历史笔记、evidence 与冻结决策是考据依据。用户明确选择全部保留。
- **把资料 Wiki 残余一并扫净** — 减少关键词噪声。否决：那是另一条早已下线的链路，其否定断言仍在守护「不要复活 wiki_search」的边界，混删会扩大改动面且失去防回归价值。

## Consequences

- **收益**：构建不再产出 `repo-wiki-host.cjs`，启动不再装配 Repo Wiki 服务、知识模型代理与独立子进程；渲染层不再有该模块入口、路由、设置分类与主题分支；六条专用 npm 脚本、两份专用 tsconfig、三份 vitest 配置与三个 harness 场景一并消失。
- **代价**：Repo Wiki 生成、发布、阅读与知识卡能力全部消失，且没有功能开关或恢复路径；若要重新引入，只能从历史笔记与 Git 历史重建。
- **代价**：`userData/repo-wiki/` 下的 `tasks.sqlite`、`knowledge.sqlite`、`write-gate.sqlite`、`native-tasks.sqlite`、`native/projects.json` 及项目 `docs/repo-wiki/` 正文成为孤儿数据，继续占用磁盘但不再被读取。用户已接受。
- **代价与已知上限**：`tsconfig.node.json` 的既有诊断、`electron/agentData/runtime.ts` 的重复成员、`electron/ipc/contracts.ts` 指向缺失 `wikiContracts.ts` 的历史悬挂引用均属改动前既有红。本变更只处理与 Repo Wiki 直接相关的引用，不借机重构这些既有问题。
- **必须重访的信号**：若日后需要恢复任何项目级文档生成能力，应先确认 `userData/repo-wiki/` 与 `docs/repo-wiki/` 是否仍保留，再按新合同重建，而不是复活旧 IPC 通道与 `repo-wiki-host.cjs` 构建钩子。

## Verification

执行后统一验证（2026-11-08）：

- **悬挂引用复查**：全仓对 `repoWiki|RepoWiki|repo-wiki|wikiService|knowledgeKernel|KnowledgeKernel|nativeWiki|NativeWiki|knowledgeModelTurn|writeGate|knowledgeKernelContracts|wikiLinks` 的 Grep 在活跃代码中无任何命中；唯一匹配集中在冻结区（`docs/superpowers/specs|plans/`、` .agents/evidence/`）与 `main.ts` 里保留的通用系统任务模型端口 `createAgentDataModelPort`（非知识卡）。
- **`tsc -p tsconfig.json --noEmit`**：0 错误，无 wiki/knowledge 相关诊断。
- **`electron-vite build`**：exit 0，无 ENOENT、无 `build-repo-wiki-host` 报错；`electron-builder.yml` 的 `asarUnpack` 与 `electron.vite.config.ts` 的钩子已同步移除。
- **受影响 Vitest（53 项全过）**：UI 层 `moduleStore / ModuleContainer / ModuleRail / settingsSchema / agentData` 与 `electron/app/thirdPartyLicenses.test.ts`（重新生成报告后一致）。AgentData 后端测试 161 项过、3 项失败，`storage.toolPermission.test.ts`（schema 版本期望 4 实为 7）与 `storage.memoryRemoval.test.ts`（记忆数据迁移）属改动前既有红，与本次裁撤无关。
- **`verify-notes`**：159 笔记树/格式 + 2 归档全部通过。
- **`smoke-check.mts`**：移除指向已删知识卡运行时的 `writeGatePath / nativeProjectionPath / knowledge` 三个 option 与第 3 项 `admin.knowledge.*` 检查（该 .mts 不进 tsc，但运行时会失败，已同步清理）。
- **保留确认**：资料 Wiki（wiki-rag）的否定断言与文档未动；`userData/repo-wiki/*`、`docs/repo-wiki/`、`docs/decisions/`、`docs/superpowers/`、`openspec/`、` .agents/notes|evidence/` 均未触碰。
