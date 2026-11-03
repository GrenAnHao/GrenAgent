# Native Wiki 执行内核：静态交付记录

## 已写入

- `runner.ts` 的 `createWikiExecutor({ requestModel })` 按 full/regenerate、incremental 和基于已持久化 incremental-plan 的 repair 分流。
- `fullGeneration.ts` 接入原版模板和解析器，串联 README、overview、plan、分层目录及独立页面池；pages 作者模式绕过自动规划。目录、阶段、逐页结果持久化；首轮已有成功时只补偿失败项一次，非空首轮全失败直接失败。每轮单项最多两次 attempt。
- `incremental.ts` 写入 Git 基线阈值门、零差异 advance、提交及目录分析、update 后 add、显式后代删除、逐页 checkpoint 和部分覆盖保护；同目标 repair 复用复制的计划与成功项。保留旧页依赖 store 的增量合并语义。
- `sessionRuntime.ts` 和 `repositoryTools.ts` 提供受限模型会话；四个仓库工具只在授权根内读取，增量目录分析额外绑定固定 prior Wiki 的原版 SearchWiki/ReadWiki。每次模型请求提交模型桥前先原子登记 dispatched 和保守 reservation；`model-submitted` 包含等槽，获槽后 SDK 前另记 `model-dispatched`（provider 调用在途，不声称底层 HTTP 已发出），成功用量不足以结算或异常记 unknown；输出上限默认 16000，上下文窗口 150000，最多十个工作回合及一个收尾回合。这是宿主适配，SDK 隐式消息、精确原生工具及分词估算并未核实。
- `authorConfig.ts` 使用操作确认时冻结的作者输入；auto 只含约束/notes 不触发页面绕过，pages 使用显式页面树，不把旧 depends_on 当作执行边。`repository.ts` 复用既有扫描器取得 README 和冻结 source manifest，并将增量 Git 差异限制在前后 manifest；按目标 commit 与源码范围检查 dirty/untracked；发布前重扫源快照。
- 编写 `sessionRuntime.test.ts`、`fullGeneration.test.ts`、`incremental.test.ts`，分别覆盖路径边界/用量、作者配置和补偿、增量阈值/advance/后代删除。这些只是未执行的用例，不构成通过证据。

## 主进程与 AgentData 接线

`nativeWikiModel.ts` 将冻结模型对象映射到现有 `bindKnowledgeModel` / `requestKnowledgeMessage`，通过 `normalizeContext` 发送 SDK 工具 schema，并回传完整 assistant、工具调用、停止原因及可结算用量。回放只接受该运行中本桥实际返回的 assistant；仅目录增量分析可声明 SearchWiki/ReadWiki。模型请求使用 AgentData 资料 Wiki 的现有全局模型槽，取消后直到 provider 真正结束才释放。`main.ts` 通过现有 `project.read` 核验仓库/分区并取得和 legacy `store.claim(read.scope, ...)` 相同的 scope。`nativeWikiProjection.ts` 在同一 AgentData `agent_job_leases` 锁表中占有目标，并仅投影任务状态及 stage，不启动旧协调器；显式恢复必须由调用方证明旧 child 已退出，且主进程该 operation 没有模型在途；文件投影可临时占用同一目标锁而不绑定或调用模型。

已编写但未运行 `nativeWikiModel.test.ts` 与 `nativeWikiProjection.test.ts`。模型桥与 service 的 requestId、sourceManifest/sourceScope、operation/stage outbox 等待主代理完成调用侧静态整合。provider 的隐式 SDK 消息、Qoder priority-now 信道和准确 token 化仍属于宿主适配差异：收尾提示逐字使用固定版本，UTF-8 bytes/3 按分段估算，工具结果消息以 Pi 适配格式估计。

## 仍需整合和人工验证

1. 已针对 provider 返回与 pause 竞争修正：终态先结算和保存 checkpoint、暂停时不发布；有待执行工具的响应不会继续调用工具。attempt 已按 operation、阶段、页面及补偿轮次写业务 checkpoint；无 transcript 的在途 attempt 显式 resume 后重建同一业务 attempt、记录 sessionRestartCount；之前的 actual/unknown 用量及独立费用上限保留。并发中断、失败补偿与模型在途组合尚需针对性用例和验证；不得将未知消耗当作退款。
2. Git commit 材料按参考格式保留 APPLY/DROP、完整消息、作者及日期，并按 profile 截断；授权 scope 当前从 operation.plan 的 include/exclude 读取，需主进程确认与用户确认的范围相同。Git-only 的目标提交和范围内干净工作树是当前准入条件；非 Git/脏源码会明确拒绝，不能包装为已支持。
3. `effectiveProfile` 各用途覆盖和请求/有效配置回显、宿主模型停止原因/HTTP 口径，以及 usage ancestor 与全量/增量发布的组合需在消费者整合后验证。当前默认已用冻结模型的 contextWindow / maxOutputTokens 对 150000 / 16000 截取；store 对 maxModelRequests / maxTotalTokens 做事务准入，模型并发门接入现有 AgentData 槽。
4. 作者配置持久化、revision/CAS、旧计划显式转换及 UI 不在本 owner 范围；需主代理与相应 owner 完成。
5. `prior-publication` checkpoint 固定增量输入与发布 CAS 目标；发布事务按 expectedPriorPublicationId 执行 CAS；增量计划的目录/投影合并、同目标 repair、后台重启与仓库文件安全需在最终 service/store/主进程适配后逐项静态整合和手工验证；当前代码不应作为可执行验收结果。

## 接口及检查状态

模型桥类型见 `sessionRuntime.ts` 的 `WikiModelRequest`、`WikiModelTurn`、`WikiRequestModel`。`requestModel` 接收运行对象、systemPrompt、messages、限定 tools、单次 maxOutputTokens 和 signal；返回正文、可选工具调用、停止原因及实际用量。原版 SDK 精确消息结构是 unknown，模型桥不得声称逐字复刻。

遵照本次授权，没有执行测试、类型检查、构建、应用、Qoder、模型或网络付费；也没有对真实数据库执行任务。未执行项不得标记通过。已做的检查仅限静态读取规格、固定参考源码、合同及新文件。
