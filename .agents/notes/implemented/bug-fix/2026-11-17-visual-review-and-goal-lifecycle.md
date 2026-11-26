# Agent Note: 视觉评审脱离预览页面，Goal 生命周期与恢复提示保持一致

Status: implemented

## Problem

本次调查确认：视觉反馈依赖 iframe 确认而缺少打回闭环；普通 ask_user 默认不开放自定义；Goal 停止续跑未必写暂停、回合授权绑住数据 revision、达到上限后恢复沿用旧预算；详情草稿会随 revision 刷新；SDK 重试错误提示等整条回复结束才撤销。

补充调查确认压缩态在 shadow／恢复路径遗漏、单独压缩未被运行清单恢复，以及子代理缺注册行被误判中断；用量不刷新与压缩态丢失的因果仍待复现，因为已有独立 compaction_end 监听，但统计请求缺防乱序。自动压缩先 abort 后 start 导致错误闪现的机制有源码支持，尚未现场复现具体错误。用户已确认把这四项并入当前规划。

以上是规划阶段的源码证据，实施后的真实 SDK／Electron 定向夹具另见下文；不冒充用户现场或已部署程序复现。长对话写能力与外部审批问题仍由用户排除，后续再次出现再单独处理；本提案不修权限、沙箱或 watcher。

## Decision

具体契约只维护在 [OpenSpec 设计](../../../../openspec/changes/fix-visual-review-and-goal-lifecycle/design.md) 和相邻规格／任务中，本笔记记录边界与取舍，不复制完整设计。

- 视觉页只展示；评审通过／打回与方案、参数、补充走 ask_user。绑定不可复用的产出标识，新产出必须重新评审，取消不算通过。旧 read_visual_choice 只保留立即迁移失败的兼容壳。
- 新非封闭询问默认提供自定义，封闭题显式关闭；历史卡不套用新默认。
- Goal 以最终运行结果收口，最终失败暂停、disarm、冻结计时，暂时重试与压缩恢复不误暂停。持久化失败明确未保存并禁派发。
- revision 保留 CAS，另以条件版本、批次和回合身份校验授权；刷新不复活旧回合。新批次预算与累计轮次分别保存，只有人工重启已耗尽批次才重置预算。
- 运行中可按原会话刷新状态，迟到读取不覆盖新状态。Goal 编辑局部对齐现有视觉，草稿不被轮次刷新覆盖。
- 有效响应增量到达立即关闭旧异常浮层，内部重试执行仍由其真实生命周期收尾。
- 压缩是独立运行活动，跨会话不丢；重载从存活 host 恢复，host 退出不落盘重放旧 true。完成后按原会话和上下文版本重拉用量，拒绝旧响应覆盖；内部 abort 由可信压缩触发意图识别，不先报错再清。
- 子代理启动、等待首响应、状态待确认与明确终态分开；陈旧或截断列表的缺行不证明中断，单卡／组卡／详情复用同一语义，保留现有后台工作结算规则。

规划复核进一步锁定：工具资格必须来自不可变执行来源而不是当前 pending；人工重启不能依靠 session 级 humanMarks；状态水位覆盖 clear 墓碑与新目标；评审校验覆盖实时和恢复入口；恢复增量必须有可信尝试归属；Goal 编辑以实际提交的 operationId 回执而非 prompt accepted 确认。这些是实现时必须验证的契约，不代表现场迟到事件已复现。

## 落地与证据

本变更于 2026-11-17 经用户显式 apply 落地，并完成本需求定向验收。以下记录实际接缝与证据，仍有效旧决定保留并互链；不把本地夹具通过等同完整部署或全工程类型检查通过。

### Goal 数据兼容与批次

事件增加 `restart`，快照增加 `runNumber`、`runRoundsStarted`、`conditionRevision` 与结构化 `pauseReason`；`roundsStarted` 始终表示累计轮数。旧事件无字段时从第一批折叠，旧 round 的累计数投射为第一批预算，旧 edit 仅在条件实际变化时推进条件版本，旧数据不被改写。普通 pause/resume 不清预算；restart 才推进批次。暂停与恢复之间的时间不计入 ranMs。

