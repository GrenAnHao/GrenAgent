# 会话跨项目迁移：本族子代理登记 / 活动 / drain 适配验收

任务 3.3 的定向证据。父代理已把会遮蔽源码的旧 `.js` / `.d.ts` 同级产物隔离到仓库外
（清单见同目录 `stale-source-siblings.json`），所以下面是**正常配置**（不需要 `source-first.mjs`）。
未提交、未勾 tasks；不跑真实用户会话、不请求模型。

## 命令与结果

扩展侧（在 `extensions/`）：

```bash
npx vitest run multi-agent/session-project-transfer.test.ts multi-agent/session-operation-guard.test.ts \
  _shared/session-project-transfer.test.ts multi-agent/registry.test.ts \
  multi-agent/activation.test.ts multi-agent/adjacent-tools.test.ts multi-agent/worker-session.test.ts
```

见 `adapter-tests.txt`：7 个文件、167 项通过。

宿主侧（在 `electron-agent/`）：

```bash
npx vitest run electron/app/subagentService.test.ts electron/app/subagentService.transfer.test.ts
```

见 `subagent-service-tests.txt`：2 个文件、21 项通过。

定向类型检查（只 grep 本任务改动的文件，不修无关基线错误）：

```bash
cd electron-agent && npx tsc -p tsconfig.node.json --noEmit | grep -E \
  "session-project-transfer|session-operation-guard|subagentService|multi-agent/activation\.ts|multi-agent/registry\.ts|adjacent-tools|multi-agent/worker-session\.ts"
```

无输出。既有基线错误（`electron/agent/workspaceHandle.test.ts` 的 mock 类型、
`extensions/multi-agent/worker-session.test.ts` 里旧宿主 payload 一例）不是本任务引入，未处理。

## 覆盖的行为

- registry 记录级差异：全量无 limit 读、`parentId` + 子会话文件名 sessionId 闭包；族指纹
  `transferRegistryRowsHash`（按 id 排）与 core journal 的 `sha256Text(stableJson(rows))` 逐字节一致；
  `transferRegistryRowsHashInReadOrder`（读库顺序）对应 core 的 `expectedTargetHash`。测试直接 import core helper 比对。
- 未结算拒绝：`running`、`waiting-for-bash`、`stopConfirmed !== true` 的登记行不参与迁移，终态原样保留。
- 目标冲突拒绝且双方都不被覆盖；目标项目其他会话记录不受影响（同一夹具里放了 `sa-other`）。
- 正/反向 CAS 都在事务内重读：源 DELETE 前逐项 + 整体指纹复核；目标 insert 前重读同名行判冲突；
  rollback 只删本操作插入过的行（`session_transfer_registry_inserts` 标记表，格式与理由在代码注释里），
  并回读完整族验证源侧恢复。目标原本就有的相同行不删也不重建。
- apply 失败回退只清「真正删掉」的插入标记；被外部 writer 改过的行保留标记与行本身，
  后续内容恢复后 rollback 仍能收口（定向测试覆盖，避免源目标各留一份同 id）。
- 幂等：重复 apply 返回 `{applied:false}`；重复 rollback 不重复补行。
- **异步 drain + quarantine**：`drainTransferFamily` 返回 `Promise<{drained, busy, diagnostics}>`，
  对每个驻留子会话 `await disposeResidentForTransfer`：
  - 进程内会话：同步 dispose 成功才确认；抛错 → `confirmed:false` + 可见 quarantine（不吞错）；
  - worker 后端：等 `WorkerSessionProxy.disposeAndWait` 的 `dispose` RPC 回执或进程退出才确认；
  - 超时 / worker 报错 → 该 id 进 `busy`、留在 retiring 隔离区，`residentChildIds` / 活动检查 /
    后续 drain 都继续把它当活写者（不会因为「不在驻留池」就默认成功），直到迟到的 ack / `disposalConfirmed`
    / 进程退出证明收口；
  - 不解用户任务（走与普通 settle 相同的 graceful 收口），不写 `tornDown`、不发通知、不碰其他 resident。
  - 定向测试证明旧 worker 的 dispose 回执在 registry 写入之前：事件顺序
    `dispose:sent → dispose:confirmed → registry:apply → registry:applied`，中途源库仍是原行。
- core 端口适配：`transferRegistryPort.({read,apply,rollback})`、`transferActivityBusy`（映射为
  `subagent-unsettled`）、`transferFamilyRefs` 有定向断言。
- 活动检查：空闲族通过；运行中登记行 / 隔离区写者 / 空族 / 缺失路径拒绝。
- 读闸门：只隐藏被阻塞族的行 / 历史 / catalog 项，同项目其他子代理照常可读；快照损坏时 fail-closed 抛
  `SessionOperationGateUnknownError`（不返回空集合）。
- 冷恢复（子会话）：迁移过的会话按目标项目加载资源与域、恢复迁移前确认 leaf（含 null 根）；
  迁移后已续聊过则不回退；未迁移会话行为完全不变。

## 未覆盖 / 留给其他任务

- 真实 runtime / IPC 端到端（任务 4.x、6.x）与 `PiRuntimeService` 接线（父代理负责；guard / read gate /
  blocked snapshot 的 install 在 runtimeGraph，`drainTransferFamily` 由父在 release 前 `await`）。
- UI 场景（任务 5.x）。
- 本轮没有修改 `PiRuntimeService.ts` / `WorkspaceService.ts` / Contracts / 菜单 UI / tasks / note。
