# Agent Note: 子代理首响应以运行期短字段为准，不再等最终 output

Status: implemented

相邻分工：[子代理启动显示](../../implemented/bug-fix/2026-11-17-visual-review-and-goal-lifecycle.md)负责启动中 / 等待首响应 / 状态待确认 / 明确终态的边界，[后台命令结算](../../implemented/bug-fix/2026-11-13-subagent-background-settlement.md)负责回复后的 Bash 等待与超时。本篇只补「首响应的证据来源」，不改结算、调度、超时或预算。

## Problem

2026-11-20 现场：子代理 #240 已经把几十个工具调用跑完（右坞有完整过程），左侧内联卡与右坞底部仍显示「等待首响应… 47秒」，并持续累加。

根因是「是否已响应」只在读登记行的**最终** `output`：

- `SubAgentInline.tsx`、`SubAgentGroupInline.tsx`、`SubAgentBody.tsx` 传 `hasResponse: Boolean(row?.output)`；
- `SubAgentLogBody.tsx` 判断 `!liveItem?.output`；
- `subagentUtils.ts` 的 `subAgentStartupPhase` 收尾是 `hasResponse || registry?.output ? 'running' : 'awaiting-first-response'`。

而 `registry.progress()` 运行期只写 `transcript` / `updatedAt`，`output` 只在 `finish()` 才落库。于是只要孩子没结束，`output` 恒为 null，任何视图都停在「等待首响应」，与它实际干了多少活无关。

11-17 的笔记在「子代理启动显示」一节已经写明契约：「首响应以子会话的实际正文、思考或工具活动为准，而不是等登记表的最终 `output`。运行器在现有进度帧里传递单调的 `responseStarted`」。但代码里 `grep responseStarted` 为 0 处，`AgentUpdate` 也没有这个字段——第 8 组只落地了「缺行不误判中断」，首响应证据这一半没接上。

## Decision

在既有进度帧上补一个单调的 `responseStarted`，贯穿「运行器 → 进度帧 → 登记库 → 查询投射 → 四处视图」：

1. **判定**：`runner.ts` 新增 `startsSubagentResponse(event)`——`tool_execution_start`，或 `message_update` 里的 `text_start/text_delta/thinking_start/thinking_delta/toolcall_start/toolcall_delta/toolcall_end`。空启动帧（`message_start`、无内容的收尾）**不**算首响应。
2. **运行器**：`embedded-runner.ts` 的会话监听里，第一次命中即把 `responseStarted` 置 true 并保持；首个实质活动同时清掉流式节流（`lastEmitAt = 0`、丢弃待发定时器），让父卡在一个节流窗口内就能看到，而不必等 150ms 甚至等最终 `output`。之后的心跳帧照旧带 `responseStarted: true`。
3. **落盘**：登记库新增 `responseStarted INTEGER NOT NULL DEFAULT 0`。`markResponseStarted(id)` 只写一次 0→1，且**不受** `progress()` 的 `PROGRESS_PERSIST_MS` 节流影响——否则首帧之后最多 1 秒内的活动会被节流跳过，恰好把首响应证据也一起吞掉。写入带 `status='running'` 守卫，`finish()` 之后是空操作。
4. **清位**：`finish()` 统一把 `responseStarted` 清回 0。终态显示本来就不看它；同一行被续聊重新打开（`finish` 写回 `running`）时，新一轮还没有活动，应当重新等待证据，而不是继承上一轮的标记。
5. **投射**：`SubagentService` 的 `list` / `lookup` 都投射该字段，旧库缺列时按 0 处理，不抛错、不误判已响应。
6. **判定收敛**：`subagentUtils.ts` 新增 `subAgentHasResponded(row)`（`output || responseStarted > 0`），`subAgentStartupPhase` 只认它；单卡、组卡、`SubAgentBody`、`SubAgentLogBody` 四处入口都改调它，不再各写一遍 `Boolean(output)`。
7. **回放兜底**：`SubAgentConversation` 已经回放出 assistant / tool 时，本身就是更强的首响应证据。即使登记行的标记还没轮到下一轮查询，也不得继续画「等待首响应」。