已运行 TS 优先的 `goal/fold.test.ts`：14/14 通过（`goal-fold-source.log`）。`goal/status.test.ts goal/history.test.ts goal/prompt.test.ts goal/receipt.test.ts` 连同 fold：28/28 通过（`goal-status-compatibility.log`）。新续跑 details 保留批次/批次内轮次，旧 hidden 正文和卡片仍可读。默认测试会优先读被忽略的旧 JavaScript，处理边界单列在[源解析记录](2026-11-17-goal-test-source-resolution.md)，不能把这份临时验证配置当作产品构建修复。

### 授权与状态刷新

状态签发器使用 global Symbol 让动态扩展与宿主 import 共享 owner epoch 和单调 sequence。水位位于完整信封，clear 的 null 快照仍有序号，新 goalId 不重置会话水位；离线读取不创建 live owner 或推进序号，保持 disarmed。前端按原会话保留水位、退役 owner 与 mutation fence，旧读取不能复活 clear；只有权威补拉可确认新 owner。已通过 renderer 的 goalStore、goalStatus 和 GoalRoundPill 定向 15 项（`goal-renderer-status.log`），只读 `agent_get_goal` 定向 3 项（`goal-host-read.log`，其他 115 项因名称筛选未运行）。

可信控制服务按原 owner 串行处理 action，operationId、动作与规范化请求写进同一事件；同 ID 冷重放读取原提交而不重复 append，参数不同返回冲突。回执区分 committed/conflict/failed/unavailable，原提交快照与最新状态分列。`goal/control.test.ts` 3/3 通过（`goal-control.log`）。宿主 `goalControlHost.test.ts` 验证原后台会话写入、owner 重开丢回执重放、冲突、写盘失败及不可用；追加生产 `RpcPeer`／`createAgentPorts` 的结构化克隆回环，扣住实际提交后的 ack，再以同 operationId 取回原提交，未重复 append。回环与 renderer 水位／owner-loss 接线共 43/43 通过（`goal-final-host-renderer.log`），回执为 `goal-control-rpc-receipts.json`。这是生产路由组件的进程内 RPC 回环，不冒充独立 OS 进程或正在运行的桌面应用。全链路异常恢复和 UI 草稿验收分别记录，不将 prompt accepted 当提交。

### 恢复提示

`retrying.recovered` 只撤旧错误展示，重试执行元数据、停止与最终 auto_retry_end 收尾继续保留；有效恢复证据需匹配源边界签发的运行/尝试身份。首个正文、思考或工具调用不必等消息结束；空 start 不算恢复。最终 reducer／host／活动等定向 10 文件 238/238 通过（`worker-4-7-final-vitest.log`；早期旧解析失败日志仍保留，不作通过证据）；真实 SDK 通过受控 429 触发实际自动重试，源事件经过生产 binder→降级层保留原运行/尝试身份，1/1 通过（`worker-4-sdk-integration.log`）。真实 Electron `request-recovery-feedback` 在深浅主题验证首正文/思考/工具增量撤提示、旧尝试隔离、再次失败与恢复后取消能力，11/11 通过（`worker-4-ui-check.log`）。展示恢复不结束重试执行，不改变网络策略或用固定延时藏错。

### 压缩活动与上下文统计

回复与压缩分开建模，压缩先登记 preparing，再由 SDK start/end 推运行与终态；snapshot 携带原 sessionPath／sessionId、ownerEpoch／sequence、operationId 与 contextRevision。shadow、缓存与运行会话并集保存实际活动；恢复读取存活 host，不把 compacting=true 落盘重放。旧结束不能清新操作，暂不可读显示待确认，不以空清单猜结束。成功的上下文版本只在 SDK 已 append／刷新后推进；按原会话记录用量失效，组件请求再核对 owner、版本与 generation，压缩前旧响应不覆盖新值，失败不伪造 0 或保证用量一定下降。

