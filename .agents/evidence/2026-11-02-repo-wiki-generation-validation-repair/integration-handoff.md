# Integration handoff — 生成校验失败与 repair

执行按用户新路由停止在安全点；后续实现/运行交快速执行模型，Sol 仅审查。没有回滚工作，没有派代理。

## 当前结果：4 条测试，2 条已 RED，2 条尚未运行

源文件 `electron-agent/electron/app/repoWikiKnowledgeKernel.integration.test.ts`：

1. `persists v1 validation failures and repairs only the bad page through two real children`
2. 同名 v2 参数化用例
3. `locally revalidates a persisted v1 candidate from an older validator without new HTTP`
4. 同名 v2 参数化用例

**不能把它们全部记成已实跑 RED。** 前两条已经执行并命中产品问题；后两条已写好，但等待核心接口，尚未执行。当前源代码是在取得 RED 后增加后两条，并把重复启动代码提取成 startValidationVersion；这一版尚未再次运行。

已运行命令（electron-agent 目录，显式关闭付费入口）：

```powershell
$env:REPO_WIKI_REAL_E2E=$null
npx vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts -t 'persists v'
```

结果：2 failed / 9 skipped（当时总 11 条）。两条均在父任务 failed 后发现 `generate:library` 构建行仍是 running，预期 failed；不是测试启动或编译错误。日志为本目录 `integration-red.log`。此次 Vitest parent PID 63276，OS child 包括 22508/48552；已正常清理，执行会话 92161 退出码 1，已结束。

交接前只读进程盘点未发现命令行包含 `knowledge-kernel-build` 的残留 OS child；没有本代理仍在运行的测试或工具会话。未终止任何其他代理/用户进程。

## 本轮 app 层改动

### repoWikiKnowledgeKernel.integration.fixture.ts

- 新可选 `validationLinks` 模式；默认行为不变。
- library 的官方 Read 改为实际读取 fixture README.md，来源也指向实际读取的第 1 行。
- 模型正文包含真实源码 `[Readme](README.md#kernel-fixture)`、真实 Wiki `[API page](api.md#api)`、fenced 与 inline code 中的伪链接，以及真实未知 `[Broken Wiki](missing-page.md)`。
- `provider.repairLinks()` 仅去掉真实 unknown 链接，用于自然失败后的模型 repair；代码块伪链接保留。

### repoWikiKnowledgeKernel.integration.test.ts

- workflowFixture 可传 validationLinks；ledger 查询包含 payload/error。
- fixture JSON 报告新增 buildItems，保留全部候选 payload/error/evidence/dependencies/input/output hash，而非只记录 prepared ACK。
- startValidationVersion：v2 正常创建；v1 用现有 KnowledgeBuildStore 在测试临时 DB seed 冻结 `knowledge-kernel-v1` task，再通过真实 OS child 启动自动恢复，不加生产 legacy 开关。
- 前两条要求 failed 非 running、候选 payload 不丢、error 包含 INVALID_PAGE_LINK 和 missing-page.md、候选不进入 drafts/prepared/正式；repair 新 taskId，只重做 library，api 不重发；正式 receipt/全页集合/Markdown/来源由既有 inspectPublishedWiki 严格检查。
- 后两条先自然失败，再停 fixture；以真实候选的 evidence/dependencies/inputHash 构造“上一 validator 错拒 README/code 示例”的历史候选（去掉 unknown，但保持 state=failed），在测试专用 fence 下用 beginAttempt + commitItem 保存。重新开双 OS child 后 repair，要求 **新增 HTTP=0**、父候选仍 failed、目标 library prepared、正式两页完整。此段明确是历史 fixture seed，不冒充自然模型失败。

本轮没有改 core/shared/worker/RepoWikiService/UI，也没有动 repoWikiRealModel.e2e.test.ts 或 repoWikiWorkflow.integration.fixture.ts（后二者的先前改动属于上一任务，须保留）。

## 与核心 owner 对齐的待消费接口

owner：`/root/repair_generation_boundary`。最后收到的方案约定如下；尚未收到可消费 GREEN 通知，接手人先确认当前实际实现：

- 不改 schema；校验失败行 `state='failed'`，`payload` 为原模型对象 `{markdown,sources}`，不是 prepared，evidence/dependencies 保留。
- `error={code:'INVALID_PAGE_LINK',message:'Page <id>: invalid page link <safe-relative-target>',retriable:false}`。
- 新 `store.readFailedCandidate({taskId,phase,itemId})` 返回 `VerifiedArtifact & {error}`；只准入 INVALID_* 校验失败且有 payload/hash 的行；不存在时报 CANDIDATE_NOT_FOUND。
- repair 在源码/inputHash/模型/计划/依赖匹配时，先以当前 normalization + validation 本地复验。通过则写目标 task prepared，父候选不改，不耗模型；仍失败才正常 runStage。
- 历史候选 fixture 使用现有 commitItem，disposition=failed，payload 原样对象，outputHash 用 hashKnowledgePayload(payload)。测试 seed 在临时 DB，不触碰真实用户任务。

已向核心 owner 发送 RED 证据与以上 fixture 方案。核心改动继续由其负责；app 遇核心故障返该 owner，不自行越界修 core。

## 接手后的最短路径

1. 消费核心交付，检查 `readFailedCandidate` 与失败 payload/error 的实际契约是否符合上述约定；必要时只适配测试。
2. 显式清除 REPO_WIKI_REAL_E2E，仅运行本轮四条：

```powershell
cd electron-agent
$env:REPO_WIKI_REAL_E2E=$null
npx vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts -t 'persists v|locally revalidates'
```

3. 修实际 fixture 问题；产品问题返核心 owner。不要跑其他已有效的并发/取消/目录/修复全套矩阵。
4. 保存 GREEN 日志；fixture 会在系统 temp 写 `knowledge-kernel-integration-<Vitest PID>-validation-links-v1/v2.json` 和 `...-candidate-revalidation-v1/v2.json`，把这四份复制到本 evidence 目录。
5. 将四条实际结果、正式页/正文/来源及模型调用增量补入 integration-report.md。严格区分模型 repair（只 library 新调用）和候选本地 repair（HTTP0 新调用）。

当前未完成：四条当前版本 GREEN、最终 fixture 类型/运行问题检查、候选复验实际证据、最终报告。核心/构建/UI/笔记门禁由根代理统筹。

## 授权

只允许 temp + loopback。禁止付费模型、真实用户任务、应用重启、Git 提交/推送/发布。用户授权的一次真实验收由根代理操作，不由本接手执行者自行启动。

## 核心 owner 交接时的最终状态更新

`repair_generation_boundary` 已确认：AST/shared 链接校验 helper 已写，5 项 RED→GREEN；**store.readFailedCandidate、coordinator 失败落账与 repair 本地复验尚未实现**。当前后两条测试不能执行成功，前两条仍等待落账接线。其无后台命令。核心交接见同目录 `handoff.md`，根代理将指定快速执行者接手；本 app fixture 交接与其方案对齐。
