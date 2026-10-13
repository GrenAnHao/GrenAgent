# Agent Note: Pi 挂在会话上的监听方不再把错误抛回 SDK

Status: implemented

## Problem

[子代理重新设计](../architecture/2026-10-11-subagent-redesign.md)第 3 节核查 SDK 时记下：工具调 `onUpdate` 发进度时，这条进度事件的 promise 被拒，这次工具调用会以本轮 error 结束（pi-agent-core 1.1.0 `agent-loop.js:587`）。这一项当时留作后续项，原来的建议是在 `embedded-runner.ts` 里把传给 SDK 的进度回调包一层。动手前查实：

- **出问题的环节**：
  - 工具拿到的 `onUpdate` 是 SDK 的 `emit(tool_execution_update)`。`Agent.processEvents` 逐个等会话的监听方处理完；`AgentSession._emit` 同步调用 `session.subscribe` 挂上的监听方。
  - 任何一个监听方同步抛错，这条事件的 promise 就被拒。SDK 在 `execute` 结束后统一等这些 promise。
  - 别的事件（例如 `message_update`）上监听方抛错，整轮中断。
- **实际后果比原来记的更重**：真实 SDK 加 faux 模型复现，`execute` 正常返回了，工具结果却整个丢了，会话里没有这条工具结果；这一轮以一条 `stopReason: error`、`errorMessage` 为监听方错误的 assistant 消息结束，模型看不到工具结果。
- **原来的建议不管用**：那个 promise 是 SDK 自己留着、自己等的。工具一侧包住传给 SDK 的回调接不到它，只能在监听方这里拦。
- **扩展的事件处理器没有这个问题**：SDK 的 `runner.emit` 对每个处理器单独 try/catch。
- **Pi 自己挂在会话上的监听方都没防护**，一共 4 个：
  1. `embedded-runner.ts` 子会话的事件监听：
     - 累积 transcript 尾部；
     - 节流后调进度回调（`spawn_agent` 在里面写注册表、推给父会话的 `onUpdate`）；
     - 转发给界面。
     - 节流走定时器时，这里抛错还会变成漏网错误，按[漏网错误归属](2026-10-12-subagent-leaked-errors-and-teardown.md)的规则把子代理判失败。
  2. `embedded-runner.ts` 的空闲 / 卡顿看门狗：记活动时间。
  3. `worker-host.ts`：把事件转给宿主。宿主断开、事件克隆失败时会抛。
  4. `workspaceHandle.ts` 主会话：把事件推给界面。转换已经包了 try，推送没包，agent-host 和主进程断开时发送会抛。
- **两个方向都受影响**：
  - 子代理的进度管道出错，坏的是子代理自己这一轮。
  - 父会话的 `spawn_agent` 的进度走父会话的监听方（主会话就是第 4 个），那边出错，父会话的这次 `spawn_agent` 调用的结果会丢。

## Decision

用户确认的 3 个选择：4 个监听方都包；进度回调出错后吞掉、记日志，后面的进度照常推；日志首次记完整堆栈，之后只计数，收尾时写总数。

- **`extensions/_shared/guard-listener.ts`**：`guardListener(name, fn)` 包住监听方。
  - 同步抛错、返回被拒的 promise 都吞掉。
  - 同一个监听方第一次出错，记 `[session-listener] <名字> failed; swallowed so the session keeps going` 和完整错误；之后只计数。
  - 收尾时 `report()` 写一行 `<名字>: N more error(s) swallowed`。
- **包住的 4 处**：
  1. `embedded-runner.ts` 子会话的事件监听（`sub-agent <id> events`）。
     - 进度回调另包一层（`sub-agent <id> progress`）：建会话时的第一条进度、事件里同步发的、节流定时器发的、心跳发的，都经它。定时器里的出错因此不会变成漏网错误。
     - 生成进度内容（取子代理当前输出）也在这一层里。
     - `unsub` 时两个都 `report()`。
  2. 空闲 / 卡顿看门狗（`sub-agent <id> activity watch`），收尾时 `report()`。
  3. worker 的事件转发（`worker event forwarding`），停止转发时 `report()`。
  4. 主会话推给界面（`main session events`），退订时 `report()`。
- 后续笔记里的几项都已落地，那篇跟踪笔记关闭，入站链接改指各自的笔记。

## Alternatives considered

- **照原来的建议，在工具一侧把传给 SDK 的进度回调包一层。**
  - 最强理由：改动集中在一处（`embedded-runner.ts`）。
  - 没选：接不到。工具调的回调只是把 `emit` 返回的 promise 塞进 SDK 自己的数组，`Promise.all` 也是 SDK 自己等的；拒绝发生在监听方，工具这边什么都看不到。
- **只包 `embedded-runner.ts` 里的两个监听方（原笔记的范围）。**
  - 最强理由：只动子代理这边，主会话的代码不碰。
  - 没选（用户选 1a）：父会话的 `spawn_agent` 的进度走父会话的监听方；主会话的推送在断开时会抛，那次 `spawn_agent` 的结果同样会丢。
