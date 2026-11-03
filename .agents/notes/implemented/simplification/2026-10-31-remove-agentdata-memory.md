# Agent Note: 移除 AgentData 长期记忆与旧数据

Status: implemented

## Problem

用户很少使用 AgentData 长期记忆，自动提炼却持续累积冗长记录，维护和整理成本超过收益。用户选择完整移除 Memory 功能，并明确要求清理旧数据，不归档。

## Decision

移除 Memory 扩展、自动捕获与注入、L0–L3 抽取/去重/场景/画像任务、管理界面、RPC、提示词增强检索和配置。旧数据通过幂等 SQLite 迁移清除：记忆、捕获对话、游标、分层调度及记忆专用任务均不再保留，执行 VACUUM 回收文件空间；旧备份导入及通用管理接口不能恢复 Memory 配置或任务。

AgentData 是共享宿主，不删除整个 agent-data.db；保留 Wiki、CodeGraph、Thread、权限与审计、插件状态及通用任务。正常会话 JSONL、session-memory 工作状态和压缩摘要、AGENTS.md 及项目手写决策笔记不属于此次裁撤。Memory 下被其他模块复用的传输客户端移到共享目录。

## Related notes

已检索 memory / 记忆 / AgentData：

- [记忆管线](../../archived/architecture/2026-09-18-memory-pipeline-upstream-aligned.md)被本决定完全取代并归档。该记录保留了成本、抽取失败与重复发送载荷的历史证据，不能当作当前用量。仅节流与截断已尝试过，未解决用户的低使用价值与管理负担。
- [自有运行时](../../implemented/architecture/2026-08-31-self-owned-agent-data-runtime.md)和[AgentData 子进程](../../implemented/architecture/2026-10-16-agentdata-host-process.md)部分重叠；共享宿主、权限、Wiki 与代码检索边界继续成立，仅移除记忆职责。
- [上下文策略](../../implemented/architecture/2026-09-30-compaction-and-context-policy.md)保留：session-memory 服务当前分支的长对话连续性，与长期记忆不是同一功能。
- [AgentData 同步诊断](../../implemented/process/2026-10-16-agentdata-sync-timing-diag.md)保留共享请求时序事实，记忆调用只作为历史样本。

## Alternatives considered

- 关闭自动生成与注入可以立即停止增长，且便于恢复；但仍需维护搜索、管理、存储和后台任务代码，不能实现用户要求的完整裁撤。
- 改善语义召回、去重和编辑管理可以提高长期记忆价值；但会增加新的依赖与维护工作，用户已明确选择减少功能。
- 归档旧数据可以保留未来恢复能力；用户明确认为无用且占空间，要求清理，因此不创建备份或导出副本。
- 删除整个 AgentData 最省表面清理；但共享数据库还存 Wiki、权限、线程等仍需保留的内容，不能扩大删除范围。

## Consequences

默认扩展、工具列表、配置和界面均没有 Memory 入口；旧 memory RPC 不能写回或捕获内容。旧记忆及捕获对话不可恢复，包含手工录入的 Memory。正常会话仍以既有 JSONL 为准。通用 JSON 输出解析及共享 RPC 客户端仍供其他功能使用，移到不带 Memory 名义的共享模块。

本机开发版清理时先正常退出旧应用，防止旧进程重新写回。数据库从 1,206,931,456 字节降至 858,566,656 字节，回收 348,364,800 字节（约 332 MiB）。移除 1,507 条记忆、185 份捕获对话、1 条分层调度、1,057 条记忆任务及 Memory 插件状态；清除三个当前设置文件中的 MEMORY_* 键，不创建归档副本。正常会话、消息、权限、审计、Wiki 等其他表记录数不变。

## Verification

- 扩展全量 251 文件、2,414 项通过，27 项跳过；CLI 插件清单 6 项通过。默认扩展与工具注册先看到两条预期红灯。
- 提示词增强 39 项通过；先看到工具仍暴露及调用 memory.search 的两条红灯，再移除调用路径。
- 前端定向 30 文件、419 项通过，另两份会话消息格式测试 22 项通过；仅运行 agentdata-overview（11 项）与 agentdata-memory-retirement（15 项），共 2/42 个 UI 场景，其余 40 个未运行。
- 后端定向 23 文件、208 项通过，覆盖迁移、旧 RPC 和通用管理路由拒绝、旧导入过滤、worker/队列/IPC/恢复及会话列表。根代理另独立跑迁移/RPC/提示词增强三文件 41 项通过。独立内存库探针确认含 memory 字样的普通 Wiki 内容、相似 kind 与损坏 JSON 不被误删。
- 本机真实数据库迁移后 integrity_check=ok，重复迁移幂等；第一轮所有表计数断言通过后，报告脚本因 SQLite 空原型对象比较而中断，改为比较标量并重跑通过。完整统计及日志见 `.agents/evidence/2026-10-31-remove-agentdata-memory/`。
- `npx electron-vite build --mode localrun` 通过；以最终产物重启，主窗口和 agent-host / agentdata-host 正常驻留。重启后 schema=5，Memory 表、任务及插件均为零，当前设置无 MEMORY_*，库大小仍为 858,566,656 字节；检查见 post-restart.json。
- `pnpm run verify-notes` 通过。全仓 `tsc -p tsconfig.node.json --noEmit` 仍有 150 条诊断，不能宣称类型检查全绿；另跑的 AuditViewStore 12 项中 4 项 Wiki 投影断言失败，未改该测试，用 HEAD 原始源码复跑同样失败，属于已确认的原有问题，保留日志不扩范围修复。根 tsconfig.json 的 files 为空，其单独检查成功不当作完整类型检查证据。
- 验证只覆盖本机开发版、受控测试与真实本地库，不代表已发布安装包或真实模型调用验收。
