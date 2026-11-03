# Todo 状态完整性与一致性修复报告

已先排查再修复。截图对应的最后一次 todo 在 14:20:44 已成功提交三项 completed，但修复前读取到的 UI 历史缺少该调用，只保留两完成、一进行中的旧清单。不是没有调用完成更新。源结果位置与调用 ID 见 [observed-case.json](observed-case.json)。没有现场完整 IPC 帧日志，不能确定具体哪一帧当时没有到达；下面的缺口均由代码及可复现测试确认。

Todo 的完整替换接口、三种状态含义、已有别名、ID 分配规则和交互方式保持。没有增加逐项合并、revision、外部工具到 todo 的任务绑定。

## 所有写入与生命周期入口

| 入口 | 核对结果 |
| --- | --- |
| 创建、增项、改文案、改状态、删项、清空 | 统一走 extensions/todo/todo.ts 的 applyTodo 全表替换，没有独立 CRUD 写入分支；全表先校验，失败保留旧内存状态。补上执行前取消检查。 |
| 实时工具开始、进度、结果、持久化结果消息 | 补齐缺失开始卡的结果接纳、终态保护及成功标记更新。 |
| agent_end / agent_settled | 用完整结果补回 todo；缺少 agent_end 时从已有最终消息重建收尾。 |
| 后端快照、较长 UI 历史、缓存命中 | 对齐 todo 的源结果，签名感知内容；同签名也更新派生标记。 |
| 切换、后台唤起、partial shadow 补历史 | 恢复既有完成标记；补历史后按合并消息重新派生。 |
| 回退、删除消息、编辑重发、重新生成 | 沿用 truncateTo/applyCutToUi 入口，重算保留消息的派生状态；磁盘已截断但快照失败时明确提示，不沿用旧收尾标记。 |
| session_start / session_tree / context | 恢复与上下文使用同一已有收尾规则，context 同步扩展内存。SDK fork 是 session_start(reason=fork)，已有钩子覆盖；没有新增 session_fork。 |
| UI 历史 read/write/delete | 全部复用既有同路径队列，避免读取抢在写入前、删除后被旧写入复活。 |
| 显式完成、正常 stop 收尾、下一用户轮 | 维持既有规则；已确认收尾的成功快照不会因后台通知续跑再次亮成进行中，新调用的乐观参数不会继承旧完成状态。 |

## 遗漏点、触发场景、处理与影响

以下行号对应修复后的入口，便于在当前工作区核对。

| 优先级 | 位置 | 触发场景与影响 | 处理及影响面 |
| --- | --- | --- | --- |
| P0 | electron-agent/src/stores/agentReducer.ts:588、1156 | 开始事件缺失，end/toolResult 找不到卡，成功结果被丢掉 | todo 结果按 toolCallId 补建；只补 todo，其他工具不改变接纳规则 |
| P0 | 同文件 :849、892 | 最后一次 todo 没进入实时列表，完整 agent_end 不补结果；缺少 agent_end 时 settled 不补收尾 | 用完整源结果校准 todo；已有最终消息可重建收尾。影响主会话及共用 reducer 的详情 |
| P1 | 同文件 :1147 | 已终态调用再收到旧 partial，结果退回旧清单 | todo 终态拒绝迟到进度；其他工具原进度逻辑保持 |
| P1 | electron-agent/src/stores/sessionMessageSync.ts:34 | 缺少开始帧且回执乱序，旧调用被追加到新清单后面 | 完整源序列到达后按身份和相邻锚点校正顺序；影响 todo 的快照补齐 |
| P0 | electron-agent/src/stores/sessionSnapshot.ts:17 | 较长 UI 历史优先时，后端最终完成/清空被旧列表遮住 | 保留完整历史，同时对齐后端 todo。调用方为主 store、后台补读和子代理详情种子 |
| P1 | electron-agent/src/lib/sessionMessageCache.ts:24 | 消息数和末条摘要相同，todo 文案/状态改变却命中旧签名 | 签名加入最新成功 todo 内容；影响会话缓存与后台刷新，不全面改写其他消息签名 |
| P1 | electron-agent/src/stores/agent.ts:300、411、514、524、822 | 缓存秒显、后台唤起、partial shadow 填充或同签名加载时派生标记丢失/滞留 | 按保留消息重建既有标记。UI 投影保留 SDK 已有可选 stopReason 元数据，旧数据仍兼容 |
| P1 | 同文件 :665、672 | 截断移除了终态却沿用旧完成标记；磁盘成功、快照失败仍静默保留旧标记 | 成功截断后重新派生；快照失败清除旧收尾判定并显示同步失败，保留最后已知消息供重新载入 |
| P1 | electron-agent/src/features/chat/input/latestTodos.ts:65 | 已经正常收尾的尾项，在不产生新 todo 的后台通知续跑中重新亮成进行中 | 对已提交成功快照保留既有收尾；运行中的新参数不继承旧完成标记 |
| P1 | extensions/todo/index.ts:22、todo.ts:90 | context 只改发给模型的副本，内存/分支恢复仍读旧状态 | 同一既有收尾规则用于恢复和 context 内存；原始工具结果不伪造改写 |
| P2 | extensions/todo/todo.ts:124、161 | 大小写工具名扫描不一致；字符串正文或首项非 text 时计数未更新 | 统一识别并更新实际计数文本；仅影响恢复/派生上下文 |
| P1 | extensions/todo/index.ts:43 | 信号已取消仍执行清空或替换 | 提交前拒绝；同步提交期间无 await，不存在执行到一半再插入取消事件的窗口 |
| P1 | electron-agent/electron/app/uiHistoryService.ts:10、28、49 | 读/删没进入写队列，可能读取旧值，或删掉历史后被先前在途写复活 | read/write/delete 共用已有 pendingWrites 队列。影响全部 UI 历史 IPC 调用方，读取可能等待已接纳操作；没有增加锁或持久化协议 |

