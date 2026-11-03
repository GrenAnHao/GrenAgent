# f2 诊断快照封存：Sol 阻断修复

根代理审阅的 `live-second-failure.json` 整份字节 SHA-256 固定为 `F7F183B272FDD0D150639216733A62AA137FA9B89BB9AD2CB0B2C7B55C06DE9A`。`recover-f2.ts` 的 dry-run 第一次 inspect 和 apply 事务内第二次 inspect 分别重新读取并校验字节；不匹配立即拒绝。已 apply 的幂等 no-op 也校验此快照。此前 source/graph/evidence/依赖、当前及备份行、guard、receipt、budget 与账本校验保持不变。

这个摘要只锁定根代理当前审阅的可信诊断快照，**不是**未保存的旧数据库 `output_hash`。现有 store 晋级需要对快照 payload 计算临时一致性 hash；审计字段明确命名 `reviewedSnapshotPayloadHash`，同时记录 `reviewedSnapshotSha256`，不称其为原数据库 hash。

- `snapshot-seal-red.log`：正文附加有效文字后仍可通过规范化与 strict validator，旧脚本却未拒绝，复现问题。
- `snapshot-seal-green.log`：同样合法但字节更改的快照被拒绝；第一次检查后、事务二次检查前替换快照也被拒；原文件 dry-run/临时内存 DB apply、审计、预算幂等、注入异常整事务回滚、原账本不变和超额拒绝通过。
- `snapshot-seal-dryrun.log`：根代理审阅的原文件摘要核对后，对当前真实库只读 dry-run 成功，57 个 model 账本项未变；使用的是根代理 bind-only 输出身份。实际 apply 前根代理重新 bind 并停 app/备份。
- `snapshot-seal-typecheck.log`：KnowledgeKernel 类型检查通过。`snapshot-seal.diff` 为相对上一轮交审脚本的最小增量；完整脚本仍为 `recover-f2.ts`、`recover-f2-cli.mts`、`recover-f2-temp-test.mts`。

真实用户数据库未 apply，未调用付费模型。旧 output_hash 无法从该快照恢复，也未声称已恢复。
