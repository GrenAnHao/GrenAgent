# Agent Note: 子代理并行工具已结束后不再被安静补读退回运行中

Status: implemented

## Problem

子代理在一条消息里并行调用 bash 和 code_explore。bash 跑测试跑了 50 秒，这期间详情里 code_explore 一直在转圈，看起来像是被 bash 堵住了。

其实它没被堵住。pi 的 `executeToolCallsParallel`（pi-agent-core `agent-loop.js`）会先把整批工具准备完，然后并发执行；每个工具跑完立刻发自己的 `tool_execution_end`。诊断日志里，这次 code_explore 对应的 `codeRetrieval.call` 在调用后约 3.1 秒就结束了（`runtime-diag.jsonl`，16:48:14）。

问题出在 toolResult 消息的落盘时机：pi 要等 `Promise.all` 整批结束才把它们写进 JSONL。`useChildSessionBinding` 在事件安静满 5 秒后会补读 JSONL，这时快照里两个调用都没有结果，`messagesFromAgent` 都补成 running 卡。快照条数不少于实时状态，补读就整份采用，把实时状态里已经 done 的 code_explore 覆盖回 running。bash 在静默跑测试、不推输出，所以 5 秒一到必然触发补读。

## Decision

安静补读整份采用快照时，过一遍 `keepSettledLiveTools`（`electron-agent/src/stores/sessionMessageSync.ts`）：快照里还是 running、实时状态里已经结束的工具，沿用实时的状态和结果，id 保持快照的。

反方向不覆盖：实时里还在跑、快照里已经有结果的，以快照为准。进程子代理不推事件，它的工具结果只能靠补读更新，这是 [子代理详情运行状态](2026-10-10-subagent-detail-running-status.md) 定下的补读用途。

## Alternatives considered

- **补读一律走 `mergeLiveTail`（实时为准）**：主代理补后台快照用的就是它，两边会统一，这是最强的理由。没这么做，是因为 `mergeLiveTail` 里实时卡整张盖在快照上。进程子代理的实时状态停在 running，结果只在快照里，用它就会把补读拿到的结果盖掉，那正是「条数不少就整份采用」这条分支存在的原因。
- **事件在流时不补读，改成按工具是否在跑来判断**：bash 静默跑的时候本来就没有事件，「有工具在跑就不补读」会让进程子代理在长命令期间完全看不到更新。而且只要整份采用的规则不改，补读一回来照样退回。

## Consequences

并行批次里先结束的工具在详情里马上显示完成，不会因为同批的慢命令转圈。

内嵌子代理的工具卡状态现在以实时事件为准，直到 JSONL 写入结果为止。要是某次实时 `tool_execution_end` 带的结果和最终落盘的不一样（比如 `tool_result` 钩子在落盘前又改了内容），补读期间显示的是事件里的版本，子代理结束后的那次补读不再有 running 卡，会整份换成落盘内容。

主代理不受影响，它的补读走 `mergeLiveTail`，本来就是实时为准。

## Verification

结果：通过。

- `cd electron-agent && npx vitest run src/features/panels/useChildSessionBinding.test.tsx src/stores/sessionMessageSync.test.ts`：18 条通过。新增的「运行中安静补读：并行批次里已经结束的工具不被快照退回运行中」在修复前失败（`"status": "running"`，期望 `done`）。`keepSettledLiveTools` 的两个方向各一条单测。
- 没有跑 ui-harness：改的是补读时的数据合并，没有改渲染。现有场景都不走安静补读，`subagent-conversation` 的桩在运行中直接返回固定快照，造不出「快照条数 ≥ 实时」又带并行批次的时序。
