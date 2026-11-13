# D 包更新执行交接

状态：OpenSpec 28 项仅 1.1/1.2/1.3 已勾（3/28）。其余按完整规格执行；不能用下面基础工具已通过代替整个更新完成。

## 已有源与证据
- `electron/app/piPackageMetadata.ts` 与 `.test.ts`：scoped readonly snapshot、来源解析、npm/git metadata checker、静态 changelog。生产默认 npm metadata 使用 `packageRegistry.ts` 的 native npm view，尊重 SDK npmCommand/当前 registry 配置，不读凭据值；fetch/registry 仅隔离注入 route。显式 prerelease 比较已测；默认稳定版，不自动换 ref。
- `packageRegistry.ts` 与 `.test.ts`：Windows 固定 PowerShell 程序+stdin JSON；UTF8 和引号转义真实 runner 红→绿，命令/参数不拼成脚本。需完成更多边界及服务接入。
- `piPackageService.ts` additive `snapshots()`，旧 list/install/remove/setEnabled 调用未改。读取实际位置/版本/commit，覆盖与 disabled resourceBaseKey 分开。
- `packageUpdateStage.ts` 与 `.test.ts`：单安装单元 stage/copy/rename/backup primitive，配置commit失败强制rollback callback，trusted path 恢复记录、quiescent lease、全消费者确认后清备份。**目前未接 SDK 安装或运行态，不能单独信任为完整事务。**
- `piPackageSdk.integration.test.ts`：真实 SDK 1.5.1，loopback registry + 本地 git，经临时 git URL rewrite 无全局配置；4 测真实 pin/update/无rollback性质。
- 最新基础定向 `primitives-final.log`：5 文件42测通过；SDK fixture 4测在 `sdk-fixture.log`。
- proposed note `.agents/notes/proposed/feature/2026-11-10-desktop-package-update-recovery.md`，按落地更新原文，不重复立同主题note。

## 仍须交付
完整 read OpenSpec proposal/design/spec/tasks，用 apply CLI sourcePath/line 逐项勾并复验。metadata 和 stage 仍需 task2.x/3.x/4.x 的真实 SDK/故障边界，scoped配置CAS、install-unit锁覆盖旧入口、operation状态+恢复、加载前恢复、真实所有消费者枚举/栅栏/重建/回执、IPC/bridge、真实 ExtensionsPanel 包入口和 UI harness、生产入口验收、文档和verify-notes。

## 已知待处理
- Stage journal 目前只写 coarse state；进程在 `switching` 持久化后、首次rename前退出时，hadLive=true但无backup，旧live仍完整，却会被restore视为backup缺失。需要明确持久化switch子步骤/可信磁盘核验后恢复，故障矩阵按真实退出验证，不降低规格。
- fromRecord 需要运行时schema校验后才能用于真实启动恢复，不信任落盘任意字段。recordsDir从host可信配置派生；不能让记录自报授权路径。
- prepare安装后的直接包版本不变/目标精确校验尚未编排；absolute/external symlink拒绝，npm全scope/root含lock，git checkout布局须按SDK隔离stage。
- No backend/UI/runtime orchestrator yet：不要以always-restart/空消费者结果代替枚举和活跃范围验收；外部不可枚举则拒绝，明确范围为空方可下次启动验证。
- native runner只真测Unicode/空格/双引号/脚本样文本，额外参数形式可按实际npmCommand contract测试；不可让参数变脚本。

## 共享与权限
不操作真实包/凭据/模型，不运行付费调用、真实npm install、真实仓库更新/系统全局配置。SDK fixture只临时目录、fake registry/local git，安装脚本仅安全计数器。保持当前SDK pin1.5.1/CodeGraph1.6.2。无commit/push/归档/发布/重启正式app。
492项既有tracked dirty和海量旧生成JS；只改D必需文件。root已将`piPackageService.js`备份到 `%TEMP%/pi-package-updates-20261110`，没有全树清理；D其他新模块无旧JS。不要跑有emit的tsc，noEmit对齐历史baseline169/82，相关新增必须零。
生产构建/harness由root排队。A/B/C共享IPC/runtime入口已基本稳定，D相关新增写入交接后由新D owner协调，一份状态机单owner。root负责总集成/独立review与最终接受，D owner负责完整D设计实施测试和自己的依赖闭环。
