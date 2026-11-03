# Native Repo Wiki：阶段独立静态审查

日期：2026-11-02。审查者：Sol；执行实现 owner：Terra；主整合 owner：root。

## 结论和下一步

已完成稳定 kernel、主整合候选及最后修复的独立静态审查。前两轮及任务详情投影追加审查报告的 P1/P2 均已阅读对应修复，最后的 native 历史删除引用保护也已对齐数据层与 UI。审查范围内没有尚未解决的确定发现。这不是运行验收结果。

未执行测试、tsc、build、应用、Qoder、模型、重启或真实数据库操作。下述“修复已复核”仅表示已阅读当前修复代码，不代表运行检查通过。

## 阶段一发现与复核

### P1：暂停后的增量不能混用新的已发布快照（已静态复核修复）

- 原失败点：`D:/OneDrive/Project Files/Pi/electron-agent/electron/wikiService/incremental.ts` 原第 29 行每次调用 `context.published()`；`incremental-plan` 只保存 `result + delta`。
- 失败路径：A 增量已规划后暂停，B 在同分区、同目标提交发布新成果，恢复 A 后用 A 的旧计划搭配 B 的目录、旧正文和 Wiki 工具输入。有效租约只能避免同时写，不能阻止暂停间隙的输入漂移。
- 合同：本运行的 priorCatalogue / priorPages 必须冻结；发布不能覆盖后来已提交的版本。
- 当前变化：`repository.ts` 的 `pinPriorPublication()` 保存 sourceId / expectedId，repair 沿 parent pin 读取原输入并检查当前 publication 身份；`incremental.ts:28-30` 从冻结 publication 读取 prior；`store.ts:153` 在发布事务内核验 expectedPriorPublicationId。已窄读该链，未运行竞争/恢复用例。

### P2：Git 分叉材料与冻结的原版 formatter 不符（已静态复核修复）

- 位置：`D:/OneDrive/Project Files/Pi/electron-agent/electron/wikiService/repository.ts:43-44`；输入使用方 `D:/OneDrive/Project Files/Pi/electron-agent/electron/wikiService/incremental.ts` 的 `vars.CommitMessages`。
- 原实现只获取 `git log --format=%h %s baseline..target`，缺少 DROP（`target..baseline`）提交、完整 message、author、date；另对原始 diff 任意 `slice(0, 80000)`。
- 失败路径：分叉历史虽计入 `dropCommits`，commit-analysis 却拿不到原版标记“已不在当前代码中的变更”的 DROP 材料；输入限制和截断说明也不同。
- 原版依据：固定副本 `.tmp-qoder-analysis/engine/qoder-search.pretty.mjs:81806-81846` 的 `Dvt/fDn` 按 APPLY / DROP 分组、每 message 500 估算 token、总 20000 估算 token，保留元数据和截断说明。
- 当前 `repository.ts:39-74` 已提供 APPLY / DROP formatter、完整提交材料、500 / 20000 估算上限及截断说明；incremental 的 CommitMessages / FileChanges 已使用对应材料，不再拼入任意截断的原始 diff。已静态复核，未执行 Git fixture。

### P2：实际调用、工具与排队状态缺少持久化审计链（已静态复核接线）

- 位置：`D:/OneDrive/Project Files/Pi/electron-agent/electron/wikiService/sessionRuntime.ts:28-36,42-60`；`D:/OneDrive/Project Files/Pi/electron-agent/electron/wikiService/contracts.ts` 的 `WikiUsage`；`store.ts` 的 usage 存取。
- 原实现 assistant / tool calls / tool results 只在局部 `messages` 中；持久化 usage 没有业务项关联及排队/工具事件。
- 影响：会话结束或进程重启后不能按页面/尝试核对实际模型与工具调用，也不能从这些服务记录区分业务池、等模型槽和请求执行。若主整合另有持久化事件路径，需提供该消费链，而非重复建账本。
- 合同依据：generation 的 Accounting requirement；design 要求工作 step、SDK turn、工具调用和 HTTP 请求分别计数。
- 当前 sessionRuntime 的事件关联 stage / item / run / attempt / round / sessionRestartCount / requestId；store 持久化 session / model / tool 事件；nativeWikiModel 真正获共享槽后回报 dispatched，controller → native.requestDispatched 核验有效派发。inspect 提供 waiting / inFlight / tools / unknown 摘要，UI 已消费。已静态窄读该链；provider 内部 HTTP 重试仍不是这些本地 SDK 请求数。

## 已回修并阅读修复代码的发现

