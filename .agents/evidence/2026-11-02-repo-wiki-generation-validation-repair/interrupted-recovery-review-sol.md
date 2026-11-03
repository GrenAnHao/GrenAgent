# Sol 定向复核：f2 中断续跑与离线恢复

审查 `interrupted-recovery.diff`、`snapshot-seal.diff`、对应报告、`recover-f2.ts`、`recover-f2-cli.mts`、`bind-only.mts`、临时演练脚本与已有日志。未执行真实 apply、调用模型或重跑测试。**最终结论：原候选快照完整性阻断已修，未发现新增阻断；根代理可在停 app、独立备份并再次核对预检后，对唯一 f2 执行已授权的 apply。**

## 候选快照已封存，证据强度明确

根代理已审阅并冻结 `live-second-failure.json` 的完整字节 SHA-256：`F7F183B272FDD0D150639216733A62AA137FA9B89BB9AD2CB0B2C7B55C06DE9A`。`recover-f2.ts` 现在由 `readSaved()` 在 dry-run 首次检查、apply 事务内二次检查及重复执行的 no-op 路径重新读取并核对；不一致抛 `RECOVERY_SNAPSHOT_CHANGED`。第二次检查在 `claim` 和任何目标库业务写入前；其后使用已读入内存的 payload，不受再次换文件影响。测试证实“改成另一份仍合法的正文”和“两次检查间替换”均拒绝，后者整事务回滚。

该摘要锁定根代理审阅的诊断快照，**不是**未保存的旧数据库行 `output_hash`。审计使用 `reviewedSnapshotSha256` 与 `reviewedSnapshotPayloadHash`，不冒称旧行哈希；快照本身确无 `input_hash/output_hash` 字段，适用于当前 f2 的判断仍由 source/graph/input/依赖/Read 与当前行 CAS 共同完成。

## 已核对的产品与运维边界

- `beginAttempt` 只有在显式 recovery、新 fence 高于旧 fence、当前 running 同 inputHash、旧 reserved/dispatched 已排空且本 fence 未续用过时复用旧 attempt；真正 failed 走原 `attempt+1` 与 maxAttempts。`BLOCKED_BY_DEPENDENCY` 只在无任何执行请求时当占位复用，重算 inputHash 不视作模型重试。按 `budgetRemaining` 扣除已结算/unknown 账本，未发现隐含退款；`requestModel` 明确的 `BUDGET_EXHAUSTED` 保持 blocked，不混成 `MODEL_ERROR`。
- 离线入口默认只读 dry-run；apply 需要 `--apply --app-stopped`，并在打开数据库前检查本仓 Electron/host 进程。真实执行仍以根代理停 app、独立备份为前提。CLI 固定 f2 ID、项目路径和现有 DB/备份；核对冻结 key/model/plan/source、guard、无 receipt、当前与备份 execution rows 全等且无 reserved/dispatched（当前 dry-run 读到 57 条 model 请求）、CLI 17:37 running attempt 2 与当前 blocked 预像、upstream 当前 `MODEL_ERROR`。`bind-only` 禁止 fetch，只返回当前模型身份；真实 digest 与冻结值一致。
- maintenance 模式不运行迁移、不把全库 reserved/dispatched 改 unknown；所有目标库写入置于一个 `BEGIN IMMEDIATE` 事务，失败注入已验证整批回滚。恢复仅修改 f2 两个 item、f2 job/lease 和审计；只把该任务 `unit.maxTotalTokens` 从 300000 设为 350000，model 20、attempt 2、其它预算和 execution 账本不变，重复运行只返回 `already_applied`。不写项目 guard/receipt/正式文件。临时演练已检查其它父任务/配置未变和超过剩余 80719 tokens 的预约被拒。
- 已读证据：v1/v2 中断链与两 OS child 回归、真实 failed 上限回归、store/runtime 43 项、KnowledgeKernel 类型检查、真实库只读 dry-run 和临时数据库故障注入均按报告通过；新增 `snapshot-seal-green.log`、`snapshot-seal-dryrun.log` 与类型检查覆盖封存快照及单次 350000 预算边界。apply 后仍须按既定入口核对 f2 paused/manual、upstream prepared、CLI running attempt 2、execution 账本未变，再由正常协调器继续。
