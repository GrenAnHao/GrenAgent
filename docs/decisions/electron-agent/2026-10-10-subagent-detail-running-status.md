> 已迁移：本决定现由 [.agents/notes/implemented/bug-fix/2026-10-10-subagent-detail-running-status.md](../../../.agents/notes/implemented/bug-fix/2026-10-10-subagent-detail-running-status.md) 维护；本文件冻结只读。

---
title: 子代理详情的状态：链式 / 并行已结束的一步按自己的终态显示，结果未落盘的调用在补读时保持运行中
status: active
date: 2026-10-10
scope: electron-agent
files:
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/stores/pendingAskUserLoad.ts
  - electron-agent/src/stores/agent.ts
  - electron-agent/src/features/panels/useChildSessionBinding.ts
supersedes:
superseded_by:
---

## 背景

两个和子代理详情有关的状态错位：

1. **链式 / 并行里的某一步已经完成，详情还在「正在处理」。** 组卡片按 `expandSubAgents` 逐步展开，后端每结束一步就写一条终态行，卡片上这一步显示已完成。点开详情走的是 `subAgentUnitView`：整条调用的状态还是 running，它就只看 `live` 有没有 agentId / sessionPath，一律给 running，不看这一行已经是终态。
2. **子代理正在执行的命令显示成失败（红 ✗、无输出），结果回来才变绿。** 详情在流安静 5 秒后补读会话文件（`useChildSessionBinding`），后台会话的 shadow 补读也一样。`messagesFromAgent` 会给末尾结果还没落盘的调用补一张 running 卡，随后 `applyPendingAskUserOnLoad` 把除挂起的 ask_user 之外所有 running 卡都改成 error——这一步原本只为「加载一个已经不在跑的会话」设计，补读时子代理明明还在跑。

## 决定

- `subAgentUnitView` 在整条调用 running 时，先看这一步的行是否终态（`rowTerminal`，和 `expandSubAgents` 同一判断），是就按它自己的成功 / 失败出终态视图；和完成分支共用 `terminalUnitView`。
- `applyPendingAskUserOnLoad` 不再处理结果未落盘的非 ask_user 调用（`result === undefined`），原样留给调用方；有部分结果的旧 running 卡照旧改成 error。是否「已中断」由知道会话还在不在跑的调用方决定：会话加载（`agent.ts` 加载分支）和详情绑定（`useChildSessionBinding`）原本就按运行态决定要不要 `interruptPendingToolCards`；后台 shadow 补读补上同样的判断（`isStreaming || runActive || awaitingResponse`）。

## 放弃的方案

- **在 `applyPendingAskUserOnLoad` 里传入「会话是否在跑」。** 改动面一样小，但它是纯加载后处理，三个调用方都已经各自持有运行态并调用 `interruptPendingToolCards`，再传一份运行态是同一判断写两处。
- **详情只信组卡片的状态，不再自己算。** 详情需要 sessionPath 绑真会话、需要按步骤给失败原因，组卡片的展开结果没有这些字段；共用 `rowTerminal` 判断已经足够让两边一致。
- **补读时跳过末尾的 running 卡，等结果事件再出卡。** 用户会看到正在执行的命令在补读后消失几秒再出现，比红 ✗ 更怪。

## 后果

- 结果未落盘的调用，加载后的最终状态完全由调用方的 `interruptPendingToolCards` 决定。新增加载路径如果漏调它，不在跑的会话会留着永远转圈的卡；`pendingAskUserLoad.test.ts` 和 `useChildSessionBinding.test.tsx` 盖住了现有路径。