对话内只用时间线分隔线展示压缩。准备和运行有中性的旋转图标，无法确认时保留说明但不旋转，成功后同位置留下「上下文已压缩」。保留输入区真实错误和停止入口；即使历史未到，已就绪的会话也能显示活动分隔线。输入区横幅在滚离底部时更显眼，但常态双显示重复占位，且把正常工作画成告警；滚看历史时保留原滚动位置，可回到底部看状态。

policy-auto 在 ctx.compact 前登记可信意图，所以可归属的内部 abort 不闪红；用户停止、准备失败和最终压缩失败仍真实显示。手动请求及取消在 await 前捕获原 targetSessionPath／operationId。会话操作租约仅允许已证明属于当前压缩的 owner，外部 exclusive／transfer 锁仍不可绕过。阈值、摘要以及手动／自动续跑策略不变，现行说明见 [会话活动](../../../../docs/session-activity.md)。

定向证据：10 文件 238/238（`worker-4-7-final-vitest.log`）、扩展活动／策略 12/12（`worker-7-extension-vitest.log`）、真实 SDK 跨帧来源 2/2（`worker-7-sdk-integration.log`）、snapshot／stats 15/15（`worker-7-snapshot-stats-vitest.log`）、原会话目标／租约 3/3（`worker-7-target-route-vitest.log`，118 项名称筛选未运行）。`session-compaction` 最终 44/44（`session-compaction-ui.log`）覆盖切换、真实用量 85%→12%、逐帧无内部 abort 红条和取消；补齐真实 webContents.reload 后只读运行清单恢复、保留活动起点且不重放 start，以及 B 前景时 A 后台完成、回 A 读 22%、压缩前迟到统计不覆盖。重载 fixture 的宿主快照用 localStorage 独立保存，renderer store 被实际销毁；这是只读宿主契约桩，不是产品磁盘 compacting=true 或实际独立 OS host 的存活证明。截图 `session-compaction-restored-after-reload.png`、`session-compaction-finished-light.png` 已保存。只点名本场景，未重跑已有 SDK 或其他 UI。所有通过数互有覆盖，不累加成独立总测试数。

单分隔线的展示回归：`npm run ui:check -- session-compaction` 53 项通过，验证单行、背景、旋转与减少动态效果、完成行位置和真实错误；`ChatListView.test.tsx`／`ChatView.test.tsx` 的两项定向测试通过。压缩活动的宿主契约未变。

### 原生问答与视觉

新请求边界默认允许自定义，显式 false 仍封闭，历史缺字段不加选项。每次发布使用新 previewId，ask_user 自动加入 approve/redo 的固定封闭评审题，普通问题与补充图片保持独立。共享 registry 同时约束 live 和历史 completeAskUser 的原 owner/previewId/requestId，并在新版本发布时失效旧等待；取消不批准。

定向证据：新问答 18 项及历史 13 项（`visual-questions-tests.log`、`visual-question-history-tests.log`）；产出版本与评审题 19 项（`visual-preview-tests.log`）；live 结算 6 项、历史结算 26 项（`visual-review-extension-tests.log`、`visual-review-restored-tests.log`）。旧 read_visual_choice 兼容壳立即迁移失败、不建立等待；旧哨兵仅定向取消，普通审批和真正 ask_user pending 保留，扩展 6 项、renderer 43 项通过（`visual-legacy-extension-tests.log`、`visual-legacy-renderer-tests.log`）。预览 frame 7/7 无跳过（`visual-preview-frame-tests.log`）；实际 show_visual→ask_user 连续打回→第二版→再次评审→通过的确定性循环与 registry 共 24/24 通过（`visual-review-loop-tests.log`）。历史答复在 appendMessage 成功后才结算，失败保持 pending 可重试，12/12 通过（`visual-review-commit-tests.log`）；已有 live registry 不被历史重放覆盖。真实 Electron `visual-panel` 19/19、`visual-review` 24/24，日志 `visual-panel-ui.log`、`visual-review-ui.log`，7 张截图在同证据目录 `screenshots/`。只跑这两个场景；旧页面无确认条，点击和旧消息不能批准，补充说明强制可选开放。真实 SDK 的 TS-only overlay 装载探针通过（`probe-real-sdk-overlay.log`），有旧 JS 的真实目录仍优先执行旧实现（`probe-jiti-source.log`）；这不是已运行应用热更新完成的证明。

