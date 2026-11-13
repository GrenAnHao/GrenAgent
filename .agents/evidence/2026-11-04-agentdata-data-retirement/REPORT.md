# AgentData 数据丢弃记录（任务 5.2 / 5.3）

日期：2026-11-04
变更：`retire-agentdata-and-split-wiki-codegraph`

## 5.2 资料 Wiki 运行数据与 `userData/wiki/**`

**判据达成，未执行任何删除。**

`%APPDATA%/electron-agent/wiki` 与 `%APPDATA%/com.rxstudio.grenagent/wiki` 两个位置**都不存在**；
`agent-data.db` 里的 `wiki_assets` 为 0 行，`wiki_pages` / `wiki_sources` / `wiki_libraries` 表已被更早的迁移移除。
不存在可删除的对象，因此「目录不存在」的判据自然满足。

## 5.3 丢弃退役表

### 执行前

`agent-data.db`（899 MB，schema 7）中目标表的实际状态：

| 表 | 行数 |
| --- | --- |
| `agent_jobs` | 0 |
| `knowledge_build_items` | 0 |
| `knowledge_execution_requests` | 0 |
| `knowledge_source_snapshots` | 0 |
| `agent_job_leases` | 1（`expires_at: 0` 的过期租约） |
| `service_tasks` | 1（`wiki_page_generate`，completed） |
| `wiki_assets` | 0 |
| `agent_audit` | 0 |
| `knowledge_tasks` / `native_wiki_*` / `wiki_pages` / `wiki_sources` | 表已不存在 |

即：**没有任何业务数据需要保留**，与基线文档（`agent_jobs` 25 行、`wiki_assets` 1 行）相比，这些数据在此前的退役过程中已被清空或迁移。

### 执行

单一 `BEGIN IMMEDIATE` 事务内 `DROP TABLE`，13 张表：

```
agent_jobs, knowledge_build_items, knowledge_execution_requests, knowledge_source_snapshots,
agent_job_leases, service_tasks, wiki_assets, agent_audit,
wiki_documents_before_libraries, wiki_fts_before_libraries, wiki_legacy_library_map,
wiki_legacy_source_map, wiki_schema_migrations
```

### 执行后

共享表行数（删除前后对比，允许只增不减——应用仍在运行并写入）：

| 表 | 前 | 后 | 结论 |
| --- | --- | --- | --- |
| `threads` | 629 | 629 | 一致 |
| `turns` | 1640 | 1640 | 一致 |
| `items` | 99252 | 99256 | +4，应用写入 |
| `permission_rules` | 17 | 17 | 一致 |
| `tool_audit` | 100620 | 100622 | +2，应用审计 |
| `plugin_state` | 5 | 5 | 一致 |

剩余表：`schema_version, audit_events, sqlite_sequence, agent_config, threads, turns, items, app_events, plugin_state, permission_rules, tool_audit`。

### 不会复活

- `KnowledgeBuildStore` 的建表语句会重建 `knowledge_*` 与 `agent_job_leases`，但它只接 `knowledgeDbPath`；
  生产路径（`main.ts:111`）传入 `userData/repo-wiki/knowledge.sqlite`，不会回落到主库。
- 删除后静置 45 秒复查：上述 8 张表均未重新出现。

## 不可恢复范围

`agent_jobs`、`knowledge_*`、`agent_job_leases`、`service_tasks`、`wiki_*`、`agent_audit`
在本机的历史**已不可恢复**。删除前这些表合计只有 2 行（1 条过期租约、1 条已完成的旧 wiki 任务），
其余为空表；因此实际丢失的数据量为 2 行元数据，不含任何正文、决策或审计记录。

线程、回合、条目、权限规则、工具审计、插件状态全部保留。

## 7.4 销毁对照副本

**已执行**，2026-11-04。

| 项 | 值 |
| --- | --- |
| 路径 | `%LOCALAPPDATA%/grenagent-retirement-backup/` |
| 内容 | `agent-data.pre-retirement-20261103.db`（856 MB）+ `wiki/`（4 个子目录、`wiki-sources.json`），共 9 个文件 |
| 销毁前校验 | 副本 `PRAGMA integrity_check` = `ok` |
| 销毁前内容 | `threads` 621、`turns` 1612、`items` 96172、`permission_rules` 17、`tool_audit` 98309、`plugin_state` 5、`agent_jobs` 25、`wiki_assets` 1、`wiki_sources` 2、`knowledge_build_items` 242、`agent_audit` 8766、`wiki_pages` 0（完整清单见 `backup-before-destroy.json`） |
| 销毁方式 | `rm -rf`，执行后复查路径不存在 |

### 不可恢复范围（明确）

销毁后以下本机数据**永久不可恢复**：

- `agent_jobs` 25 行 —— 全部历史任务记录（`codegraph.sync` 5、`repoWiki.generate` 16、`repoWiki.native` 4）；
- `knowledge_build_items` 242 行 —— 知识卡的历史构建项；
- `agent_audit` 8766 行 —— 已下线的审计诊断记录（注意：**权限审计 `tool_audit` 98,309 行不在此列**，它在现库中保留且仍在增长）；
- `wiki_assets` 1 行、`wiki_sources` 2 行、`wiki/` 目录下的资料 Wiki 文件；
- 退役前的线程/回合/条目快照（`threads` 621 等）—— 这些在现库中仍有更新版本，因此不影响现有会话历史。

现库中保留并继续使用的是：`threads`、`turns`、`items`、`permission_rules`、`tool_audit`、`plugin_state`、`agent_config`、`app_events`、`audit_events`、`schema_version`。