1. **P1 普通页面执行异常阻断无关页。** 原 `executeItem()` 非 retryable 错误被 pool 当整轮失败，既不补槽也不继续增量 add。当前 `fullGeneration.ts` 的 `throwIfGlobalFailure()` 与 full/incremental 页边界把普通错误保存为该页失败；abort、费用、失租和来源变化仍终止整轮。已阅读该控制流，未运行 fixture。
2. **P1 暂停丢失已返回有效终态、耗尽业务 attempt。** 当前 sessionRuntime 先返回已结算的无工具终态，再对工具继续路径检查 abort；`fullGeneration.ts:40-49` 区分 inflight / failed / done，同业务 inflight attempt 恢复不递增失败 ordinal，另外记录 sessionRestartCount。controller 的恢复经过显式 prepare / start 确认，普通 status 不派模型；无 transcript 时重建会话，旧 usage 不退款。已阅读 kernel 与主整合确认门。
3. **P2 语义错误收到“保持字段、仅修 JSON”指令。** 原目录 retry 总传 `repairCandidate=true`。当前 `fullGeneration.ts:44-46,59` 只对 no-valid-JSON / SyntaxError 使用 repair candidate；缺标题、重复同级 name 等使用重新生成指令。已阅读修复分类。

## 本轮实际覆盖

- 通读稳定 kernel：`wikiService/{fullGeneration,incremental,runner,repository,repositoryTools,sessionRuntime,authorConfig,contracts,store,service,host,referenceProfiles,referencePrompts,referenceParsers}.ts`，以及 `reference/qoder-0.5.1/{wikiTools,jsonRepair}.ts`。
- 通读模型 / 投影：`electron-agent/electron/app/nativeWikiModel.ts`、`electron-agent/electron/agentData/nativeWikiProjection.ts`；检查相关未执行 fixture 的意图。
- 对照六份 spec、design、tasks；窄读原版 `bf/K0/VUn/Ukt/fM/wTe/xTe/Dvt/Jo/Pw/Aw` 及配置来源。模板资产只对照 purpose / 占位符 / 纪律组成及 fixture，不宣称本轮人工逐字读完全部模板与 vendored repair 库。
- 重点追踪：每轮两次尝试与单轮补偿、首轮全失败 guard、resume 用量保留、增量无 diff advance / partial repair debt、受限源码工具与 manifest、共享模型槽、store fence、部分发布与 outbox。

## 阶段二：主整合与阅读器

- 通读 `app/nativeWikiController.ts`、`wikiService/projectAdapter.ts`、renderer 的 `NativeWikiPanel.tsx` 和 `contracts/native.ts`；以 root-preimage / ui-preimage 对照 repoWikiService、ProjectFiles、App、Markdown 的本次 delta。为核对直接消费者，窄读 WorkspaceEngine、WikiTree、process client、native host、store 和 model bridge。
- 视图退出：repoWikiService 的 context cancel 只清理 scoped legacy 请求；native 独立 map / service 不绑定该 UI context，离页没有取消已接受业务的路径。项目权限撤销仍拒绝后续新模型 / 源码访问；清理 release 需要独立完成。
- 文件投影沿用 ProjectFiles 读集 CAS / journal / fence；成功变更做三方合并，失败页保留旧文，显式删除归档。native marker 使 project.json 写为 v2，旧只认 v1 的读取器拒绝修改；native 停用分支仍先处理 status / drafts / projection.repair，不触发模型绑定。

### 已回修并阅读代码的阶段二问题

1. **P1 requestId 复用绕过确认身份。** 原 controller 按 list 中相同 requestId 直接挑旧 op，可能以新确认 B 派发旧配置 A。现非 resume 一律 native.start，让 store.accept 的完整输入幂等冲突核验生效；同 confirmation 的冻结输入重放保留。
2. **P1 撤销项目权限后无法释放已排空锁。** 原 native.release 也要求当前项目仍在 approved roots。当前 release 在撤权后仍核对保存 operation 身份与 bridge 的 active operation / leaseId，跳过文件投影后释放；其他 native 请求仍须当前权限。已阅读 controller bindClient 的修复顺序。
3. **P1 孤儿 running 的恢复按钮不可达。** 原 UI 将所有持久 running / queued 都当真实在途，禁用 resume。当前 status 从 inspect 返回 executor_active / recoverable，UI 对 resume 单独按 recoverable 控制；恢复仍要求明确外发确认。孤儿 pause / cancel 也先 recover；下述最后窄复核记录取消意图的完整修复。
4. **P1 项目投影损坏阻断 native 只读状态。** 当前 status 捕获 projectionStatus 异常并返回 error 状态；无法从项目文件探测分支时，用已选 op.branch 查询正式分区，避免已知成果变 0。UI status 与 author.read 独立加载，不再因作者文件错误丢掉正式状态。
5. **P2 分支切换后作者配置入口死路。** 当前 ProjectFiles.readNativeAuthor(branch) 支持当前分支 / 分支归档配置；保存切分支时先保留旧配置，storage token 覆盖 primary 与 archive。新分支可获得 revision 0 默认并显式保存；原配置不因切换消失。已阅读代码，未做文件操作验证。
6. **P2 原版引用依赖临时面板选择。** App 的 nativeCitations 现取 page.inputManifest.engine，不再依赖 transient nativeSelected；重挂 / 切回项目的原版 file 引用继续进入安全解析器。
7. **P2 drafts 静默只读首批 100 条摘要。** controller 已按 inspect.nextOffset 分页，并用 draftChunk 获取正文；不再以首批摘要代替完整集合。
8. **P2 原版目录被 hash ID 导航打平。** adapter 已投影 native_section（parentId / ordinal / sectionName），显示标题改用 sectionName；WikiTree 已增加原生结构分支。完整 nativeCatalogue 字段的最后消费修复见下文。