### Goal 异常与运行授权

最终结果以可信 SDK 运行身份归属：agent_start 捕获工作，agent_end 收集该运行的最终响应，agent_settled 只消费对应结束记录，重复终态不借当前 pending 释放新占位。请求重试成功覆盖暂时失败；最终错误、用户停止、上限分别写有限 pauseReason。编辑立即撤旧工具授权但保留执行占位，旧 runner 只能释放自己的占位，为最新条件单次派发；direct 与 codemode 嵌套调用都在工具执行来源边界捕获不可变引用，humanMarks 不可借来完成失效条件或重启预算。异常摘要使用固定安全文案，不把原始响应、Bearer 或 URL token 写入 Goal 事件。

`goal-ts-suite.log` 记录阶段性显式 15 个 TS 文件 118/118 通过；裸目录命令会混入被忽略的旧 `.test.js`，其结果不可作为当前源码验收。最终真实 SDK 的 `goal-final-sdk.log` 13/13 通过，使用临时 TS-only overlay，完整 JSONL 与压缩事件序列在 `goal-sdk-event-sequences.json`。后续恢复边界另以六个明确文件验证，不将重叠测试数累加。主链覆盖最终请求失败→补拉→人工恢复→编辑→上限→新批次完成；用户停止后同批恢复不重置预算；真实自动压缩成功等待期间不增轮，实际提交后最多派一轮；最终压缩摘要不完整写 request-error 暂停。WorkspaceHandle 的配置准备与接受后 post-run 异常由原 owner/round fence 收口，旧 settled 后 catch 不影响新工作：`goal-host-failure.log` 11 项通过，35 项因名称筛选未运行。进程丢失只凭主进程内已确认的执行槽事实：新 owner 先 claim 并严格核对原会话／epoch／Goal／批次／条件版本，再由新 owner 写带 confirmedLoss 的 runtime-error 暂停并核对后 ACK；正常退出不产 loss，旧序号／旧 owner／旧 ACK 不影响新槽，失败显示不可用且禁续跑。首次 status 等到恢复结果，不提前显示 active。恢复／启动 37/37（`goal-owner-loss-recovery.log`）、相邻授权 19/19（`goal-owner-loss-adjacent.log`）、tracker 与 HostApi 回环 17/17（`goal-owner-loss-host-ipc.log`）、只读 3/3（`goal-owner-loss-readonly.log`，118 项因名称筛选未运行）。前端只按死 ownerEpoch 冻结，不混用执行槽 sequence 与 status sequence；43 项 renderer／host 测试包含旧 pull/push 拒绝和新 owner 持久暂停前不提前解冻。main 自身一同丢失、占用通知未到达都不是已确认事实，不据旧 JSONL 猜 crash。

最终复核补齐无 SDK settled 后的人工恢复：可信 host catch 只释放捕获的原 roundId；旧条件已被编辑而无需暂停时，释放后仍经现有屏障为最新条件最多派一轮，人工暂停和新 slot 优先。未持久暂停的可信 resume 先按 owner.stoppedAt 真正补写 pause，保留原原因且不计修复等待时间，再提交 resume；只有实际提交才清 unavailable。修复 pause 已写、resume 未写的同 operationId 重试在存活 owner 内沿 half-commit revision 继续，不重复 pause；冷态无此临时记录时保守要求重读 CAS，而不是猜已提交。成功 clear／create 清理旧 Goal 的故障投影但不释放执行槽，旧故障不污染新目标。

可信人工 resume 可记录服务签入的 supersedesConfirmedLoss，实际提交后才 ACK 重新 claim 的精确旧 fence；这代表当前用户控制取代旧丢失事实，不是旧 runner 获得新条件资格。ACK 丢失可从持久标签重证；claim 不可读、写入失败或缺乏证明均保留不可用。异步 claim 返回后再次检查 goalId／revision／conditionRevision，期间 edit 或 clear+create 直接冲突，不能借新状态提交。历史已提交的 loss pause 在后续合法编辑／恢复后仍按当时 fold 核验，不只看当前 revision。补充恢复六文件 81/81（`goal-owner-loss-resume-boundary.log`）、相关源码／测试定向 tsc 无诊断（`goal-owner-loss-resume-boundary-tsc.log`），最小实际事件为 `goal-recovery-events.json`。

