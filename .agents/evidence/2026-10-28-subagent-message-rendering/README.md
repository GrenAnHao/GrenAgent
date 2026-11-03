# 子代理通信与后台结算渲染：验证记录

最终展示遵循用户补充要求：子代理启动卡保持既有默认；通信默认展开、可收起；后台结算默认收起为紧凑单行，展开后读结果。运行、生产者协议和调度未修改。

## 展示与信息来源

| 主线 | 原展示 | 最终展示 | 信息来源 |
| --- | --- | --- | --- |
| send_message 发送 | 通用工具行和投递回执，参数中的正文不可直接读 | 双方、完整 Markdown 正文、投递状态与已有时间默认展开，支持收起；请求唤醒策略与实际回执分开 | args.agent_id/message/wake；result.content 和 details.woken/delivery/reason；startedAt/durationMs |
| 接收到的代理通信 | 静默消息默认折叠为提示条，唤醒消息混入普通 user 路径 | 两类通信使用同一语义卡，正文可读、双方明确、可折叠；处在原有会话顺序中 | details.from 或现有固定消息信封；原消息 timestamp；子代理详情的 agentId |
| 子代理启动与普通中间/最终输出 | 既有启动卡与完整对话入口 | 保持既有默认，不额外外铺任务或输出；完整子代理对话继续使用真实消息时间线 | 既有 spawn 工具结果与子会话消息，不新增进度读取 |
| 子代理结算 | 通用折叠提示条 | 紧凑终态行；展开显示收尾正文、已有部分输出与独立诊断，区分完成、失败、中止、超时、token 上限、拒绝、未知 | subagent-settled 的 details.childId/stopReason；content 中的收尾正文与官方追加 Diagnostic |
| 后台 bash 结算 | 一行任务加模型专用状态/读取指令 | 默认 26px 折叠行，身份、终态、简短任务描述和可得耗时/时间；非零退出明确写失败和退出码；展开才显示输出、必要原因和一句缺口 | job-done 的 jobId/kind/status 与原通知原因；同一展示会话 bash 结果的 jobStartedAt；只读 job_snapshot |

Job 快照读取不调用、也不消耗 job_output。MessageTimelineContext 提供实际展示的会话，子代理不会借父会话记录匹配任务。任务开始结果迟到时通过订阅或时间线更新补齐；迟到的 running 快照不把已结算卡退回运行。

## 边界与真实限制

- 长通信和收尾正文完整保留，限高滚动，支持折叠/展开；空正文保留已有身份、状态并说明未附正文，不生成空白 Markdown 块。
- start/end 重放去重；同文独立发送保留；同一发送者同毫秒的不同正文分别保留；生命周期通知原位更新，迟到 start 不覆盖 end。
- 快照与实时尾巴逐项配对，修复一份快照吞掉第二次同文发送的问题。缺少稳定实时消息 ID 时，完全同文同毫秒的独立消息仍无法可靠区分。
- codemode 历史只保留最多 200 字的参数预览，无法从展示层恢复已被上游截短的正文；卡片明确标出预览限制和回执未保存。超过六条调用时通信也保持可见。
- 主会话旧记录不提供精确当前代理 ID 时，标为“当前会话代理”；子代理详情使用已有 agentId，不猜测父子身份。
- bash 通知本身不带输出和耗时。原启动凭据缺失、快照已清理时，只能展示原通知事实；没有补造结果或耗时。输出尾部丢失时显示缺口，不把它说成“没有输出”。
- 没有独立 timeout 字段，只识别终止原因中的明确超时措辞；诊断中的 timeout.test.ts 文件名不判为任务超时。completed 收尾正文引用 Diagnostic: 不会被拆成错误诊断。

## 实跑结果

