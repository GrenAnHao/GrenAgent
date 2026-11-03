# Repo Wiki 宿主工作流接入验收

本目录保留第二阶段调度接线记录。首屏、项目文件事实来源及按需服务的当前实现和最终验收见 [项目文件与按需服务](../2026-10-31-repo-wiki-project-files-and-lazy-service/README.md)；以下旧计数、生命周期和全项目投影流程只代表当时版本。

2026-10-31。本轮修正用户实测指出的两个缺口：AI 请求进入已有知识调度，项目自动来自宿主。[首阶段记录](../2026-10-31-repo-wiki-process-integration/README.md) 中的手工连接与直接短调用已被本轮取代。源码 v3 SHA256 仍为 `899862f29c20f402e379dcab35bc2fa603f61aa4e3c52e1e015a47ac4c7988b5`。

## 当前入口与实际调用链

用本次构建启动 GrenAgent，左侧 **Repo Wiki** 自动进入当前已打开项目。集合页按宿主登记项目自动建立 Wiki 元数据，选择其他项目复用 `pi.openWorkspace` / `applyOpenedProject`。无项目或普通临时对话显示空态。嵌入界面无需填写路径、克隆仓库或选择独立 provider 模式，保留原森林绿集合、概览、阅读、知识卡片与编辑功能。

```text
Repo Wiki 独立 OS child 的模型桥
  → AgentDataService.completeKnowledge
  → 私有 agentdata.knowledge.complete RPC
  → AgentDataRuntime → WikiService.completeKnowledge
  → 现有 WikiService.globalLlmLimit（与旧 wiki.ingest 共用）
  → AgentDataModelPort → main.model.complete
  → createAgentDataModelPort（agentDataModel 配置）
  → ModelRuntimeHost → Pi SDK → provider
```

实际预算是 `KNOWLEDGE_LLM_GLOBAL_CONCURRENCY`。未将没有生产调用的 TaskQueue / SystemWorkerManager 宣称为统一调度，未新增任务账本或自动重放。扫描、索引、SQLite、生成编排仍在 Repo Wiki 子进程；AgentData 数据库仍由原进程持有。

取消覆盖排队与运行；切项目使旧 context 失效并取消旧任务。崩溃恢复轮换上下文，拒绝旧物理 child / 实例事件；自动重启预算耗尽后只允许显式重试。语言 namespace、草稿恢复和关闭保护一致。嵌入模式拒绝 demo，watch 只扫描并标记待更新。

模型配置身份包含模型快照、真实 SDK request config 与 models.json 来源。裸模型无法识别同 ID 的 provider headers 改动，已由真实 SDK 复现。身份贯穿双子进程，在获得调度槽及 SDK 派发前复核；旧绑定拒绝 MODEL_CHANGED，新绑定使用新缓存身份。不记录密钥或原始配置。

## 主要修改文件

以下工程路径相对 `electron-agent/`。

| 范围 | 文件 |
| --- | --- |
| 主进程与模型端口 | `electron/main.ts`、`electron/agentData/createAgentDataModelPort.ts`、`electron/app/repoWikiKnowledgeModel.ts`、`electron/agent/modelRuntimeHost.ts` |
| 现有知识调度与取消 | `electron/app/agentDataService.ts`、`electron/agentDataProcess/{contract,host,assemble,modelPort}.ts`、`electron/agentData/runtime.ts`、`electron/agentData/wikiEngine/{service,llm}.ts`、`electron/agentData/wikiEngine/ingest/concurrency.ts` |
| 自动项目及上下文 | `electron/app/repoWikiService.ts`、`electron/app/workspaceService.ts`、`src/features/repoWiki/RepoWikiWorkspace.tsx`、`src/features/repoWiki/repoWikiClient.ts` |
| 原界面适配 | `vendor/repo-wiki/apps/web/src` 中宿主 props、自动选择、上下文隔离与草稿保护；`src/features/repoWiki/testing/runtimeFixture.ts`、`ui-harness/scenarios/repo-wiki.tsx`、`ui-harness/probes/repo-wiki.mjs` |
| 子进程边界 | `vendor/repo-wiki/packages/process/src/{client,child}.ts`、`vendor/repo-wiki/packages/service/src/service.ts` |
| 实际链验收 | `electron/app/repoWikiWorkflow.integration.test.ts`、`electron/app/repoWikiWorkflow.integration.fixture.ts`、`scripts/fixtures/repoWikiWorkflowAgentDataHost.ts`，及对应调度、项目、模型端口、UI 定向测试 |
| 门禁与说明 | `tsconfig.repo-wiki.json`、根目录 `AGENTS.md`、[决策笔记](../../notes/implemented/bug-fix/2026-10-31-repo-wiki-host-workflow-alignment.md) |

