# 证据：前台 run 等待时来了引导消息，还没完成的子代理转到后台

日期 2026-10-12。对应笔记：`.agents/notes/implemented/feature/2026-10-12-foreground-run-detach.md`。

本目录的日志都是代码审查修正之后重跑的（触发改成只认这一轮的 steer、早启动项登记 inflight、组卡片处理注册表里找不到的行等，见笔记「审查之后的修正」）。

| 文件 | 内容 | 结果 |
|---|---|---|
| `real-run.mjs` / `real-run.txt` | 真实 agent-host 加 haiku；脚本扮演主进程，父会话在跑时发 steer 当作用户发话，另发一条跟进做对照 | 通过：12 项全部通过（codemode 对照只记录） |
| `ui-check-detached.txt`、`shots/` | `cd electron-agent && npm run ui:check -- subagent-detached` | 通过：23 项全部通过 |
| `ui-check-detached-red.txt` | 同一场景，临时把组卡片改回「store 里找不到就算已中断」 | 预期的失败：「晚到的任务从挂载起一次也没画成已中断」FAIL，证明这条断言抓得到 |
| `ui-check-group.txt` | `npm run ui:check -- subagent-history`（组卡片被它用到） | 通过：10 项全部通过 |
| `ui-check-conv.txt` | `npm run ui:check -- subagent-conversation`（组卡片被它用到） | 通过：33 项全部通过 |
| `vitest-multi-agent.txt` | `cd extensions && npx vitest run multi-agent prompt-metadata` | 通过：495 个通过 / 2 个跳过 |
| `vitest-renderer.txt` | `cd electron-agent && npx vitest run src/features/chat src/features/panels src/features/dock src/stores` | 通过：1362 个通过 |
| `vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 1945 个通过，1 个失败：已知的 `deleteSemantics`（Windows 沙箱删除，和本改动无关） |
| `cli-tests.txt` | `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts` | 通过：16/16 |
| `tsc-compare.txt` | `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit` | 154 条，逐条一致 |
| `agent-host-smoke.txt` | `cd electron-agent && node scripts/agent-host-smoke.mjs --entry out/run-detach/main/agent-host.js` | 通过：15 项全部通过 |

`vitest-extensions-full.txt` 是在 `index.test.ts` 一处类型标注修正之前跑的。那处只改类型、不改行为，修正后 `multi-agent` 又跑了一遍（`vitest-multi-agent.txt`）。

## 实跑覆盖了什么

AgentData 通道桩对工具授权一律放行。脚本收 agent-host 推出来的父会话 `tool_execution_update` / `tool_execution_end`，判断子代理的进度。「用户发话」是在父会话跑着时用 `agent_prompt` 发一条 `streamingBehavior: steer` 的消息，和界面上点「引导」一样。

1. **并行 run**：一个快（回复 FAST）、一个慢（写 1～1000 再写 SLOW_DONE）。
   - 等同一条进度事件里快的已结束、慢的还在跑时，发「回复 HERE」。
   - `spawn_agent` 95 ms 后返回，结果标明转后台：快的带回 FAST，慢的 `status: running`、`detached: true`、带 agentId。
   - 父会话接着回复 HERE，排在慢任务的通知之前。慢任务结束时，父会话收到它的 `subagent-settled` 通知（带回 SLOW_DONE）。
2. **单任务 run**（写 1～1000）：
   - 子代理起来（进度里有 sessionPath）后发话，回执是 `status: running` / `detached`。
   - 随即 `agent_abort` 打断父会话这一轮。子代理没有被取消，照样跑完，通知的 stopReason 是 completed、带回 SLOW_DONE。
3. **跟进不转后台**（审查修正后新增）：单任务写 1～200 再写 MEDIUM_DONE。
   - 子代理起来后用 `agent_follow_up` 发一条跟进。它直接进会话的 followUp 队列，`ctx.hasPendingMessages()` 因此为真；旧的触发条件会在 200 ms 内转后台。
   - 实际：发出后 run 又等了 10478 ms，`spawn_agent` 返回完整结果（MEDIUM_DONE），没有结算通知；跟进（回复 LATER）在工具结果之后才处理。
4. **codemode 对照**：这次环境的会话里没有 codemode 工具，模型说明后直接调了 `spawn_agent`。这一项只记录，嵌套调用不转后台由 `index.test.ts` 覆盖。

第一版的第一次完整跑时，慢任务只写到 300，在发话之前就结束了，没有转后台（脚本时序问题，不是功能问题）。之后改成写到 1000、并且等到「快的结束、慢的还在跑」再发话。

复跑：

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/run-detach
    cd .. && node .agents/evidence/2026-10-12-foreground-run-detach/real-run.mjs
