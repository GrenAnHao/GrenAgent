# TencentDB 个人记忆空间设计（已取代）

本设计中的迁移、双后端切换和旧数据回滚方案已废止。项目处于开发阶段，当前决策是直接以 TencentDB 作为长期记忆、Skill、Wiki 和 CodeGraph 的唯一真源；不读取、不迁移、不兼容旧数据，也不提供旧后端回退开关。

唯一保留的是 `session-memory`，它只维护当前会话的短期工作状态。当前有效设计见 [TencentDB 托管运行时与全面切换设计](./2026-08-17-tencentdb-managed-runtime-cutover-design.md)。