- **进度回调第一次出错后，这次运行不再推进度。**
  - 最强理由：持续出错的回调不会每条事件都再跑一遍。
  - 没选（用户选 2a）：偶发错误（例如注册表一时写不进去）本来能自己恢复，停掉后卡片的进度会一直停在出错前那一条。
- **每次出错都记完整日志。**
  - 最强理由：每次的上下文都在。
  - 没选（用户选 3a）：流式输出时一秒几十条事件，持续出错会刷屏；第一次的堆栈加总数够定位。

## Consequences

- **收益**：
  - Pi 自己的进度、转发、记账代码出错，不再让工具调用丢结果、不再中断整轮、不再变成漏网错误把子代理判失败。
  - 只影响那条进度或那条界面事件。
- **代价**：
  - 吞掉的错误只在日志里。界面上的进度可能停在出错前那一条，直到下一条成功。
  - 主会话推给界面的事件丢一条，界面可能少一段流式内容。
- **约束**：以后在 SDK 会话上挂新的监听方（`session.subscribe`），**must** 经 `guardListener`。

## 验证

仓库里没有 `verify-*` skill。证据在 `.agents/evidence/2026-10-12-session-listener-guard/`，说明见该目录的 `README.md`。结果：通过。

- **真实 SDK 复现**：`cd extensions && npx vitest run _shared/guard-listener.real.test.ts _shared/guard-listener.test.ts --reporter=verbose`，6 个通过。日志：`.agents/evidence/2026-10-12-session-listener-guard/vitest-guard-listener.txt`。
  - 环境：真实 `AgentSession` 加 pi-ai faux 模型，不联网。工具调一次 `onUpdate` 再返回 `PROBE_DONE`，会话上挂一个在进度事件上抛错的监听方。
  - 不包：工具结果整个丢了，这一轮以 `stopReason: error`、`errorMessage: "listener broke"` 的 assistant 消息结束。这条留作金丝雀，SDK 改了行为它会失败。
  - 用 `guardListener` 包上：工具结果是 `PROBE_DONE`，这一轮正常结束。
- **接线处的单元测试**（含在下面的日志里）：
  - `embedded-runner.run.test.ts` 新增 1 个：进度回调每次都抛错，子会话监听方不外抛、结果照常、日志只记一次。
  - `electron/agent/workspaceHandle.test.ts` 新增 1 个：推给界面抛错（模拟和主进程断开），主会话监听方不外抛、日志只记一次。
  - `_shared/guard-listener.test.ts`（4 个）：传参、同步抛错只记第一次、`report()` 写总数、async 监听方的拒绝也吞掉。
  - worker 的事件转发没有单元测试（要真实的 worker 进程和 IPC），用的是同一个 `guardListener`。
- `cd extensions && npx vitest run multi-agent mcp _shared/leak-owner.test.ts _shared/guard-listener.test.ts _shared/guard-listener.real.test.ts prompt-metadata`：706 个通过 / 2 个跳过。日志：`.agents/evidence/2026-10-12-session-listener-guard/vitest-multi-agent-mcp-shared.txt`。
- `cd electron-agent && npx vitest run electron/agent/ electron/agentProcess/`：259 个通过。日志：`.agents/evidence/2026-10-12-session-listener-guard/vitest-electron-agent.txt`。
- **回归实跑**：`node .agents/evidence/2026-10-12-foreground-run-detach/real-run.mjs --log …`，12 项全部通过。日志：`.agents/evidence/2026-10-12-session-listener-guard/real-run-detach-regression.txt`。
  - 环境：真实 agent-host 加 `custom-muqywnc8/claude-haiku-5-5`。
  - 这个脚本靠父会话收到的进度事件（快的结束、慢的还在跑）掐时机发话，能跑通说明进度管道照常。
- `cd extensions && npx vitest run`（全量）：1975 个通过，2 个失败。日志：`.agents/evidence/2026-10-12-session-listener-guard/vitest-extensions-full.txt`。
  - 已知的 `deleteSemantics`。
  - `resource-manager/mcp-store.test.ts` 的文件监听防抖用例：这个文件和它测的代码本次都没改，单独跑 3 次都通过（`.agents/evidence/2026-10-12-session-listener-guard/mcp-store-rerun.txt`），判断是全量并发下 `fs.watch` 的时序偶发。
- `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts`：16/16 通过。日志：`.agents/evidence/2026-10-12-session-listener-guard/cli-tests.txt`。
- `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit`：154 条，和基线逐条一致。记录：`.agents/evidence/2026-10-12-session-listener-guard/tsc-compare.txt`。
- agent-host 冒烟 `cd electron-agent && node scripts/agent-host-smoke.mjs --entry out/run-detach/main/agent-host.js`：15 项全部通过。日志：`.agents/evidence/2026-10-12-session-listener-guard/agent-host-smoke.txt`。
- 不改界面，没有跑 ui-harness。