另一次生产接线审查发现：hostEntry 把内部 workslot 也包进普通 broadcast，main 却监听外层内部频道，导致 tracker 永远收不到占用。修复让内部执行槽与诊断一样直发，由 main 消费且不转 renderer；普通事件继续原包装。补上经过生产 broadcaster 和 RpcPeer 的接线用例，不能再用直接 tracker.report 的旧回环声称通道已接通。`goal-owner-loss-broadcast.log` 记录两文件 19/19 通过（17 项既有＋2 项真实包装接线），确认内部通知不到 renderer，普通事件仍正常送达。这仍是同进程 RPC 回环，不冒充独立 OS host。

组合 SDK 验证最终 13/13（`goal-visual-compaction-sdk.log`），Goal TS-only 定向 118/118（`goal-ts-suite.log`）：同轮评审等待、打回后新 previewId 才能批准；等待中真实 SDK 压缩仅在成功后增一轮；人工暂停优先于迟到批准／完成；打回后的最终压缩失败写 request-error 而不续跑。完整结果保留在 `goal-sdk-event-sequences.json`。这不改变现有子代理 Bash 结算；其等待／超时断言仍在本次 subagent-detached 验证中保留。

### Goal 编辑与 UI

用户通过原生 ask_user 批准 `goal-editor-review-v1`，静态图／HTML 仅预览不收反馈；记录在 `goal-editor-review-v1.approval.json`，不是伪造的 visualReview registry 回执。Goal 条和详情共享 dirty 草稿、原会话/goalId/条件基线；只有匹配 operationId、owner、条件版本及实际 committed 快照才能退出，旧补拉、同文条件、prompt accepted 不清草稿。传输失败重试复用同 ID，冲突需显式载入最新版或基于最新版提交。ActionIcon 编辑／保存／取消统一尺寸，局部 focus/hover/disabled 沿主题 token，不改全局主题。写盘未保存以独立 unavailable 展示并冻结投影计时，不伪造持久 pause。现行使用说明见 [Goal 控制](../../../../docs/goal-controls.md)。

组件与回执定向验证见 `goal-editor-unit.log`（27/27 通过）；真实 Electron `goal-lifecycle` 32/32 与 `goal-round-card` 13/13，最终结果分别见 `goal-lifecycle-ui.log`、`goal-round-card-ui.log`，包含异常暂停、冻结、上限重启、草稿／延迟确认与深浅主题。后续冲突按钮样式修正仅复跑本场景，不扩展全量验收。

### 子代理启动显示

启动中、等待首响应、运行中、状态待确认及明确终态分开。缓存按 workspace、原父会话和稳定 agentId 隔离，查询带 generation、新鲜度与错误；缺行、SQL 错误与列表截断不证明中断。按 ID 的窄查询绕开默认列表窗口；无 ID 的子项只保留父调用/子位置，不靠同名任务文本猜身份。未确认查询共享自动退避，持续失联显示状态暂不可确认，后端恢复后自动对齐；不再要求用户人工重试，明确终态事实不被旧空查询或缓存释放降级。

首响应以子会话的实际正文、思考或工具活动为准，而不是等登记表的最终 `output`。运行器在现有进度帧里传递单调的 `responseStarted`；首次实质活动不受 transcript 的落盘节流限制，后续心跳不清该标记。登记查询只投射这个短字段，父卡无须打开右坞也能更新；单卡、组卡和两种详情沿用同一判定。普通启动和空助手帧不算首响应，无法确认当前状态时仍显示状态待确认。终态不依赖此标记，结算清掉临时位，会话跨项目迁移只搬运已结算行。

