# 2026-11-17 session-project-transfer task 1.1

## 本轮落地

- 新增 `electron/app/sessionProjectTransferContracts.ts`：JSON-only Request/Ack 联合 + `parseSessionProjectTransferRequest`（按 action 字段白名单，拒绝 after/before image、backup、journal、manifest、snapshot、rollback、recovery、evidence 字段）+ `assertTransferSourceWorkspace`（分隔符／尾斜杠／大小写等价）。
- `agent_session_project_transfer` IPC 命令：外部 `args.workspace` 决定来源，请求体 `sourceWorkspace` 只做确认；校验后以外部 workspace 归一来源再下发。in-process port 优先，否则 `service.send` fallback。
- agent-host transport：`AGENT_METHODS` 增 `pi.sessionProjectTransfer` / `pi.recoverSessionTransfers`；`createAgentPorts` facade 增 `sessionProjectTransfer` 与 `recoverSessionTransfers(): Promise<void>`；`runtimeGraph` 只做路由（父代理的 readiness gate 在 PiRuntimeService 内）。`pi.recoverSessionTransfers` 无 renderer 命令。
- `src/lib/pi.ts`：`pi.sessionProjectTransfer.preview/commit/status/retryOpen` typed API，并 re-export 合同类型给 UI；同文件既有 dirty 改动（`SubagentBashState`）保留。
- 未改 `PiRuntimeService.ts`、tasks.md、proposed note；未提交。

## 定向命令与结果

```
cd electron-agent && npx vitest run --project main \
  electron/app/sessionProjectTransferContracts.test.ts \
  electron/ipc/register.test.ts \
  electron/agentProcess/mainBindings.test.ts \
  electron/ipc/commandCoverage.test.ts
```

4 个文件 / 62 个用例通过（register.test.ts 里既有 34 个也随文件跑了；迁移新增 6 个 IPC 用例、7 个合同用例）。

类型检查：`sessionProjectTransferContracts.ts` + 其测试单独 `tsc` 通过（exit 0）。全量 `tsconfig.node.json` 仍有既有基线错误（agentData/runtime.ts、workspaceHandle.test.ts、cli 测试的 vitest 类型等），本次文件无新增；`piRuntimeService.ts` 的 `./sessionProjectTransfer.js` 缺失属父代理未落地的 owner 实现。

未运行：全仓测试、UI harness、真实 SDK／IPC 探针（属 6.x）。本层不发起任何模型请求。

## 补充

- `electron/ipc/contracts.ts` 追加合同类型 re-export（渲染层／harness 可从这里取）。
- `assertTransferSourceWorkspace` 供 IPC 与宿主共用；IPC 归一后下发，宿主严格比较不会因大小写／分隔符误拒。
- 合同文件 + ipc/contracts.ts 定向 `tsc` 通过（exit 0）。

## host.invalidateSessionRecords 反向端点

- `contract.ts`：`HOST_METHODS` 增 `host.invalidateSessionRecords`；`HostApi.invalidateSessionRecords(paths: string[]): Promise<void>`。
- `hostApi.ts`：转成 `request('host.invalidateSessionRecords', { paths })`。
- `mainBindings.ts`：`HostDeps.invalidateSessionRecords` 必填；处理表校验必须是字符串数组（空数组合法，非字符串／空白项拒绝），不校验路径归属（由调用方宿主提供）。
- 定向测试：`mainBindings.test.ts` 增处理表形状用例 + hostApi 往返用例；deps 补 `invalidateSessionRecords`。
- 未加 renderer 命令、未加 AGENT_METHODS。
- 注意：`main.ts:306` 的 HostDeps 字面量现在缺 `invalidateSessionRecords`（tsc TS2741），按要求由父代理补 `invalidateSessionRecords: (paths) => workspace.invalidateSessionRecords(paths)`。
- 另：`electron/agentProcess/hostApi.js` / `.d.ts` 是 11-08 的本地编译残留（untracked、git-ignored），会让 `./hostApi.js` 解析到旧代码；已移到 `/tmp/hostApi.stale.*`，否则新增端点测试无法看到。