### 最后窄复核：两处消费遗漏已修复

**P2：完整目录字段嵌套层级不匹配（已静态复核修复）。**

- 原 engine 只在 knowledgeState 返回 native_catalogue，App 却读顶层 project.native_catalogue，失败新增 / 无正文的规划节因而不能进入完整目录。
- 当前 `D:/OneDrive/Project Files/Pi/electron-agent/vendor/repo-wiki/packages/core/src/engine.ts:713` 在 get_project 顶层返回 snapshot.nativeCatalogue；knowledgeState 的字段同时保留。App 的顶层字段消费者与 WikiTree 完整目录输入现已匹配，成功页仍保留 native_section。

**P2：孤儿 pausing 上的 cancel 被提前返回吞掉（已静态复核修复）。**

- 原 control 在 recover → paused 后无条件返回，用户的取消意图被吞掉。
- 当前 `D:/OneDrive/Project Files/Pi/electron-agent/electron/app/nativeWikiController.ts:183-193` 只对 cancelled，或 paused 且 request.action=pause 提前返回；cancel 继续带新 revision 调用 native.control。`D:/OneDrive/Project Files/Pi/electron-agent/electron/wikiService/store.ts:76` 支持 paused → cancelled，消费与状态机已对齐。

最后还定向阅读了 registry / readonly shell、分页 native.list、撤权 pause / release、分支作者归档、持久 engine 引用和目录元数据，以及 accounting / executor_active / recoverable 的字段消费。初次 remember() 的 fingerprint(undefined) 已有明确字符串 fallback，不再在首次调用抛出 hash.update 参数错误。只读 shell 在 hydrate 的项目文件读取失败后使用已记录项目身份；App 保留该宿主项目对象，native 状态查询仍读取独立 SQLite，投影错误按状态返回。未在这些最新修改中发现新的确定阻断性 P1。

## 追加：任务详情 Native Wiki 投影窄审

按 Terra 交接，静态追踪 operationsContracts → job metadata parser → taskViewStore → TaskDetailDrawer，以及 native publication 的 model bridge / main / runtime 接线；为核对删除及详情来源，窄读 JobStore.remove / clear 和任务列表 provider。未运行任何检查。

**P2：删除已完成任务后，后续无模型投影修复无法完成任务摘要回报（已静态复核修复）。**

- `D:/OneDrive/Project Files/Pi/electron-agent/electron/agentData/jobStore.ts:28-35,161-164` 允许删除已完成 native agent_job，未清理或墓碑 `native_wiki_projection`。`taskViewStore.ts:156` 同样允许该任务 remove。
- 用户删除该历史任务后，`projection.repair` 仍需持久化 publication 摘要，再进行 ACK。`D:/OneDrive/Project Files/Pi/electron-agent/electron/agentData/nativeWikiProjection.ts:59-68` 中 apply 看到登记已存在且同 revision，不会重建任务；随后 `SELECT metadata ...` 返回空，读取 job.metadata 抛异常。
- 结果：正式文件即使已修好，任务摘要回报仍失败，相关 outbox 不能完成 ACK；旧登记也使后续重放持续失败。
- 已采用引用保护：`jobStore.ts:161-164` 检查所有 native_wiki_projection.task_id 引用，remove / clear 都在原事务内调用该检查并拒绝删除；批量遇引用失败沿现有 catch 回滚。`taskViewStore.ts:109,157` 按真实引用返回 remove=false / removeReason=native_referenced，JobsPanel 显示引用原因，runtime 单删返回 JOB_REFERENCED。已窄读上述修复，原先“agent_job 被删而 native 登记仍在”的受支持删除路径已阻断；后续 publication 不会因此读到缺失任务。不修改用户历史为伪成功，也不通过重建已删历史绕过问题。新增 fixture 未执行。

其余已读链路支持同 publication、同 operation revision 从 error 更新为 ready：publication() 使用 `>=` 接受相同 revision，并单调更新 updated_at；TaskDetailDrawer 在同 revision 时比较 updatedAt，独立选择新 native 摘要，展示 partial / published / readable / failed 与 projection，未把 completed 解释成完整覆盖。controller 在持久化摘要之后 ACK，投影失败事件保留未确认。未发现该窄范围的其他确定问题。

## 运行证据与未覆盖范围

- 实际 Pi SDK 请求协议、真实模型输出、进程/IPC 运行、SQLite 崩溃恢复、打包及 license 可见性均未运行验证；未知 SDK 适配未当成已证实 bug。
- 不因没有运行测试单独报 bug；需要用户人工执行的验收仍保持未执行。
- 本报告只修改自身证据文件；原 root-level evidence/native-static-review.md 已移动到本路径，没有移动其他证据。
