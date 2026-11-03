# Agent Note: 待办状态在结果补齐与会话恢复时保持一致

Status: implemented

## Problem

2026-10-28 现场主会话的 todo 在 14:20:44 成功提交三项 completed，但 UI 历史缺少该调用，仍保留两完成、一进行中快照，与用户截图一致。修复前观察记录在 `.agents/evidence/2026-10-28-todo-state-consistency/observed-case.json`。可以确认源结果与 UI 历史分歧；没有完整 IPC 帧记录，不能把现场归因到某一条具体丢帧。

遗漏包含：没有 start 时结果被丢弃；回合完整结果不补 todo；终态被迟到进度覆盖；较长 UI 历史遮住后端成功；缓存签名不感知 todo 内容；缓存、后台、同签名重载、历史垫底及截断后的派生标记滞留；context 与内存/恢复规则不一致；取消前未设闸；UI 历史读/删未进入已有写队列，删除后可能被旧写入复活。

## Decision

沿用工具结果、reducer、snapshot、sessionSignature、扩展重建和 UI 历史队列，不新增 todo 字段、状态值、版本协议或 UI 操作。

- `reconcileTodoResults` 只处理 todo，按 toolCallId 对齐；缺失时按后端相邻消息锚点插入，完整源序列可修正缺失开始帧加乱序回执。结果事件、agent_end 与 snapshot 共用它。其他工具合并规则保持原有行为。
- 已完成 todo 调用不接纳迟到进度帧。成功/失败检查同时尊重 isError、details.error 和共享 normalizeTodos；明确完成或清空及时更新既有完成标记，失败不抹掉上一成功清单。
- 缓存签名保留原末条摘要，另加入最新成功 todo 的内容。相同签名也刷新停止原因/完成标记；缓存、后台 bootstrap/补历史、历史垫底、截断按保留消息重建派生状态。
- UI 投影保留 SDK 已有的 assistant.stopReason 可选元数据，供缓存/截断重建；不增加 todo 数据字段，旧 UI 历史缺字段时仍可读，后端加载负责补齐。
- agent_settled 在 agent_end 缺失时按最终消息兜底。已确认收尾的成功快照在后台通知续跑时保持完成；新调用的乐观参数不继承旧完成标记。原始工具结果不被改写成伪造成功。
- 扩展 reconstruct 与 context 复用同一既有收尾规则，context 同步内存；统一大小写工具名和计数文本更新。执行前已取消时拒绝提交；同步 apply 的原子性保持。
- `UiHistoryService` 的 read/write/delete 共用原 pendingWrites 队列，按同一路径的接纳顺序串行，防止旧写入越过删除、读取越过在途写入；原操作错误继续返回调用方，队列失败不阻塞后续恢复。

## Shared callers

`_shared/todo-model` 的字段与接口未变，仍供 todo 扩展、reducer/store、latestTodos、ToolExecution、TodoDock 使用。sessionMessageSync/snapshot 供主会话、后台补历史和子代理详情种子使用；新增校准仅作用 todo。sessionMessageCache/agent 的调用方包含会话切换、回退、截断和后台 shadow。UiHistoryService 由 ui_history_read/write/delete 三个 IPC 命令共用，影响所有 UI 完整历史保存、恢复和删除；读取现在会等待同路径已接纳操作，可能增加等待时间。

旧笔记审计：[工具终态补读](2026-10-19-parallel-tool-settled-reverts-on-reseed.md)、[重启残留工具卡](2026-10-18-stale-running-tool-after-kill.md)、[回退会话文件](2026-10-18-rewind-reloads-session-file.md) 部分重叠，原有约束保留，不归档。SDK 1.3 的 fork 经 session_start(reason=fork) 已覆盖；每个会话调用新的扩展 factory，因此未添加不存在的 session_fork 钩子或额外会话分片。

## Alternatives considered

- agent_settled 一律把全部 todo 标 completed：能隐藏尾项，但会把失败/中断/仍待办任务写成成功，改变含义，不采用。
- 带 revision 的逐项更新：能检测并发整表冲突，但改变数据模型与对外契约；本次保留完整快照最后写者胜，不合并两份旧快照。
- 全面重写所有工具的快照与签名：覆盖面更广，但影响全部消息和性能，故只增加 todo 敏感性和校准。
- 删除历史后再补一次 rm：代码少，但仍可能被尚未结束的写入再次覆盖；复用已有按路径队列才能建立确定顺序。

## Consequences

创建、替换、改文案、改状态、删除项和清空仍走完整清单写入，三种状态及别名兼容保持。正常 stop 且无 pending 的既有收尾规则保留；它不构成外部工作真实性的证明，不新增 bash/子代理结果到 todo 的自动绑定。

在一个扩展实例内，同步 apply 无 await 窗口，单次校验与内存替换原子；整表并发依然最后写者胜，独立修改应串行提交最新完整快照。结果乱序缺少开始帧时，权威序列到达前无法从任意回执猜测顺序；到达后按调用身份和锚点校正。UI 历史 FIFO 只约束同一服务实例、同一路径解析后的入队顺序，不宣称跨独立进程事务。

磁盘已截断但快照读取失败时，不沿用旧收尾标记，明确提示重新打开会话，保留最后已知消息供恢复；不能宣称此时已与磁盘完全同步。所有权威数据都不可得，或 SDK 提交前进程崩溃时，不能推断成功。旧历史没有停止元数据时也不能凭文字猜完成。

## 验证

证据目录：`.agents/evidence/2026-10-28-todo-state-consistency/`。

- 修复前：renderer-red.txt 9 项预期失败；extension-red.txt 5 项预期失败；order-red.txt 1 项；recovery-edge-red.txt 2 项；settled-display-red.txt 1 项；persistence-red.txt 2 项。renderer-green-initial.txt 还记录了缺失 agent_end 的 settled 回归失败，随后修复。
- 前端完整相关回归：10 文件 214 项通过（renderer-green.txt）；补充最后恢复/展示边界后，5 个直接相关文件 181 项复验通过（targeted-final.txt），agent 单文件 56 项通过（recovery-final.txt）。这些记录有重叠，不相加为独立用例总数。
- 扩展：`cd extensions && npx vitest run todo _shared/todo-model.test.ts prompt-metadata.test.ts`，4 文件 41 项通过（extension-green.txt）。包括 20 次并发全表写、取消、不合法输入和 context/恢复一致性。
- 主进程：`cd electron-agent && npx vitest run electron/app/uiHistoryService.test.ts electron/app/uiHistoryService.ordering.test.ts`，2 文件 10 项通过（persistence-green.txt）。旧测试走真实临时目录，新测试只把文件 I/O 换为带确定性屏障的内存盘，验证读/删不能越过在途写。
- electron-ui-harness 技能：`cd electron-agent && npm run ui:check -- todo-consistency`，真实 store/批处理/reducer/TodoDockFromStore，35 项全部通过（ui-todo-verified.txt），截图 todo-completed-light.png。只跑本次场景 1/37，其余 36 个未运行。
- 定向 TypeScript 检查覆盖改动数据层、UI 场景、扩展及历史队列，退出 0（typecheck-final.txt）。
- 最后运行 npm run verify-notes，结果在 verify-notes.txt。
