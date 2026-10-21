# Agent Note: 进程被杀后留下的工具卡重启后一直转圈

Status: implemented

## Problem

应用在 `wait_agent` 等待中被强制关闭，重启后这张卡一直转圈，实际早就结束了。真实会话（electron-mall-manager，`…_01a14ee8-….jsonl`）里能看到完整链条：

1. 进程被杀时 `wait_agent` 没有 toolResult。UI 历史（`.pi/ui-history/<会话>.jsonl`）里这张卡是 `status: running`、没有 `result`。
2. 重启后 Goal 续跑先于画面载入就开始了。画面还没绑这个会话，事件进了后台 shadow，shadow 去补快照（`scheduleBackfill`）。
3. UI 历史比后端长，快照用 UI 历史；会话在跑，按 [子代理详情状态错位](2026-10-10-subagent-detail-running-status.md) 的约定整份保留 running 卡，不调 `interruptPendingToolCards`。
4. 这一轮的 `agent_end` / `agent_settled` 只收参数没写完的卡（`settleIncompleteToolCards`），这张卡参数是全的，没人收。每轮结束又把它原样写回 UI 历史，之后每次打开都转圈。

后端快照自己不会出这张卡：`messagesFromAgent` 只给最后一条助手消息里没结果的调用补 running 卡，被杀那条后面已经有新的助手消息。问题出在 UI 历史把进程被杀那一刻的半截状态存了下来，而「会话在跑就整份保留」把它当成了还在等的调用。

## Decision

- 会话在跑时，加载路径只保留**后端快照末尾还在等结果**的调用（`snapshotMessages` 返回的 `pendingCallIds`），UI 历史里其余 running、无结果的卡一律收成已中断。`interruptPendingToolCards(messages, keep?)` 多了 `keep` 参数；`agent.ts` 的会话加载、补历史（`fillHistory`）、后台 shadow 补读三处都按这个办。会话不在跑时照旧全部收掉。
- `agent_end` / `agent_settled` 收尾时，除了参数没写完的卡，running 且没有任何结果的非 ask_user 卡也收成已中断，并带 `interrupted: true`，结果消息晚到仍能换成真实结果。pi 在 `agent_end` 前会等完本轮所有工具，这时还在转圈的只可能是丢了 `tool_execution_end`，或是从 UI 历史读回来的旧调用。
- ask_user 的等待行照旧不动，它有自己的恢复流程。
- `useChildSessionBinding` 不变：子代理详情不读 UI 历史，快照里的 running 卡只来自 `messagesFromAgent` 的末尾调用。

## Alternatives considered

- **写 UI 历史时把 running 卡存成已中断。** 最强理由是一劳永逸：落盘的数据永远不带半截状态。不用它，因为 UI 历史在回合进行中也会写（每轮 `reachedEnd`、后台 `agent_settled`），那时 running 卡确实在跑，写成已中断再读回来，正在执行的命令就会被错标成失败；而且磁盘上已有的坏数据它修不了。
- **只靠 `agent_end` 收尾。** 改动最小，下一轮结束就会自愈。不够：Goal 一轮可能跑很久，这期间一直转圈；会话不再跑的话也等不到下一个 `agent_end`。加载侧的 `pendingCallIds` 让画面一载入就对。
- **只靠加载侧。** 加载侧覆盖不到「画面载入后才变成孤儿」的卡（例如丢了 `tool_execution_end`），收尾时兜一次没有副作用。

## Consequences

- **收益**：进程被杀、sidecar 重启留下的工具卡在下一次载入时就显示已中断，不论会话是否在跑；已有坏数据的 UI 历史在下一轮结束时被改写成已中断。
- **代价**：「会话在跑」时判断哪张卡还在等，依赖 `messagesFromAgent` 的末尾调用规则。如果以后 pi 允许一轮里前一条助手消息的工具在后一条助手消息出来后还在跑，这里会把它误标成已中断。
- **重访信号**：会话在跑时，正在执行的工具卡被画成已中断，或者不在跑的会话里又出现一直转圈的卡。

## Verification

- 真实会话实测：用卡住的会话 JSONL + UI 历史跑 `snapshotMessages` → `interruptPendingToolCards`，那张 `wait_agent` 载入时是 running，修复后会话在跑 / 不在跑两种情况都是 `error` + `interrupted`。临时测试跑完已删除。证据：`.agents/evidence/2026-10-18-stale-running-tool-after-kill/real-session-load.txt`。结果：通过。
- `cd electron-agent && npx vitest run src/stores/agent.test.ts src/stores/agentReducer.test.ts src/stores/pendingAskUserLoad.test.ts src/features/panels/useChildSessionBinding.test.tsx`：158 通过。新增的三条（`interruptPendingToolCards` 按 keep 保留、`agent_end` 收无结果的卡、后台补快照时 UI 历史里的 running 卡收成已中断）在修复前的代码上失败。证据：`.agents/evidence/2026-10-18-stale-running-tool-after-kill/vitest-targeted.txt`。结果：通过。
- `cd electron-agent && npx vitest run src`：321 个文件 2596 条全过。
- 没跑 ui:check：改动只在 store 和 reducer，卡片渲染没变。
