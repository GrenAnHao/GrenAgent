# 证据：子代理的审批转给父会话的界面

日期 2026-10-12。对应笔记：`.agents/notes/implemented/feature/2026-10-12-subagent-approvals-via-parent.md`。

| 文件 | 内容 | 结果 |
|---|---|---|
| `real-run.mjs` / `real-run.txt` | 真实 agent-host 加 haiku；脚本扮演主进程，答复 pi://ui-request 审批卡；超时调成 8 秒 | 通过：25 项全部通过（代码审查后的修正重新构建后复跑） |
| `ui-check-subagent-approval.txt`、`shots/` | `cd electron-agent && npm run ui:check -- subagent-approval` | 通过：32 项全部通过 |
| `vitest-extensions-targeted.txt` | `cd extensions && npx vitest run _shared/approval-route _shared/delegation-scope safety mcp-policy sandbox/bashTool multi-agent` | 通过：635 个通过 / 2 个跳过 |
| `vitest-electron-renderer-targeted.txt` | `cd electron-agent && npx vitest run electron/app/toolPermission electron/agent/sessionUiAdapter src/stores src/features/chat src/features/extensionUi` | 通过：1281 个通过 |
| `vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 1907 个通过，1 个失败：已知的 `deleteSemantics`。审查前那一轮里 `mcp-store` 的文件监听时序失败过一次，单独连跑 3 次都通过 |
| `cli-tests.txt` | `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts` | 通过：16/16 |
| `electron-main.txt` | `cd electron-agent && npx vitest run electron` | 17 个失败：15 个和 HEAD 一致；`gitService`、`tencentdbRemoval` 是负载下超时，单独复跑通过 |
| `tsc-compare.txt` | `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit` | 154 条，和第 4 阶段逐条一致 |
| `agent-host-smoke.txt` | agent-host 冒烟（入口用 `out/subagent-approval`） | 通过：15 项全部通过 |

## 实跑覆盖了什么

AgentData 通道桩扮演主进程的授权服务。目标文件名带 `approval-` 的 `write` 判成 ask，其余放行；子代理没带 `approvalRoute` 时，照 `toolDecisionService` 固定拒绝。主进程这一段的真实逻辑由 `toolDecisionService.test.ts` / `rpc.test.ts` 覆盖。

1. **进程内子代理，答「允许本次」**：
   - 父会话收到一张审批卡：信封的 `sessionPath` 是父会话，标题写「子代理 …（sa-xxxx） 请求批准：approval-one.txt」，带 `timeout: 8000` 和 `subagents`。
   - 授权判定收到 `origin: subagent`、`approvalRoute: true`。
   - 审计回填 `user_allow`，文件写出来，宿主随后发 `dismiss`。
2. **进程内子代理，没人答**：
   - 约 8 秒（8009 ms）后宿主发 `dismiss`，审计回填 `timeout`。
   - 子代理的 write 结果是「8 秒内没有人批准 write，视为被拒。」加换路提示，文件没写。
3. **worker 子代理**（运行中把 `SUBAGENT_BACKEND` 改成 worker）：
   - 子会话 meta 是 `backend: worker`。
   - 审批卡同样落在父会话上。worker 先经 `approvalReachable` 问宿主能不能问到人，safety 再带 `approvalRoute: true`，请求经 `approval` RPC 送到父会话。
   - 批准后文件写出来。
4. **`SUBAGENT_APPROVAL_TIMEOUT_MS=0`**：没有审批卡，判定不带 `approvalRoute`，固定拒绝，子代理收到委派范围的拒绝文案。

第一次实跑用的是 `bash echo`。批准这一段全部通过，但命令起不来：临时 HOME 里找不到 Windows 沙箱 helper（`windows helper not found at any probe path`）。原因是用自定义 `--outDir` 构建时，`copyPiAdjacentAssets` 仍只把 `pi-sandbox-win.exe` 拷到 `out/main`。这只影响这类测试构建，不是回归。改用在进程内执行、不经 OS 沙箱的 `write` 后，全部通过。bash 升权经路由批准的路径由 `sandbox/bashTool.test.ts` 覆盖。

复跑：

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-approval
    cd .. && node .agents/evidence/2026-10-12-subagent-approvals-via-parent/real-run.mjs