仅复用最终 `output` 最省字段，但只调用工具或持续思考时会一直误报等待；从 transcript 推断能识别先前活动，但会让常驻查询读取大字段，且尾部截掉首帧后可能倒退。短字段保留已观察到的事实，同时不增加查询频率或传输正文。

本组只改变观察证据和显示，不裁定真实执行结算，不修改后台 Bash 等待、超时或资源清理规则；与 subagent-settlement 继续分工。`subagentService.test.ts subagentUtils.test.ts subagentLiveStore.test.ts` 88/88 通过（`subagent-unit.log`）。真实 Electron `subagent-detached` 最终 39/39 通过，仅运行 1/60 场景；日志 `subagent-detached-ui.log`，截图 `subagent-detached-running.png`、`subagent-detached-finished.png`。该场景包含连续空/一次读取失败、单卡/组卡/dock、无 ID 与迟到记录，以及原后台 Bash 收尾断言；未跑全量。

## Historical decision audit

- [Goal 会话事件权威](../../implemented/architecture/2026-09-13-goal-as-session-events.md)：部分重叠。会话事件、单写者和人工暂停边界继续有效；不恢复旧 AgentData／独立裁判。
- [Goal 按路径补拉](../../implemented/bug-fix/2026-10-18-goal-bar-pull-hydration.md)：部分重叠。保留只读补拉；同 revision activation 后到覆盖先到的风险由本提案的 owner／序号与读取隔离处理。
- [视觉按会话归属](../../implemented/bug-fix/2026-10-16-visual-design-session-binding.md)：部分重叠。owner 保留；页面选择、补充和回写通道由本记录部分取代，不将整篇归档。
- [续跑卡片](../../implemented/feature/2026-10-18-goal-round-cards-and-silent-create.md)：部分重叠。旧 hidden 消息和历史可读性保留，新卡增加批次信息。
- [注意状态](../../implemented/feature/2026-10-19-session-attention-badges-and-notifications.md)：部分重叠。只撤去旧视觉 pending 来源；压缩纳入运行活动，普通询问和审批规则不变。
- [压缩与上下文策略](../../implemented/architecture/2026-09-30-compaction-and-context-policy.md)：部分重叠。阈值、摘要、手动及自动续跑策略不变，补活动显示／触发来源／统计刷新。
- [子代理后台命令收尾](../../implemented/bug-fix/2026-11-13-subagent-background-settlement.md)：相邻但不吸收。该修复处理回复后 Bash 等待与超时；当前新增启动阶段观察，保留已有未提交改动。现行 subagent-settlement 主规格已经完整读取，不改变其结算要求。
- proposed／rejected 同主题检索没有找到需要吸收的独立提案；AgentData 轻量化审查明确不重做 Goal，与本次局部修复无冲突。已有会话工作流与会话迁移 change 保持独立，不修改其文件。

上述仍有效记录均保留，只标明部分取代边界并互链；不归档、不改写旧理由，也不吸收会话迁移或后台 Bash 的独立工作。

## Alternatives considered

只在 iframe 增加打回按钮最容易兼容现有交互，但保留了用户明确要求退出的页面输入与悬挂通道，因此不采用。

仅提示模型记住 allowCustom=true 无须改变默认，却无法防遗漏；渲染所有旧卡时默认 true 又会改变历史，因此只在新请求规范化时应用。

删除回合授权或 CAS 可以快速解除 update_goal 报错，但会使旧工作完成新目标；直接清累计轮次能简单重跑，却破坏历史含义。因此分别保留数据版本、工作资格与运行批次。

在 agent_start 就撤错误提示最及时，但不能证明通信恢复；清掉整个 retrying 状态会丢执行事实。因此首有效内容只撤展示错误。

落盘 compacting=true 最容易保持显示，但宿主退出后会留下假运行；只在组件内显示也无法跨视图恢复，因此按存活 host 活动快照对账。仅再查一次列表能缓解注册延迟，却解决不了 50 行截断和读取失败；永远显示 running 又会掩盖真失败，因此保留自动退避恢复的状态待确认，明确终态仍依真实证据。

### apply 中修订的状态恢复决定

