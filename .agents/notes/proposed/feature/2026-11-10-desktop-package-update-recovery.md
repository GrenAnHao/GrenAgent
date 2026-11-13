# Agent Note: 桌面包更新使用隔离准备和安装单元恢复

Status: proposed

## Problem

用户批准执行 `complete-desktop-package-updates`。现有 Pi 包服务有安装、移除和启停后端，但桌面没有包视图，精确 npm pin 会被官方 update/check 跳过。SDK 安装会原位修改共享 npm root 或 git checkout，广播重载的 boolean 也不代表实际加载成功。

## Proposal

- 复用 SDK 1.5.1 官方安装器，在同卷隔离 stage 准备明确获批的 npm 版本或 git commit，不实现另一套依赖解析器。
- npm 的切换、备份和消费者栅栏按整 scope root，git 按 checkout；非目标直接包版本或作用域不得改变。不能完整枚举或安全隔离应用内消费者就拒绝切换，不靠删除旧安装重试。
- 配置 pin、磁盘版本、运行时代次分别回显；更新与修复分开授权，只有真实资源回执通过才标完成。
- 检查只查询静态元数据；说明限定包根并安全渲染。恢复只保证本次受管安装/声明及已验证运行态，不能回滚第三方脚本的外部副作用。
- 维护 scoped entry 和操作恢复记录，不用整份旧 settings 回写覆盖并发用户修改；不改变旧广播 boolean 的使用契约。

### 恢复记录的具体约束

包 DTO 的配置目标 / 磁盘实际版本 / 运行时代次分开，含 previewId、operationId、整安装单元及逐消费者回执，契约见 electron-agent/electron/app/package-updates-contract.md。

恢复 journal 使用 version 2，持久化 rename / 配置提交的意图与完成子步骤；重启结合可信目录实际存在状态判定首次 rename 尚未发生或已恢复，不靠 coarse switching 推断 backup 必须存在。fromRecord 先做字段 / 状态 / 布尔 schema 校验，再以主进程可信根重新派生 stage / backup 路径，未校验记录不进入恢复。

### 用户批准的共享根边界

桌面 / Gren CLI / 裸 SDK 的默认 user 根同为 `~/.pi/agent/npm`，project 根为 `<cwd>/.pi/npm`。用户选择保留共享目录，不迁移。每次新 upgrade / repair 确认须由用户明确声明外部 Pi / CLI 均已退出且期间不启动；外部不受桌面自动枚举或门控，声明缺失 / 撤回则不准备或切换。桌面强制保护本应用内完整可枚举的 handle / worker / 进程，未知应用内范围仍拒绝；旧 install/remove/setEnabled 的参数和原契约不加这个用户前提。

配置 CAS 采用公开 SettingsManager.fromStorage 与窄自有 SettingsStorage，显式 pin proper-lockfile@4.1.2；与 SDK 对 settings.json 使用相同的 `.lock` 目录、realpath:false 和默认 mtime / stale 协议。不导入未导出的 FileSettingsStorage，不用旧 packages 数组覆盖外部新声明。

## Historical review

[扩展工作台](../../implemented/feature/2026-10-31-extension-workbench.md) 部分重叠：复用原四页布局和草稿保留，不替换 MCP/技能/命令/规则。[打包约束](../../implemented/architecture/2026-09-11-packaging-constraints.md) 部分重叠：保留 CJS 字节码、实际外部资源路径和原生模块边界。未找到同主题已否决的包更新提案，本篇不取代两篇旧决定。

## Alternatives considered

- 直接调用 SDK update(source) 最短且能复用官方进度；不采用，因为精确 pin 被跳过且同 identity 可能同时命中 user/project，无法兑现单作用域升级。
- 原位 installAndPersist 后失败再装旧版本，代码较少；不采用，网络/脚本失败可能已损坏旧安装，不能作为恢复承诺。
- 自写 npm/git 安装逻辑更容易控制路径；不采用，重复依赖解析和脚本语义成本高，用官方 SDK 加最窄隔离编排。

- 迁到应用独立根能避免裸 SDK 共用，但会改变既有 CLI 共享路径与声明解析；用户不选择，保持当前共享目录并明确外部退出前提。
- 只在写前读一次后调用 SDK setPackages 更短；不采用，因为其写回整个 packages 数组，写后比对无法恢复已覆盖的非目标声明。

## Acceptance criteria

按 OpenSpec 的 28 项任务和规格验收：真实 SDK 假 registry/git fixture、作用域/pin保留、无执行检查、stage/恢复故障注入、全安装单元消费者回执、真实包 UI 和生产路径；不能用 mock 或构建 exit 0 替代运行验收。

## Risks

工作区有大量既有改动和遮挡 TS 的旧生成 JS，只备份本次目标。跨 change 共享 IPC/运行时入口按 root 调度串行合并。测试不操作真实包/凭据，不启动正式应用；当前阶段不提交、发布或归档。
