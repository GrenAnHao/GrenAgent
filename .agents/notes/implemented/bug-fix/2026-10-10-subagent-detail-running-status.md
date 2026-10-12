# Agent Note: 子代理详情状态错位

Status: implemented

## Problem

- 链式 / 并行里某一步已完成，组卡片写已完成，详情还在「正在处理」：`subAgentUnitView`（`src/features/panels/subagentUtils.ts`）在整条调用 running 时不看这一步的行是否终态。
- 子代理正在执行的命令在详情里显示红 ✗、无输出：安静补读时 `messagesFromAgent` 给结果未落盘的调用补 running 卡，`applyPendingAskUserOnLoad` 又把它改成 error。

## Decision

- 整条调用 running 时，这一步 `rowTerminal(live)` 为真就出终态视图（`terminalUnitView`），判断 **must** 和 `expandSubAgents` 一致。
- `applyPendingAskUserOnLoad` **never** 处理 `result === undefined` 的非 ask_user running 卡；「已中断」由知道运行态的调用方 `interruptPendingToolCards`：会话加载、`useChildSessionBinding`、后台 shadow 补读（`src/stores/agent.ts`）。新增加载路径 **must** 同样按运行态决定。

## Alternatives considered

- **给 `applyPendingAskUserOnLoad` 传运行态**——三个调用方已各自持有运行态并调 `interruptPendingToolCards`，同一判断写两处。
- **补读时去掉末尾 running 卡**——命令会消失几秒再出现。

## Consequences

- **收益**：详情和组卡片状态一致；运行中的命令保持转圈。
- **代价**：漏调 `interruptPendingToolCards` 的新加载路径会留下永远转圈的卡。
- **重访信号**：不在跑的会话里出现一直转圈的工具卡。

## Verification

- `cd electron-agent && npx vitest run src/features/panels/subagentUtils.test.ts src/stores/pendingAskUserLoad.test.ts src/features/panels/useChildSessionBinding.test.tsx`
- `npm run ui:check -- subagent-conversation subagent-history`
- 决策记录：[docs/decisions/electron-agent/2026-10-10-subagent-detail-running-status.md](../../../../docs/decisions/electron-agent/2026-10-10-subagent-detail-running-status.md)。
