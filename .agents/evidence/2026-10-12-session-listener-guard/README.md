# 证据：Pi 挂在会话上的监听方不再把错误抛回 SDK

日期 2026-10-12。对应笔记：`.agents/notes/implemented/feature/2026-10-12-session-listener-guard.md`。

| 文件 | 内容 | 结果 |
|---|---|---|
| `vitest-guard-listener.txt` | `cd extensions && npx vitest run _shared/guard-listener.real.test.ts _shared/guard-listener.test.ts --reporter=verbose` | 通过：6 个 |
| `vitest-multi-agent-mcp-shared.txt` | `cd extensions && npx vitest run multi-agent mcp _shared/leak-owner.test.ts _shared/guard-listener.test.ts _shared/guard-listener.real.test.ts prompt-metadata` | 通过：706 个通过 / 2 个跳过 |
| `vitest-electron-agent.txt` | `cd electron-agent && npx vitest run electron/agent/ electron/agentProcess/` | 通过：259 个 |
| `vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 1975 个通过，2 个失败：已知的 `deleteSemantics`；`resource-manager/mcp-store.test.ts` 的文件监听防抖用例（见下） |
| `mcp-store-rerun.txt` | 上面那个用例所在文件单独跑 3 次 | 通过：3/3 |
| `real-run-detach-regression.txt` | 回归实跑：`node .agents/evidence/2026-10-12-foreground-run-detach/real-run.mjs --log …`（真实 agent-host 加 haiku，构建 `out/run-detach`） | 通过：12 项全部通过 |
| `cli-tests.txt` | `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts` | 通过：16/16 |
| `tsc-compare.txt` | `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit` | 154 条，和基线逐条一致 |
| `agent-host-smoke.txt` | `cd electron-agent && node scripts/agent-host-smoke.mjs --entry out/run-detach/main/agent-host.js` | 通过：15 项 |

## 真实 SDK 复现（`_shared/guard-listener.real.test.ts`）

不联网：真实 `AgentSession`，模型是 pi-ai 的 faux 供应商，按脚本出一次 `progress_probe` 工具调用。工具在 `execute` 里调一次 `onUpdate`，再返回 `PROBE_DONE`；会话上挂一个在 `tool_execution_update` 上抛错的监听方。

- **不包**：`execute` 正常返回了，会话里却没有这条工具结果。这一轮以一条 `stopReason: error`、`errorMessage: "listener broke"` 的 assistant 消息结束。
  - 这是 SDK 本身的行为，这条用例留作金丝雀：SDK 哪天改了，它会失败。
  - 动手前以为是「工具结果标成错误」，实测是工具结果整个丢了，笔记按实测写。
- **用 `guardListener` 包上**：工具结果是 `PROBE_DONE`，这一轮正常结束（`stopReason: stop`），日志里有一行 `[session-listener] probe listener failed; …`。

## 接线处的单元测试

- `embedded-runner.run.test.ts`：进度回调每次都抛错。
  - 子会话的监听方一次都没有把错误抛给 SDK；子代理结果照常（`ok`、`child answer`）。
  - 日志里 `sub-agent <id> progress failed` 只记一次。
- `workspaceHandle.test.ts`：推给界面的 `onEvent` 抛错（模拟 agent-host 和主进程断开）。主会话的监听方不外抛，日志只记一次。
- worker 的事件转发（`worker-host.ts`）没有单元测试：要真实的 worker 进程和 IPC 通道。它用的是同一个 `guardListener`，接线见代码。

## 全量里的另一个失败

`resource-manager/mcp-store.test.ts` 的「mcp.json 连续几次写入合并成一次重读」在全量里失败了一次：防抖回调 0 次，预期 1 次。

- 这个文件和它测的 `watchMcpConfigFiles` 本次都没改。
- 单独跑 3 次都通过（`mcp-store-rerun.txt`）。
- 判断是全量并发下 `fs.watch` 的时序偶发，不是回归。

## 关于 `electron/agentData`

第一次跑 Electron 侧时，路径过滤写成了 `electron/agent`，顺带匹配进 `electron/agentData`，那里有 10 个失败（审计视图、任务清理、运行时）。`electron/agentData` 在工作区里没有任何改动，和本次无关；本目录的日志只跑了 `electron/agent/` 和 `electron/agentProcess/`。

后来查实是本来就有的：

- 用 `git archive HEAD` 导出一份干净的源码，单独跑这 3 个测试文件，是同样的 10 个失败，报错逐字相同。
- 来源是提交 `93d417b0`（2026-09-22，「route agent data wiki through the new engine」）。它把 `runtime.ts` 里的 `wiki.replace` / `wiki.admin.overview` 管理方法和 Wiki 任务入队去掉了，也改了 `auditViewStore.ts`，但 `runtime.test.ts`、`jobCleanup.test.ts`、`auditViewStore.test.ts` 没跟着改。

## 复跑

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/run-detach
    cd .. && node .agents/evidence/2026-10-12-foreground-run-detach/real-run.mjs --log .agents/evidence/2026-10-12-session-listener-guard/real-run-detach-regression.txt
