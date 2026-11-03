# f2 中断续跑与受控离线恢复交审

## 状态与授权

真实 f2 仍 blocked，现有 upstream 原候选在 17:35 旧运行时被覆盖；CLI 在 17:36 被暂停，17:40 因误算 attempt 3 而 blocked。备份 `runtime-backup-resume.txt` 指向的 17:37 SQLite 中 CLI 为 running、attempt 2、同 inputHash、payload/error 为空；`live-second-failure.json` 是 17:15 upstream 原始 INVALID_PAGE_LINK 候选。用户授权仅此 f2 的 unit.maxTotalTokens **300000 → 350000**，其余预算、attempt 和全部已用/unknown 账本不变。未对真实库执行 apply，未调用模型。

## 产品修复

- 恢复上下文由协调器传入旧 fence；已取新 fence、旧运行已排空、inputHash 相同的 running 项续用原 attempt。每个新 fence 的续用写审计并禁止重复，reserved/dispatched 未排空时拒绝。一般派发不启用此条件；真正 failed 仍消耗新 attempt 并受上限约束。
- 从未有执行请求的 `BLOCKED_BY_DEPENDENCY` 占位项复用原编号；依赖完成后允许重算 inputHash，不减少既有执行编号和账本。
- `requestModel` 明确抛出的 `BUDGET_EXHAUSTED` 作为 fatal/blocked 传播，其他 provider 错误仍只保留安全码。
- `KnowledgeBuildStore` 的 maintenance 模式仅供离线脚本，跳过启动时全库 reservation 对账；`maintenanceTransaction` 将恢复、现有 fenced candidate 晋级、预算改动、审计和释放封装在一个 SQLite 事务，任何异常全回滚。没有新增管理 RPC。

## 核验结果

- `interrupted-recovery-red.log`、`interrupted-chain-red.log`：复现第二 attempt 中断后错误触发第三 attempt，及模型预约预算错误误记为 MODEL_ERROR。
- `interrupted-chain-green.log`：v1/v2、带 retryOf 的 repair 链暂停后均以 attempt 2 完成；17 次既有模型记账、269281 tokens 未变，恢复前后均只剩 3 次/30719 tokens。
- `interrupted-real-children.log`：v1/v2 两项经两个真实 OS child、Pi SDK/loopback HTTP，暂停 repair 第 2 次后以 attempt 2 完成，已准备 api 不重发，正式页/来源检查通过。
- `interrupted-core-green.log`：store 和 stage runtime 43 项通过；`interrupted-failure-cap-green.log`：真实 failed 的 attempt 2 再失败仍被上限拒绝；`interrupted-typecheck.log`：KnowledgeKernel 类型检查通过。
- `recover-f2-temp-test.log`：只读选取真实 f2/父任务及 17:37 备份行，复制到两个内存数据库；检查 dry-run、atomic apply、故障注入整事务回滚、预算只改 300000→350000、model/tool/time/attempt 预算与全量 execution 账本不变、upstream 在现有 store fence 下规范化晋级、CLI 原 attempt 2、保存 MODEL_ERROR 到审计、其他任务/配置不变、重复执行 no-op、错误 model/plan/source/guard/publication 拒绝、超 80719 token 拒绝。
- `bind-only-fixture.log`：bind-only 入口用临时模型配置成功且禁止 fetch；根代理的真实 `bind-current.log` 当前 digest 与冻结值一致，无 request/stream。
- `recover-f2-dryrun-current.log`：当前真实库只读 dry-run 成功；新源码快照、计划、当前 guard、无 publication、已结算 57 model 账本、备份 CLI 和 saved upstream 条件均通过。`recover-f2-process-guard.log`：app 仍在运行时 apply 被进程检查拒绝，未打开目标库。

## 根代理执行入口（复核通过后）

从 `electron-agent` 目录执行；先取得新鲜可信 model digest（只 bind，禁 fetch），然后 dry-run。复核通过后由根代理关闭 app、对**当前**数据库作独立可恢复备份，再次 bind/验证或确认模型配置未变，保持项目不变，执行相同命令追加 `--apply --app-stopped`。脚本检测仍在运行的本仓 Electron/host 并拒绝 apply；任何 source、plan、model、guard、receipt、账本或预期状态不匹配均停止。

```powershell
$ev = Resolve-Path '..\.agents\evidence\2026-11-02-repo-wiki-generation-validation-repair'
$env:NODE_OPTIONS = '--experimental-sqlite'
$binding = npx tsx "$ev\bind-only.mts" "$env:APPDATA\electron-agent" | ConvertFrom-Json
$oldBackup = (Get-Content "$ev\runtime-backup-resume.txt" -Raw).Trim()
$argsF2 = @('--db', "$env:APPDATA\electron-agent\agent-data.db", '--backup', "$oldBackup\agent-data.db", '--saved', "$ev\live-second-failure.json", '--root', 'D:\System Dir\Downloads\note-pocock-flow', '--model-identity', $binding.modelIdentity)
npx tsx "$ev\recover-f2-cli.mts" @argsF2
# 完成独立备份、停止 app，确认 model binding 未变且 dry-run 仍通过后：
npx tsx "$ev\recover-f2-cli.mts" @argsF2 --apply --app-stopped
```

apply 成功后 f2 是 manual paused；upstream 为规范化 prepared，CLI 为 running attempt 2（等待同任务恢复），预算上限 350000，已用账本保持。脚本写单条包含授权、旧/新上限与历史错误的审计；第二次执行不会再次增加预算。脚本不修改项目的 receipt/guard 或正式文件；之后正常 coordinator 会用新 fence 再校验模型、源和计划。用户已授权继续同一任务；若新失败或预算耗尽按原约定停止，不重置预算或新开整轮。完成后使用 `verify-published-files.mjs` 只读检查正式文件。

## 文件

- 产品与测试限定增量：`interrupted-recovery.diff`（相对本轮前工作区）。
- 离线脚本：`recover-f2.ts`、`recover-f2-cli.mts`、`bind-only.mts`；临时验证脚本 `recover-f2-temp-test.mts`。这些是本次手工运维证据，不是新 RPC 或长期通用平台。
- 本次真实库未 apply；用户 task/数据库和项目文件未写。

## 诊断快照封存补充

Sol 指出旧候选的数据库 output_hash 当时没有记录；恢复脚本现以根代理审阅的整份 `live-second-failure.json` 字节摘要在 dry-run 和事务二次 inspect 中封存来源。摘要只证明当前快照未被替换，不代表旧数据库 output_hash；详见 `snapshot-seal-report.md`。
