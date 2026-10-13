# 证据：send_message 可以不唤醒对方（wake: false）

日期 2026-10-12。对应笔记：`.agents/notes/implemented/feature/2026-10-12-send-message-without-waking.md`。

| 文件 | 内容 | 结果 |
|---|---|---|
| `real-run.mjs` / `real-run.txt` | 真实 agent-host 加 haiku：驻留、已卸载（进程内）、已卸载（worker）三种对方状态下 `wake: false` 再唤醒；子代理按新结尾提示交结果（只记录） | 通过：20 项全部通过（代码审查后的修正重新构建后复跑） |
| `ui-check-agent-message.txt`、`shots/` | `cd electron-agent && npm run ui:check -- agent-message` | 通过：14 项全部通过 |
| `vitest-multi-agent.txt` | `cd extensions && npx vitest run multi-agent auto-title prompt-metadata` | 通过：490 个通过 / 2 个跳过 |
| `vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 1921 个通过，1 个失败：已知的 `deleteSemantics` |
| `vitest-renderer.txt` | `cd electron-agent && npx vitest run src/features/chat src/stores` | 通过：1149 个通过 |
| `cli-tests.txt` | `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts` | 通过：16/16 |
| `tsc-compare.txt` | `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit` | 154 条，逐条一致 |
| `agent-host-smoke.txt` | agent-host 冒烟（入口用 `out/send-quiet`） | 通过：15 项全部通过 |

## 实跑覆盖了什么

AgentData 通道桩对工具授权一律放行，这里只验证投递。每种情况都做同一件事：父会话用 `wake: false` 发一条带暗号的消息，然后检查：
- `send_message` 的回执是 `{ woken: false, delivery: "appended" }`；
- 等 20 秒没有新的结算通知，说明子代理没被唤醒；
- 子会话 JSONL 里多了一条 `custom_message` / `agent-message`；
- 子会话没有新的助手回复。

然后用默认的唤醒问暗号，结算通知要带回最新的暗号。

1. **驻留池里的子代理**：先确认结算后诊断采样里 `resident ≥ 1`。暗号 BANANA。
2. **重启 agent-host 后，子代理已卸载**：投递后的诊断采样 `active=0`、`resident=0`，说明没有加载会话。暗号 CHERRY。
3. **worker 后端**：确认 worker 在结算后退出，投递时也没有起 worker 进程（按命令行查本次构建的 `pi-worker.js --mode subagent`）。唤醒后冷恢复回 worker，暗号 DATE。
4. **子代理交最终结果**（只记录，不判定）：派一个算 17+25 的子代理，它按新的结尾提示用 `wake: false` 发结果。父会话收到 1 条 `agent-message`，spawn 之后父会话只有 2 条助手回复（STARTED 和处理结算通知），没有为同一个结果跑两轮。

复跑：

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/send-quiet
    cd .. && node .agents/evidence/2026-10-12-send-message-without-waking/real-run.mjs

「子代理还有没结束的活时，`wake: false` 交结果改成唤醒」没有实跑：临时 HOME 里没有 Windows 沙箱 helper，bash 起不来，造不出在跑的后台任务。这条由 `adjacent-tools.test.ts` / `activation.test.ts` 覆盖。
