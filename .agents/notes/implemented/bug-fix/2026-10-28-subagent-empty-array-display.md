# Agent Note: 子代理空数组入参不再丢失任务与错误

Status: implemented

## Problem

2026-10-28 的真实调用以非空 task 同时携带 tasks:[]、chain:[]。后端 normalizeTasks 接受一个任务，前端 argsLookParallel 却仅凭 tasks 是数组强制按组展开，explicitWorks 只取空 tasks，成功启动和禁用拒绝都显示“并行子代理 · 0 个”。最新截图的 sa-26f163fa 已有子会话与成功工具调用，因此不是启动失败。完整调查证据见 `.agents/evidence/2026-10-28-parallel-subagent-investigation/`。

## Decision

前端以同一份显式任务序列确定模式、任务展开及每项元数据：非空 chain 优先，否则顶层 task 加有效 tasks 项；没有真实任务的流式输入显示单卡占位，不生成零项并行组。单任务保留 subIndex=null，继续使用原结果的 agentId/sessionPath 及跟进 overlay；chain 即使只有一步也保留步骤索引。只看数组存在性的分组开关和 expandSubAgents 的 asGroup 参数已删除。历史缺 args 时，结果中的 chain 模式和逐项结果也参与分组。

组卡接收调用结果，仅在调用级 error 时显示错误正文；并行部分失败继续沿用逐项状态，不把成功项改成失败。错误内容限高 160px、可滚动且跟随主题。后端启动、授权、并发、配置策略不变。

影响面是 subagentUtils、messagePrecompute、ChatMessageItems 和 SubAgentGroupInline，以及相应单测和 subagent-history 场景。必须同时核对混合 task/tasks 的标题/模型/详情下标和单步 chain，避免只修计数。

旧笔记审计：[子代理详情状态错位](../../implemented/bug-fix/2026-10-10-subagent-detail-running-status.md) 部分重叠，保留逐项状态与详情一致的约束；[子代理完整授权后才启动并行任务](../../implemented/bug-fix/2026-10-28-subagent-authorization-before-launch.md) 与启动权限有关，保持独立，不修改。没有同主题可直接更新的展示归一化决定。

## Alternatives considered

- 只把 argsLookParallel 改成 tasks.length>0：改动最少，可消除常见空卡。但仍遗漏 task+tasks 中的顶层任务、chain+tasks 的优先级与单步结果归属，故统一序列。
- 只要求调用方省略空数组：不改前端即可临时绕行。但旧历史与合法模型参数仍会触发，且错误没有出口，不作为修复。
- 后端拒绝空 tasks：约束更严格且可提前报错。但带非空 task 的调用本来合法，改变后端会影响全部调用方并破坏兼容性，故不采用。

## Consequences

单任务空数组入参在实时/历史/重挂载后保留身份、标题、结果与详情入口；拒绝错误可读；真实并行和 chain 数量与后端一致；混合任务元数据按正确索引；单步 chain 保留结果；流式未完成输入不生成零项并行组；部分失败不覆盖成功；跟进结果仍归并到单卡。

旧历史原先的空组恢复为单卡，连续任务序号可能随之变化。同一项的详情 subIndex 与后端 results 顺序一致，预计算的跟进归并也按实际单卡/组卡区分，不能只看结果里出现几个 agentId。流式期间可从单卡占位切换到组卡，不虚构已经开始执行。

本次没有更改工具 schema、注册表、权限策略或模型配置；空数组仍是合法的可选参数形状。

## 验证

证据目录：`.agents/evidence/2026-10-28-subagent-empty-array-display/`。

- 先写回归，再运行未改实现：`cd electron-agent && npx vitest run src/features/chat/messagePrecompute.test.ts src/features/chat/SubAgentGroupInline.test.tsx`。8 条预期失败，覆盖空数组成功/拒绝、单步 chain、混合任务、单元素 tasks、跟进结果和调用级错误。日志 `vitest-red.txt`。
- 使用 electron-ui-harness 技能，扩展既有 subagent-history：真实 AgentMessage/reducer → groupMessages → computeSubAgentUnits → renderMessageBody。修复前 `npm run ui:check -- subagent-history` 有 15 条失败，日志 `ui-red.txt`。
- 修复后 `npx vitest run src/features/panels/subagentUtils.test.ts src/features/chat/messagePrecompute.test.ts src/features/chat/SubAgentGroupInline.test.tsx src/features/chat/ChatMessageItems.test.tsx`：4 文件 88 项通过，日志 `vitest-green.txt`。
- `npm run ui:check -- subagent-history subagent-detached` 中 subagent-detached 23 项通过；subagent-history 的业务断言通过后，新 probe 误把字符串而非数组传给 t.style，报错退出。修正本次新增 probe 的参数后，单独 `npm run ui:check -- subagent-history`，32 项全部通过；没有修改 harness 自身。日志分别为 `ui-green.txt`、`ui-history-green.txt`。
- UI 合计只验证本需求相关的 2/34 个场景，其余 32 个未运行。涵盖成功/拒绝、chain、混合元数据、跟进正文、真实参数流、重挂载、浅色主题及转后台身份。截图 `ui-empty-arrays-light.png`。
- 独立只读审查未发现必须修复项（审查者未跑测试），记录 `review.txt`。
- `npm run verify-notes` 退出 0，树、格式、归档及证据检查通过；原有历史笔记警告不在本次范围，日志 `verify-notes.txt`。
- 定向 TypeScript 检查包含正常测试 setup 后，改动文件没有诊断，但命令退出 1：未改动的 `src/features/chat/messageActions/types.ts:2` 存在相对路径错误，`src/features/tools/StreamingCodeView.tsx:81` 存在主题类型不匹配。两文件 git diff 为空，没有扩大范围修复。日志 `typecheck-with-setup.txt`；不能声称项目类型检查通过。
