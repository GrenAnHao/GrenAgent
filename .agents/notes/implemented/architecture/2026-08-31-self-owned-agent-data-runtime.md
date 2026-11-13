# Agent Note: 自研 Agent Data Runtime，取代 TencentDB 托管运行时

Status: implemented

## Problem

记忆与知识库曾全面切到 TencentDB 托管运行时（bf8a958a，2026-08-18；随包分发 Node.js、MemoryCore、MemoryKnowledge 两个回环服务）。2026-08-31 移除（0d614d14「remove TencentDB runtime and integration」、24784dde「finish self-owned code retrieval and cleanup」）。

原因（用户说明）：TencentDB 属于通用型平台，很多功能与自有 harness 冲突，所以采用它的功能内核，而不是平台本身。

> 当前进程边界见[架构文档](../../../../docs/architecture.md#代码索引)。下文是替换 TencentDB 时的历史记录；旧 Wiki 和独立 AgentData 宿主已退役。

## Decision

- 主进程启动自研 Agent Data Runtime：`127.0.0.1` 随机端口 JSONL RPC，`randomBytes(32)` token 鉴权；数据在 `<应用数据目录>/agent-data.db`（`node:sqlite`）。
- 组成：`wikiEngine`（每库 `<应用数据目录>/wiki/<wikiId>/`）、`jobStore`（任务、version 乐观锁配置、审计），以及线程与工具权限。长期记忆按[裁撤决定](../simplification/2026-10-31-remove-agentdata-memory.md)移除，共享宿主和数据库保留。
- endpoint 以 `AGENT_DATA_ENDPOINT` 注入 ALS / 子代理 env，扩展反向调用。

### 涉及文件

- `electron-agent/electron/agentData/`
- [原迁移说明（历史）](https://github.com/GrenAnHao/GrenAgent/blob/7cea05eac673e7046ee92748c2f01bc649764ba4/docs/agent-data-migration.md)

### 来源

- bf8a958a
- 0d614d14
- 24784dde
- 1dfc255e（全局作用域计划）
- `docs/architecture.md`「Agent Data Runtime」

## Alternatives considered

- **继续用 TencentDB 托管运行时**：现成的分层记忆与知识检索。放弃理由：通用平台，很多功能与自有 harness 冲突；改为吸收其功能内核（用户说明）。
- 已移除的长期记忆曾沿用 TencentDB 的 L1 提取等设计，历史取舍见[记忆管线](../../archived/architecture/2026-09-18-memory-pipeline-upstream-aligned.md)；保留的 Wiki 与通用输出解析仍按实际来源保留声明。

## Consequences

- 持久化格式（`agent-data.db` schema、wiki 目录结构）是本地数据契约，改动需迁移。
- 不再随包分发 TencentDB 运行时；`tencentdb-memory/` 目录只是 Tauri 时期历史数据。

## Verification

verify: n/a 回填的历史决定，源提交未记录验证