## Consequences

- 孩子一开始干活，「等待首响应」在一个节流窗口内变成「正在处理…」；不再与跑了多少个工具调用脱节。
- 终态、取消、中断、状态待确认、后台 Bash 等待 / 超时、结算与调度全部不变——新增字段只在 `running` 期间参与显示。
- 代价：登记库多一列、旧库要补列（沿用 `registry-schema.ts` 的 `ALTER TABLE` 迁移路径），进度帧多一个布尔字段。`markResponseStarted` 每帧被调用但只在首次真正 UPDATE，之后走内存集合短路，不增加逐帧写库。
- 已结算的行不携带该事实：迁移只搬运已结算行，标记随之归零；这不影响显示，因为终态不读它。
- 历史卡缺字段时仍走 `subagent_lookup` 补查一次；本条与「不许凭同名任务猜身份」的规则一致，未引入新猜测。

## Alternatives considered

- **让 `progress()` 顺带写 `output`**：能复用现有字段，但 `output` 是「最终答复」，运行期写入会让 `subAgentFinalText`、跟进合并与结算对比读到半成品，破坏「终态才有最终文本」的既有语义。
- **从 transcript 里推断已有活动**：不需要新列，但常驻查询要读最多 64KB 的 TEXT，正是登记库当初把 transcript 从列表查询里摘掉要避免的开销；且尾部截断后首帧可能已滚出窗口，判定会倒退。
- **前端按运行时长推断「应该开始了」**：不需要后端改动，但这是拿墙钟猜状态，与 11-17 明确否掉的「不依靠任意时间延迟判定」冲突。
- **只在 `SubAgentConversation` 用回放内容兜底**：改动最小，但内联卡与组卡没有回放上下文，截图里的错误仍在，治不了本。

## Verification

`npm run ui:check -- subagent-detached` 41/41 通过（新增「登记行刚有首个实质活动（output 仍为空）：不再等待首响应」「同一次查询里已完成的那项仍按终态显示」两项），日志 [subagent-detached-ui.log](../../../evidence/2026-11-20-subagent-first-response-flag/subagent-detached-ui.log)；`npm run ui:check -- subagent-conversation` 41/41 通过，日志 [subagent-conversation-ui.log](../../../evidence/2026-11-20-subagent-first-response-flag/subagent-conversation-ui.log)。

定向 Vitest：扩展 `registry.test.ts embedded-runner.run.test.ts worker-session.test.ts index.test.ts activation.test.ts session-project-transfer.test.ts` 267/267 通过（含新增的「首个实质活动才算首响应、空启动帧不算」「`markResponseStarted` 不被 progress 节流、结算后空操作、续聊重开清位、旧库补列」），日志 [extension-vitest.log](../../../evidence/2026-11-20-subagent-first-response-flag/extension-vitest.log)；`subagentService.test.ts` 20/20 通过（含新增「运行中无 output 但有标记 → 已响应」「旧库缺列按 0 不报错」），日志 [subagent-service-vitest.log](../../../evidence/2026-11-20-subagent-first-response-flag/subagent-service-vitest.log)；渲染层 `subagentUtils.test.ts SubAgentBody.test.tsx subagentLiveStore.test.ts` 83/83 通过，日志 [renderer-vitest.log](../../../evidence/2026-11-20-subagent-first-response-flag/renderer-vitest.log)。

同一批验证顺带修好两个已失效的既有场景契约（都在我改到的文件链上）：`subagent-history` 的桩只实现 `subagent_list`，而历史卡已改走 `subagent_lookup`，补齐后前 30 项断言全部 PASS；该场景末尾的 120s 超时在我改动之前就存在（`stream-cards` 的第二次推进后无收尾），未在本篇范围内修。`subagent-conversation` 的 `SubAgentBody` 用例同样缺 `getLoadedSessionPath` 与 `subagent_lookup` 桩，补齐后 41/41。
