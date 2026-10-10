---
title: 子代理历史卡片按 agentId 补齐字段，并与运行卡共享注册表轮询
status: active
date: 2026-10-06
scope: electron-agent/chat
files:
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/features/chat/SubAgentInline.tsx
  - electron-agent/src/features/chat/SubAgentGroupInline.tsx
  - electron-agent/src/features/chat/ChatMessageItems.tsx
  - electron-agent/ui-harness/scenarios/subagent-history.tsx
  - electron-agent/ui-harness/probes/subagent-history.mjs
supersedes:
superseded_by:
---

## 背景
单任务卡片的旧 wait/status 结果没有模型字段。运行期间模型存在组件的 ref 中，重开会话后 ref 丢失，终态卡又不查询注册表，因此模型标签消失。启动记录不在上下文时，缺任务字段的结果也只能显示「子代理任务」。组合卡片原先按任务全文补模型，重复任务会匹配到另一个子代理。

## 决定
子代理展开结果保留 agentId，单项优先从工具结果恢复任务、标题、实际模型和思考档位；结果缺模型时仍使用参数中已保存的显式模型。历史字段仍不足时，单卡和组合卡短暂订阅已有的工作区轮询 store，共享首包查询，按 agentId 保存对应行后释放订阅。没有保存 agentId 的旧组合结果才按任务全文兼容匹配。

后台单卡的状态也从这份共享 store 取得，删除原先每张后台卡独立的 2 秒定时查询。首包到达前保持运行态；注册表判定中断、失败或完成后保留状态和元数据，释放轮询也不会让卡片回退。

## 放弃的方案
- 每张历史卡单独调用 subagent_list：一个会话有多张缺字段的卡片时会重复 IPC 与数据库查询，与并发渲染优化目标相冲突。
- 完成卡继续依赖运行时 ref：只对同一次挂载有效，无法修复重新打开会话的场景。
- 所有卡片按任务名匹配：重复任务跨会话、跨调用出现时无法区分身份；已有 agentId 必须作为匹配依据。
- 历史卡长期轮询直到找到字段：旧记录可能已被清理或不在列表的最近 50 条内，持续查询不能恢复这些字段。

## 后果
新结果中已有字段时无需额外查询。旧结果没有 agentId，且标题或模型没有保存在参数、结果或当前注册表列表中时，仍只显示实际可恢复的信息。卡片元数据与运行状态共享查询；真实 UI 场景验证首包查询次数、重挂载恢复和终态停止轮询。
