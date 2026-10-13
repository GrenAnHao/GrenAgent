# 证据：子代理的漏网错误归属与释放边界

日期 2026-10-12。对应笔记：`.agents/notes/implemented/feature/2026-10-12-subagent-leaked-errors-and-teardown.md`。

除特别说明，本目录的日志都是代码审查修正之后跑的。

| 文件 | 内容 | 结果 |
|---|---|---|
| `real-run.mjs` / `real-run.txt` | 真实 agent-host 加 haiku；临时目录里的测试扩展制造漏网错误；4 项 | 通过：15 项检查全部通过（第 2 项第一次模型没调测试工具，重试一次） |
| `real-run-case4-before-fix.txt` | 第 4 项在审查修正之前的构建上跑 | 预期的失败：迟一点才接住的 rejection 被判成 `uncaught error: CAUGHT_LATER`，证明审查指出的问题真实存在 |
| `vitest-multi-agent-mcp.txt` | `cd extensions && npx vitest run multi-agent mcp _shared/leak-owner.test.ts prompt-metadata` | 通过：699 个通过 / 2 个跳过 |
| `vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 1969 个通过，1 个失败：已知的 `deleteSemantics`（Windows 沙箱删除，和本改动无关） |
| `vitest-agent-process.txt` | `cd electron-agent && npx vitest run electron/agentProcess`（`hostEntry.ts` 改了） | 通过：52 个 |
| `cli-tests.txt` | `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts` | 通过：16/16 |
| `tsc-compare.txt` | `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit` | 154 条，和基线逐条一致 |
| `agent-host-smoke.txt` | `cd electron-agent && node scripts/agent-host-smoke.mjs --entry out/run-leak/main/agent-host.js` | 通过：15 项 |

## 实跑覆盖了什么

脚本扮演主进程，AgentData 通道桩对工具授权一律放行。临时 HOME 的 `~/.pi/agent/extensions/leak-probe.ts` 是只在这次实跑存在的测试扩展，不进仓库：

- `leak_probe`：返回后 50 ms，在不被 await 的定时器里制造一个没人处理的 rejection（`LEAK_PROBE <标签>`）。
- `late_catch_probe`：先起一个 5 ms 后失败的 promise，等 300 ms，再 await 并接住。
- `before_agent_start` 钩子：每轮开始把两个工具在不在激活清单里写到 stderr（日志里的 `[leak-probe-ext] active` 行）。

各项：

1. **进程内一次性并行 run**：一个子代理调 `leak_probe`，另一个只回 FINE。
   - 前者 `ok: false`、`stopReason: error`、`error: uncaught error: LEAK_PROBE A1`；后者照常带回 FINE。
   - agent-host 日志里这条标着出错子代理的 id。
2. **进程内可续聊（`action: spawn`）**：结算通知 `stopReason: error`，Diagnostic 是 `uncaught error: LEAK_PROBE B2`，日志里标着子代理 id。
3. **worker 后端**（运行时设置 `SUBAGENT_BACKEND=worker`）：错误出在 worker 进程里，经 RPC 交给 agent-host。这次 run 按 error 结束，宿主日志里有 `(worker): unhandledRejection: LEAK_PROBE C1`。
4. **迟一点才接住的 rejection**：子代理照常完成，只回 SURVIVED；agent-host 日志里没有这条。
   - 同一项在修正前的构建上失败，日志见 `real-run-case4-before-fix.txt`。

每一项之后 agent-host 都还在，照常答话。

## 关于「模型没调测试工具」

haiku 偶尔回答「测试工具在这个会话里不可用」，不去调。诊断行显示两个工具都在激活清单里，所以是模型的问题。脚本据此判断工具到底有没有跑：

- `leak_probe` 看宿主 stderr 里有没有本次的标签；
- `late_catch_probe` 看它写到 stderr 的标记。

没跑的那一次不算，换标签重试，最多三次，日志里写明第几次。最后这次完整跑里第 2 项第一次没调、第二次调了。

审查修正之前的第一版也跑过完整的实跑：第一次完整跑第 2 项也遇到了模型不调；单独重跑第 2 项、再完整跑一遍都通过。那一版的日志被后来的覆盖，没有留。

## 复跑

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/run-leak
    cd .. && node .agents/evidence/2026-10-12-subagent-leaked-errors-and-teardown/real-run.mjs