## 可保证的可靠性与调用约束

单个 todo 更新先校验整表，再同步替换内存；失败或执行前取消不会留下半份列表。快速连续操作及同帧事件按已有 stream 批处理更新，完整源结果按调用身份补齐，重复回执不会新增同一调用。终态之后的进度不回退结果。

全表并发仍是最后实际写者胜，测试验证了 20 次并发提交与单调 ID 分配。它不能自动合并两份基于旧快照的独立编辑；调用方若需要保留各自修改，应串行提交最新完整清单。新增 revision/CAS 或逐项合并会改变约定，未纳入本次。

UI 历史队列保证同一服务实例、同一路径解析后的入队顺序。需要严格“操作一完成再操作二”的业务链应 await 前一步；不宣称跨独立进程事务。写失败会返回调用方，队列继续允许后续恢复；原子临时文件/rename 行为保留。

Todo 与 bash、子代理等工具没有任务绑定关系，外部工具完成不等于任一 todo 已完成。本次没有通过文字或工具名猜状态；保留现有正常 stop 且无 pending 的收尾规则。

## 验证结果与复现命令

| 验证 | 结果与证据 |
| --- | --- |
| 修复前核心回归 | 前端 9 项失败：[renderer-red.txt](renderer-red.txt)；扩展 5 项失败：[extension-red.txt](extension-red.txt) |
| 额外边界红灯 | 乱序 [order-red.txt](order-red.txt)、后台/截断 [recovery-edge-red.txt](recovery-edge-red.txt)、续跑展示 [settled-display-red.txt](settled-display-red.txt)、持久化竞态 [persistence-red.txt](persistence-red.txt)，均在各自修复前失败 |
| 前端相关完整回归 | 10 文件、214 项通过：[renderer-green.txt](renderer-green.txt) |
| 最后边界修复后复验 | 5 个直接相关文件、181 项通过：[targeted-final.txt](targeted-final.txt)；记录与前一行有重叠，不相加 |
| 扩展、共享 todo 模型、工具元数据 | 4 文件、41 项通过：[extension-green.txt](extension-green.txt) |
| UI 历史队列 | 2 文件、10 项通过：[persistence-green.txt](persistence-green.txt)，包含真实临时目录及确定性 I/O 屏障竞态 |
| 真实 Electron UI | todo-consistency 35 条断言通过：[ui-todo-verified.txt](ui-todo-verified.txt)，[截图](todo-completed-light.png)；只跑本次 1/37 场景，其余 36 个未运行 |
| 定向 TypeScript | 改动数据层、UI 场景、扩展和历史队列，退出 0：[配置](tsconfig.check.json)、[编译输出](typecheck-final.txt) |

从仓库根目录执行：

```bash
cd electron-agent
npx vitest run src/stores/todoConsistency.test.ts src/stores/agent.test.ts src/stores/agentReducer.test.ts src/features/chat/input/latestTodos.test.ts src/features/chat/input/TodoDock.test.tsx
npx vitest run electron/app/uiHistoryService.test.ts electron/app/uiHistoryService.ordering.test.ts
npm run ui:check -- todo-consistency
npx tsc -p ../.agents/evidence/2026-10-28-todo-state-consistency/tsconfig.check.json
```

扩展与笔记检查：

```bash
cd extensions
npx vitest run todo _shared/todo-model.test.ts prompt-metadata.test.ts
```

仓库根目录 `npm run verify-notes` 的记录为 [verify-notes.txt](verify-notes.txt)。

## 未覆盖及不确定项

- 没有现场完整 IPC 回放，所以没有认定具体网络/桥接层丢了哪一帧；修复覆盖可复现的接纳与恢复缺口。
- 所有权威结果都缺失、SDK 提交前进程崩溃、或快照一直读取失败时，不能证明新状态。截断恢复失败会明确提示，人工步骤是恢复读取条件后重新打开会话，再核对最后成功 todo；保留最后已知快照不等于声称已同步。
- 没有进行整机崩溃、跨独立进程同时写同一历史文件的压测；未增加跨进程锁。
- SDK 生命周期顺序和可识别的 toolCallId 仍是既有约束。缺少开始帧并乱序时，在完整权威序列到达前不能推断正确顺序；无身份/无时间戳的损坏旧历史无法保证精确插入位置。
- UI 检查使用真实组件/store/事件批处理，后端桥和 I/O 故障由确定性桩控制；不是完整生产窗口的网络断连测试。没有跑无关全量项目测试。
