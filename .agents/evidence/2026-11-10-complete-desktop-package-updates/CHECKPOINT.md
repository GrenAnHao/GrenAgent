# D 安全检查点（用户收敛范围后）

2026-11-10：用户已明确批准“本轮收敛，包更新留后续”；停止本轮扩展 D，保留未启用检查点。没有删除任何既有或用户代码，没有提交 / 推送 / 发布，没有真实包更新或正式应用重启。

## 当前可保留的 atomic 工作

- `packageUpdateStage.ts`：journal 升到 v2，记录 rename / config 意图与完成子步骤；修复 switching 已落盘但首次 rename 未发生时的恢复误报，fromRecord 先做运行时字段 / 状态 / 布尔校验。对应测试 7/7 通过。
- `packageConfiguration.ts` + 最小 `proper-lockfile.d.ts`：公开 SettingsManager.fromStorage，在与 SDK 相同的 settings.json.lock、realpath:false / mtime 协议下只 CAS 目标 entry，flush / drainErrors / 读回，保留非目标 entry / 其他 scope / 其他字段。3/3 通过；跨真实进程的完整故障矩阵还没做，不能把它称为完整事务。
- `packageSdkStage.ts`：官方 SDK install 在同卷完整 npm scope 或 git checkout 隔离布局准备；检查精确目标、非目标直接版本、git dirty，披露依赖变化。5/5 临时 fake registry / local git 真实 SDK 测试通过，覆盖 user/project、脚本失败保留 live、固定 commit 和 mutable target 拒绝。
- `piPackageMetadata.ts`：静态说明增加类型 / 大小 / 读取超时 / 越界原因，仅返回受控 text；9/9 对应测试通过。
- `packageMetadataReadonly.integration.test.ts`：native npm metadata 查询不下载 tarball、不改 tree / entry、不运行生命周期脚本，1/1 通过。
- `packageUpdateContracts.ts` / `package-updates-contract.md`：配置 pin、磁盘版本、运行时代次分离的 DTO / 状态定义，尚未接 UI / IPC。
- 用户批准的外部边界已同步 proposal / design / spec / tasks / 原 proposed note，strict validate 通过：不迁移共享目录；新 update/repair 每次要求外部 Pi/CLI 退出且期间不启动，桌面自动保护仅本应用可枚举消费者。没有把这个前提注入生产 Known=true，也未改旧入口参数。

新增 proper-lockfile 精确依赖 4.1.2 只做 offline / lock-only / ignore-scripts；pnpm/npm 锁同步，npm lock 仅 packages[''] 变化，SDK pin 未改。没有联网安装类型，使用最小公开 API 声明。

## 为什么这是安全检查点，而非已完成包更新

新 stage / CAS / DTO 模块尚未接应用更新入口。没有 apply IPC、没有自动调用，没有运行时切换路径，所以不会在用户打开面板时更新包。只读 snapshot 仍是已有基础。所有新增真实安装测试均限临时假 registry / 本地 git、无害计数脚本；测试服务和临时目录已收尾。

OpenSpec 仍是 **3/28 已勾、25 未勾**。上面通过的是基础部件，不把未联通的原语当作完成完整任务。

## 剩余关键块 / 规模

这不是几项收尾，仍有五个主要实现块：

1. 主进程 preview / upgrade / repair 操作编排、不可变授权、整单元锁（含旧 mutation 入口）、legacy global 路径和 scoped 配置提交联通。
2. 完整持久化操作记录、跨进程故障点、启动 resolve 前恢复、Windows 文件占用和恢复文档。
3. 桌面全部相关 handle / worker / 进程的可信枚举、busy / 新回合 / open / reload 门、安全进程重建与真实逐代回执；共享进程里有不共享项目则须明确拒绝，不可任意重载。
4. 真实 ExtensionsPanel 包列表 / 详情 / 确认 / 进度 / 恢复 UI，IPC / bridge 接线及 package-updates harness。
5. UI→IPC→SDK stage→配置→runtime 的故障恢复集成、真实生产路径和最终类型 / notes / strict 门禁。

另有 SDK 行为已知约束：默认 desktop / Gren CLI / 裸 SDK 都共享 ~/.pi/agent/npm；AgentProcessClient.shutdown 永久 stopping 且超时会 killTree，不可直接用作安全可重建更新。必须有上述运行时编排后才能声明可安全更新。

## 证据 / 恢复位置

- root 既有交接：本目录 `HANDOFF.md`（描述最初 3/28 基础）。本 CHECKPOINT 补充接手后的实际状态，不删除旧证据。
- 本轮红灯：`stage-journal-red.log`、`settings-array-cas-red.log`、`changelog-bounds-red.log`、`sdk-stage-red.log`。
- SDK stage 绿灯：`sdk-stage-first.log`（5 PASS）；其他 7 / 3 / 9 / 1 的原始结果在本 agent 工具记录，未伪造全量验收日志。
- 修改前快照：`owner-preimage/`，包括依赖锁修改前状态。
- Note：`.agents/notes/proposed/feature/2026-11-10-desktop-package-update-recovery.md`，保留 proposed，未假称完整 implemented。

恢复开发先读本文件与完整 OpenSpec apply context，按 sourcePath/line 逐项验收勾选；不要重做已有安全原语，也不要跳过尚未联通的运行时/授权/恢复工作。
