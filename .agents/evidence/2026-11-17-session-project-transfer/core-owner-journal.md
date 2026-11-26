# Session project transfer — core owner + journal + runtime integration

只在真实文件引擎 / 真实 SDK 上验证：不启动用户程序、不扫描真实会话、不访问远程模型。所有 fixture 都是临时 `agentDir` + 临时项目目录。

## 交付文件（本人负责）

| 文件 | 作用 |
|---|---|
| `electron/app/sessionProjectTransfer.ts` | `SessionProjectTransferOwner`：来源/目标校验、族闭包（catalog + registry + metadata 逆向）、fingerprint、事务、回滚、向前恢复、lease 屏障 |
| `electron/app/sessionProjectTransferJournal.ts` | 版本化 journal（`manifest.json` / `before.json` / `after.json` / `registry.json`）、原子写 + flush + rename、故障注入、只读探针 |
| `electron/app/sessionProjectTransfer.test.ts` | 21 个 owner/验证/闭包用例 |
| `electron/app/sessionProjectTransferRecovery.test.ts` | 20 个 journal/故障矩阵/恢复用例（本轮只读取；matrix 由父代理扩充） |
| `electron/app/sessionProjectTransferLeaseLoss.test.ts` | 12 个 lease 失锁 + 准备并发用例 |
| `electron/app/sessionProjectTransferRuntime.test.ts` | 7 个真实 SDK runtime 集成用例 |
| `electron/app/sessionProjectTransferRuntimeLoopback.test-helper.ts` | 127.0.0.1 loopback OpenAI-completions mock（可延迟回复以观察真实 streaming） |
| `electron/app/sessionProjectTransferFixture.test-helper.ts` | owner 层真实 JSONL / 假 registry / 假 writers / 假 activity |

定向结果见 `core-owner-journal-vitest.log`：**4 个文件、103 passed、0 failed**；`tsc -p tsconfig.node.json --noEmit` 对 `sessionProjectTransfer.ts` / `sessionProjectTransferJournal.ts` 零错误。

## 本轮确认的五个 race / 边界修复

1. **v1 会话走同一 canonicalizer**（不缩范围）：`sessionTransferVersion` 明确接受 1/2/3（缺失按 1），未知版本 fail-closed；v1 由 `readTransferSession(raw)`（history agent 的唯一算法：sha256(raw+index) + header→2）给出 ID/parent/leaf，原本有 id 的保留。before 仍是 raw 字节快照；after 的保真检查按 canonical 逐位置比对（只允许新增 `id`/`parentId`），v3 仍 byte-exact，v2 的 `hookMessage→custom` 视为两侧同一 canonical。core 惰性 import，缺 canonicalizer 时明确 `SESSION_TRANSFER_CANONICALIZER_UNAVAILABLE`。
2. **metadata 逆向闭包**：除 catalog 事实与全量 registry 行外，托管 JSONL 里 `origin==='subagent'` 且父指针命名族内成员的 `subagent_meta` 也作为发现边（可递归到孙级）。`header.parentSession` 仍只做交叉校验——只有 header 的 visible fork/clone 不会被拉入。无法证明结算则整次拒绝（`UNSETTLED`/`UNPROVEN`），不静默漏族。扫描只解析含 `subagent_meta` 的文件，坏文件不阻塞无关迁移。
3. **失锁后不写 journal**：`assertOwned` 在 commit 入口、release 后 CAS 前、每个日志替换前、registry apply 前、committed 决定前、opened 回执前都调用。一旦失锁立刻停止会话/registry/journal 写，只抛出 `TRANSFER_RECOVERY_REQUIRED`；不回滚、不覆盖新 owner 的终态。lease owner token 带实例 id，两个进程不会误判为可重入。
4. **terminal 旧操作不重放**：`opened`（含 opened rename 后崩溃留下的快照）与 `rolled-back` 在任何 family lock / 文件 / registry 校验之前直接返回原事实，只 GC 私有快照。旧 opened 不会因后续 B→C 移动或 header 改写被降级、也不会重放过期 registry。
5. **准备与清理的跨进程互斥**：`savePrepared` 全程持有 per-operation 的 prepare sentinel lease（不是项目停机）；恢复端遇到无 manifest 的 shell，必须先取得同一 sentinel、**重读**确认仍未完整才删除；若并发写者已产出 manifest 则完全不动。

## 真实 SDK runtime 验证（`sessionProjectTransferRuntime.test.ts`）

用生产 `AgentHost` + `createWorkspaceHandle`（真实 `createAgentSessionRuntime`、真实 JSONL、真实 `.pi/rules`、真实项目 registry SQLite）与 loopback 模型：

- 迁移后会话 ID / 物理路径 / 确认 leaf 不变，历史行 byte-exact，只有 header cwd 改为目标；迁移过程模型请求数 **0**。
- 源项目无法再切到该路径（`SESSION_WORKSPACE_MISMATCH`），真实 target handle 持有同一身份与路径。
- 目标项目另一个忙碌会话不被驱逐/替换，移动以 additional handle 打开。
- model / thinking / Fast 保留；目标无本地授权时 mode→`ask`、approval→`readonly`，不继承源 `full`。
- 下一次显式请求才注入目标规则（含 `TARGET_ONLY_RULE_TEXT`，不含 `SOURCE_ONLY_RULE_TEXT`），且只发一次请求。
- 目标 runtime 打开失败返回 `committed-needs-open`，`retry-open` 幂等补登记并打开，不重跑迁移、不重复写迁移条目。
- 源回合真实 streaming 时 preview 返回 `busy/turn-active`，任务不被取消、会话不移动。

## 未覆盖 / 依赖他人

- 生产 `buildAfter`（history 段）、`openAdditional`、usage 定位、UI/route、任务 2.3 闸门接线由父代理/其他 agent 提供；runtime 测试按其真实端口形状接线，未改 `PiRuntimeService`。
- 未运行 UI harness、未跑全仓；不勾选任务、不提交。
