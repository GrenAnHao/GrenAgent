# 任务 3.1/3.2 证据：完整日志、目录来源与 cwd 层

日期：2026-11-17。范围：纯数据层（历史 after-image builder、共享迁移 metadata／有效 cwd／逐引用来源、cwd 恢复 helper 的重放语义）。
不包含：渲染接缝（由 sa-56662d77 负责）、owner/journal 接线、模型注入 factory（父代理负责）。

## 交付文件

| 文件 | 作用 |
| --- | --- |
| `electron-agent/electron/app/sessionProjectTransferHistory.ts` | 迁移专用 parser `readTransferSession(raw)`（v1 确定性补 ID／父链／compaction 引用、v2 经 SDK 内存升到 v3、v3 严格校验并接受精确形状的 legacy 无 ID 标题行为 `opaque`）+ 纯函数 `buildTransferredSession(raw, input)`：保持 header ID/path、逐字节保留原历史行、追加版本化 `session_project_transfer` + 目标 `working_directory`（+ 可选 preferences／child `subagent_meta`）；返回 `{raw, metadata, provenance, appendedEntryIds, leafId, alreadyApplied, beforeSha256}` |
| `electron-agent/electron/app/sessionProjectTransferHistory.test.ts` | 真实 SDK `SessionManager.inMemory` 夹具；多分支、标签、压缩、思考签名、未知字段、null-root、幂等、确定性、旧 v2 迁移、子会话 meta、保留根累积、逐引用来源与有效 cwd |
| `extensions/_shared/session-project-transfer.ts` | browser-safe 纯函数：metadata 解析、`latest/read`、`readLatestTransferNotice`、`effectiveProjectRoot`、`effectiveRecordedCwd(entries, headerCwd, leafId?)`、`buildEntryRootProvenance`、`entry/referenceSourceRoot`、`historyTransferSources` |
| `extensions/_shared/session-cwd.ts`（定点） | `attachSessionCwd` 对迁移会话改用 `effectiveRecordedCwd`（按当前 leaf 的父链），旧 `working_directory` 不再把会话拉回源项目；未迁移会话走原 `recordedCwd` |

## 关键不变量

- header 只改 `cwd`；`id`/`timestamp`/`parentSession`/未知 header 字段保持。历史行（含全部旁支、原 entryId、label、compaction、context_edit、思考签名、未知合法字段）逐字节保留。
- 追加条目 id 由 `operationId + index` 确定性生成（`transferEntryId`），同一 before 镜像重试得到同一 after-image，配合 journal hash 与幂等回执；已含该 operationId marker 时 `alreadyApplied=true` 且 `raw` 不变。
- 确认 leaf 只回传、不写入：追加 custom entry 在物理末尾，但 `metadata.leafId` 保持原确认值（含 null 根）；`boundary.entryCountAfter` 记录批次末尾，便于 journal 复核。
- `retentionRoots` 累积旧 marker 的根，并至少包含本次 `fromWorkspace`（与 header cwd）；`boundary.entryCountAfter` 记录本批次追加后的条目数。
- 输入日志的换行风格（LF/CRLF）原样保留，追加行沿用同一风格；尾部空行不写入 after-image。
- 子会话：自动检测最后一条 `subagent_meta`，只把托管项目字段（`workspace`/`cwd`/`projectCwd`/`projectRoot`/`projectRootPath`）改成目标，其余字段（agentId、父路径、mode、结算状态等）继承；旧 meta 行保留。
- 逐引用来源：每个 entry 的根沿自己的父链求值（迁移 marker / `working_directory` / 持久 toolResult `details.cwd|path`），旁支互不继承；引用键 `entryId + toolCallId + 字段`；已有映射先出现先用，二次迁移不覆写。
- 矛盾来源拒绝：旧 marker 快照与本次回放（以及多个旧 marker 之间）若同一 entry 根或同一引用根不一致，抛 `TRANSFER_PROVENANCE_CONFLICT`，不静默 first-wins。正常往返两者一致。
- 旧 `working_directory` 恢复：迁移会话只读最后 marker 之后、且位于当前 leaf 父链上的记录；否则落到目标根。旧会话行为完全不变。
- 版本兼容：v3 原行逐字节；v2 只做 hookMessage→custom 的 SDK 内存迁移后再写 v3 after-image；v1 全文件无 ID，按 `sha256(raw+index)` 确定性赋 canonical ID 与线性父链，compaction 的 `firstKeptEntryIndex` 按 SDK 口径（含 header，0=header）换成条目 ID，不依赖 SDK 随机 ID。源文件不写盘。
- legacy 标题行：`WorkspaceService.setSessionDisplayName` 直写的 `{"type":"session_info","name":…}`（无 id/parent/timestamp）在迁移 parser 中作为 `opaque` 接受，v3 after-image 原字节原位置保留、目标最新标题仍生效；形状不完全一致的无 ID 行仍拒绝。全局 `strictSessionJsonl` 与 WorkspaceService 重命名行为未改。
- `retentionRoots` 还并入 provenance 的全部 entry 根与逐引用根（例如历史曾 `working_directory` 到另一个 works/scratch 的 E 盘目录），避免源 scratch prune 删掉仍被历史引用的生成文件。

## 命令与结果

```
cd electron-agent
npx vitest run electron/app/sessionProjectTransferHistory.test.ts electron/app/sessionProjectTransfer.test.ts \
  electron/app/sessionProjectTransferRecovery.test.ts electron/app/sessionProjectTransferContracts.test.ts \
  electron/app/sessionProjectTransferPolicy.test.ts electron/app/sessionProjectTransferActivity.test.ts \
  electron/app/sessionProjectTransferMainGate.test.ts electron/app/sessionProjectTransferBlocker.test.ts \
  electron/app/sessionWorkflowData.test.ts electron/app/workspaceServiceTransfer.test.ts \n  electron/app/usageServiceTransfer.test.ts --project main
# 11 files / 172 tests 通过 → task-3.1-3.2-history-vitest.log
# （含矛盾来源拒绝、旁支 cwd、批次边界、CRLF 保真、workspace 保留根与 usage 分组）

cd extensions
npx vitest run _shared/session-cwd.test.ts _shared/session-transfer-source.test.ts
# 2 files / 10 tests 通过 → task-3.2-session-cwd-vitest.log

cd electron-agent
npx vitest run src/features/chat/sessionCwd.test.ts --project renderer
# 1 file / 14 tests 通过（未修改该文件，确认既有行为不变）

npx tsc --noEmit --ignoreConfig --target ES2022 --module ESNext --moduleResolution bundler --strict --skipLibCheck --types node \
  electron/app/sessionProjectTransferHistory.ts electron/app/sessionProjectTransferHistory.test.ts \
  ../extensions/_shared/session-project-transfer.ts
# 无诊断
```

## 已知边界／未验范围

- 未跑全仓测试；未跑 UI harness（渲染接缝不在本任务）。
- 迁移后的真实 runtime 打开、位置存储写入、journal 提交由 owner 层负责；本任务只保证 after-image 可被迁移专用 parser（树行走同一套严格校验）接受，并能被 `SessionManager.open` 正确重放 leaf（测试里用真实 SDK open）。整文件含 legacy 无 ID 标题行时，全局 `strictSessionJsonl` 会按设计拒绝；那类文件由 `readTransferSession` 判定合法性。
- `sessionWorkflowOwner.test.ts > detached raw history...` 为既有 5s 超时失败，与本改动无关（未触碰 `sessionWorkflowOwner.ts`／`piRuntimeService.ts`）。