用户看到新增“状态待确认／重试”后指出裸按钮视觉失配，并进一步明确选择“自动恢复，移除卡片上的人工重试”。因此撤回原提案的有限确认次数耗尽后人工重试方案，改为共享查询自动退避、约束频率、不停止唯一观察路径；单卡／并行卡／详情均不放人工状态重试按钮。查询恢复自动对齐，明确终态及观察者释放停止无用查询，不改变子代理执行和后台 Bash 结算。

原方案最强理由是为长期故障提供确定的查询成本上界；放弃原因是把内部观测故障变成了用户操作任务，且可能让仍在执行的孩子失去自动观察。退避频率上限和共享调度保留资源边界，避免通过无限高频查询解决。DeepSeek 的只读样式审查确认裸按钮吃到浏览器默认样式，但用户随后选择删除该交互，因此不再实施仅美化按钮的替代方案。此前本组 85/85 与 UI 30/30 只对应修订前实现。最终自动恢复版 `subagent-unit.log` 88/88、`subagent-detached-ui.log` 39/39 通过，只运行 1/60 场景；新增已有 running 后失联、自动退避恢复、终态详情不倒退、按 ID 确认的第 51 行与列表去重，原后台 Bash 断言全部保留。最终截图为 `subagent-detached-running.png`、`subagent-detached-finished.png`，三处人工重试按钮均已移除。

## Consequences

原七项与新增四项各有定向失败／恢复验证：评审闭环、Goal 收口／授权／新批次、编辑草稿和首增量撤旧提示保持原要求；压缩切换和存活重载不丢、宿主退出不假运行、实际用量及时更新且旧回包不覆盖、自动压缩不闪内部错误；子代理首响应前不因缺行误报中断，真实失败仍可见。历史、原会话归属、人工暂停、压缩续跑及后台工作结算不被破坏，写能力问题不混入。

### 兼容成本与验证限制

新问答默认、Goal 新事件和视觉工具退出都有兼容成本；同一版本交付新旧读取、迟到结果隔离和取消清理。明确只承诺新程序读旧数据，不承诺旧程序理解新 restart。压缩活动与回复活动不能互相清除，旧空列表不能作为终态；不得覆盖相邻后台命令修复。无 UI、宿主状态不可确认或持久化失败不能伪装成功。

## 验证

本次使用 electron-ui-harness skill 跑原 `visual-panel`、`visual-review`、`goal-lifecycle`、`request-recovery-feedback`、`goal-round-card`，另新增并点名跑 `session-compaction`，只扩展并跑 `subagent-detached` 覆盖启动误判。七场景最终合计 182 项断言通过，使用真实鼠标键盘验证评审／编辑、压缩跨视图与用量、逐帧错误闪现以及子代理首响应前状态。项目无对应专用 verify skill，以真实 Electron harness 与 SDK 定向测试作为证据，不为此安装新技能。

Goal／压缩使用真实 SDK 的确定性传输夹具测重试、手动与自动压缩事件时序、编辑、上限和收口；renderer 重载使用独立宿主契约桩，宿主内部通知／claim／ACK 使用生产 RpcPeer 回环，不冒充 OS 进程实测。统计并发旧回包、子代理连续缺行／截断／重挂以定向测试覆盖。最终命令、日志、截图和未运行项统一在[验证汇总](../../../../.agents/evidence/2026-11-17-visual-review-and-goal-lifecycle/verification-summary.md)。跨工程 tsc 仍受既有错误阻断，不宣称全工程通过；相关 Goal 恢复文件的独立定向 tsc 已通过。早期错误解析／失败日志保留，不列作最终通过。

最终门禁 `pnpm run verify-notes` 与 `openspec validate fix-visual-review-and-goal-lifecycle --strict` 均通过，结果保存为证据目录中的 `final-notes-validation.log`、`final-spec-validation.log`；本次范围的 CRLF-aware whitespace 检查见 `diff-check-scoped.log`。默认全工作树检查仍含既有 dockStore 测试末尾空行，未为此修改独立任务。规划日志、早期失败和取消记录均保留，不充当最终通过证据。只验证本需求，不自动提交、推送、同步规格或归档。