## 最终验证

各组有重叠，不能相加为总数。完整命令见对应报告。未跑其余 43 个 UI 场景。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 知识调度回归 | 19 文件、101 项通过 | [日志](scheduler-tests-normal.log)、[报告](scheduler-alignment-report.md) |
| 配置贯穿追加回归 | 4 文件、27 项通过 | [日志](scheduler-configuration-tests.log) |
| 模型端口与 ModelRuntimeHost | 3 文件、22 项通过 | [日志](workflow-sdk-request-config-green.log) |
| 宿主后端 | 66/66 通过 | [后端报告](project-backend-alignment-report.md) |
| process client / 独立模式 watcher | 10/10、4/4 通过 | [后端报告](project-backend-alignment-report.md) |
| 宿主 UI/client / vendor UI | 21 项、71 项通过 | [UI 报告](ui-alignment-report.md) |
| 真实静默 Electron UI | 69 PASS / 0 FAIL，仅 repo-wiki 1/44 | [UI 报告](ui-alignment-report.md)、[截图](ui-evidence/overview.png) |
| 双 OS child + 真实 SDK / HTTP | 1 工作流、7 组行为通过，77.49 秒 | [报告](workflow-integration-report.md)、[调用跟踪](workflow-integration.log) |
| 正式 preload / 原生 IPC | 自动项目、token、跨窗口/导航拒绝、退出通过 | [日志](workflow-window-smoke.log) |
| 最终严格类型检查 | `npm run typecheck:repo-wiki` exit 0 | [日志](workflow-targeted-types-final.log) |
| 最终生产构建 | `npm run build` exit 0 | [日志](workflow-build-final.log) |
| 定向复审 / 空白检查 | 无新增阻碍，限定 diff 检查 exit 0 | [复审](workflow-alignment-review.md) |
| 最终笔记门禁 | `npm run verify-notes` exit 0，132 篇、1 归档、6 条旧警告 | [日志](verify-notes-final.log) |

66/10/4 与 21/71/69 各组 stdout 只保留在工具执行记录，没有另存；上述报告记录准确命令和结果，不补造原始日志。双 child 日志是测试自身的调用链跟踪，Vitest 最终计数/耗时在报告与工具记录中。

端到端使用真实 WorkspaceService / opened-projects.json、Repo Wiki child、生产 AgentData host / runtime / WikiService、真实 ModelRuntimeHost / Pi SDK；只有无关 CodeGraph I/O 使用确定性桩，最终 provider 为 loopback HTTP。实际 PID：父 4724、AgentData 91152、Repo Wiki 62152。七组行为覆盖自动项目、知识模型 B 覆盖默认 A、旧 ingest 占共享槽及排队取消、运行中取消关闭连接、A-B-A / 空态 / 旧上下文拒绝、排队模型切换拒绝、同 ID headers 改动拒绝旧绑定并发送新配置。无用户付费调用。

原生窗口 smoke 使用正式生产 preload / IPC，主 PID 60972、child PID 70424。日志中两个 403 是跨窗口和导航后访问的预期拒绝，最终 JSON 确认自动项目、独立 PID 和停止。Electron 38.8.6 / Node 22.22.0 的既有 pak 提示未阻断检查。

## 验证边界

- Repo Wiki 模型桥单次 120 秒总预算包含共享队列等待，超时取消。
- 全工程 tsconfig.node 检查仍有 150 条既有诊断，见 [日志](workflow-typecheck.log)。本次严格 Repo Wiki 工程通过，不代表全仓类型检查通过。
- 本轮没有重复跑首阶段全部 194 后端、3 示例及构建许可测试；其历史结果保留。本轮按改动运行上表相关检查。
- 未生成安装包、提交、推送、发布或更改可见性，无关未提交改动保留；当前无权限或输入阻碍。

真实 SDK 修复前失败证据见 [配置回归说明](workflow-configuration-guard-red.md) 和 [日志](workflow-configuration-guard-red.log)，其余关键 RED / GREEN 记录一并保留。