结果：专项单测与本需求三个真实 Electron UI 场景通过。未运行全部 UI 场景或全项目测试。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 11 个通信/终态/投影相关 vitest 文件 | 208 passed | final-tests.txt |
| 追加超时文件名负例后，4 个终态相关 vitest 文件复验 | 60 passed | final-lifecycle-tests.txt |
| 区分最终回复与会话中止后的 2 文件复验 | 37 passed | completion-status-tests.txt |
| agent-message | 36 passed | final-ui.txt |
| task-notices | 37 passed，单独复跑通过 | ui-task-notices.txt |
| subagent-conversation | 41 passed | final-ui.txt |
| 定向 renderer tsc | 退出码 1，两个既有错误，见下文 | renderer-types.txt |
| npm run verify-notes | 最终结果见 notes-check.txt | notes-check.txt |

最终专项单测命令：

```sh
cd electron-agent
npx vitest run src/features/chat/AgentMessagePill.test.tsx src/features/chat/agentCommunicationModel.test.ts src/features/chat/JobDonePill.test.tsx src/features/chat/JobDonePill.guard.test.tsx src/features/chat/SubagentSettledPill.test.tsx src/features/chat/taskNoticeModel.test.ts src/features/chat/ChatMessageItems.test.tsx src/features/tools/codemodeModel.test.ts src/stores/agentNoticeProjection.test.ts src/stores/agentReducer.test.ts src/stores/sessionMessageSync.test.ts
npx vitest run src/features/chat/taskNoticeModel.test.ts src/features/chat/JobDonePill.test.tsx src/features/chat/JobDonePill.guard.test.tsx src/features/chat/SubagentSettledPill.test.tsx
npm run ui:check -- agent-message task-notices subagent-conversation
npm run ui:check -- task-notices
npx tsc -p ../.agents/evidence/2026-10-28-subagent-message-rendering/renderer-types.config.json --noEmit
```

`final-ui.txt` 保留首轮终态场景测量断言失败：probe 把矩形 h 误写成 height，随后又与耗时格式收敛发生交叉。测量断言修正，耗时最终沿用既有 bash 格式，单独复跑通过；随后按用户提供的真实记录新增会话状态与保留回复的两项断言，最终 37 项通过。通信与子代理详情场景在同次运行分别为 36/41 项通过。

定向 tsc 的两个既有错误：`messageActions/types.ts:2` 的相对导入缺失；`StreamingCodeView.tsx:81` 的 Shiki 主题类型不匹配。这两处未在本次修改；不能将根 tsconfig 的空 files 检查解释为渲染层类型检查通过。可复现配置保存在 renderer-types.config.json。

主代理已复核参与方、投递事实、历史预览限制、只读快照、空记录和终态不倒退等路径。独立审查代理未返回结论，已停止；不把未完成的独立审查当作通过证据。

## 修改前的失败证据

- AgentMessagePill：1 passed / 1 failed，只有折叠标题而没有接收方与可见正文（bash-537）。
- agentNoticeProjection：1 passed / 4 failed，复现 metadata 丢失、空终态丢弃、重复帧和不同任务同文被吞（bash-561）。
- snapshot-overlap-red.txt：7 passed / 1 failed，复现快照一条、实时两条却合并成一条；修复后 projection-tests.txt 为 3 文件 22 项通过。
- timeout-filename-red.txt：1 failed / 27 skipped，复现诊断引用文件名被误标超时；修复后 final-lifecycle-tests.txt 的 60 项通过。

截图在 shots/：通信默认展开、收起、子代理真实对话、超长窄屏，以及后台任务默认收起、失败展开、浅色窄屏。三个相关 UI 场景最终共 114 项通过。

用户追问的 `sa-1d7293f9` 已对照真实 JSONL，见 status-origin.md：15:50:40 助手 stop，15:55:40 会话 tornDown，随后结算为 aborted。当前 UI 明确写“会话已中止”和“已保留的回复”，不把会话中止误当作任务没有产出，也不擅自改写 completed。没有修改运行逻辑或会话原文件。
