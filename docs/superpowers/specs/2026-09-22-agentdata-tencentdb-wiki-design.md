# AgentData 替换为 TencentDB Wiki

- 日期：2026-09-22
- 状态：待审查（审查修订后）
- 范围：GrenAgent 桌面端 AgentData 的 Wiki
- 参考：`D:/System Dir/Downloads/TencentDB-Agent-Memory/MemoryKnowledge`
- 取代：`docs/superpowers/specs/2026-09-05-agent-data-markdown-wiki-design.md` 与本 Feature 的现有实现
- 修订：2026-09-22 审查后补齐 `draft` 状态与写入门；修正 `pending` 期写入行为；把「建库写默认模板」「启动不改写中断状态」标为与参考实现的显式偏差；补索引重建、删除级联、`node:sqlite` 接缝、依赖落点与受影响文件清单。

## 1. 决定

现有一对一知识库没有投入使用。整段替换，不迁移，不双写，不保留旧契约。

搬入的是 TencentDB 的整套 wiki：`MemoryKnowledge/src/engines/wiki`（`manager.ts`、`index-db.ts`、`graph-search.ts`、`types.ts` 与 `ingest-v2/` 全部 14 个文件），加上 `src/store/wiki-service.ts` 的文件层与状态机、`src/store/build-queue.ts`、`src/store/serial-queue.ts`、`src/config.ts` 的两个并发读取函数。行为以这些文件为准；`src/routes/wiki.ts` 只作为调用面与校验规则的清单参考，不搬。本文只记录接入本地应用时必须改的接缝，以及参考实现里已经确定的顺序和失败结果。

接缝：

- **SQLite**：`better-sqlite3` → 现有 `node:sqlite`，表结构与参考实现的 `index.db` 相同，但 API 必须改写。`DatabaseSync` 没有 `db.pragma()` 与 `db.transaction(fn)`（本机 Node 22.22.2 实测），一律改成 `db.exec('PRAGMA ...')` 与手写 `BEGIN`/`COMMIT`/`ROLLBACK`。实测同一运行时的 SQLite 3.51.2 支持 FTS5（`unicode61 remove_diacritics 0`）、`bm25(table, 5.0, 1.0)` 权重与 WAL，索引方案可原样落地。
- **模型调用**：走现有 Electron 模型，替换 `ingest-v2/llm.ts` 的 AI SDK 客户端，保留其 `LlmClient.chat({ system, prompt, label })` 形状与 `RawLlmConfig` 字段。
- **图遍历**：`graphology` 不在本仓库依赖中（`electron-agent` 与 `extensions` 的 `node_modules` 都没有）。`graph-search.ts` 与 `manager.ts` 的建图只用到 `hasNode`/`neighbors`/`getNodeAttribute`/`addNode`/`addEdge`/`hasEdge`，改用邻接表（`Map<string, Set<string>>`）即可，不新增依赖；若坚持保留 graphology，需显式加进 `electron-agent` 的依赖。
- **依赖落点**：`yaml` 已是 `electron-agent` 直接依赖，frontmatter 解析沿用；`p-limit`、`lru-cache` 在 `node_modules` 里只是传递依赖，需显式声明或改写（并发闸可用项目内现成队列实现；读连接池见 §2）。
- **不搬入的外壳**：HTTP 服务、`service_id`/`team_id` 租户头、Panel 回调与摘要、CodeGraph、ClickHouse、Langfuse、`better-sqlite3`、审计日志、`agent_jobs`/`service_tasks` 任务、`source-fetcher`（git）、自动同步调度器。
- **不搬入的行为**（与参考实现的显式偏差，不是遗漏）：参考实现在启动时把 `pending`/`processing` 批量改成 `failed`（`module.ts` 的 `markInterruptedAsFailed`），并在启动时全量重建所有 `ready` 库的索引。本文两步都不做：状态不改写，索引直接复用已持久化的 `index.db`。前者的后果与配套要求见 §4。
- 拷入的文件保留 MIT 版权声明。

## 2. 组件

每个知识库是应用数据目录下的一个目录：`<应用数据目录>/wiki/<wikiId>/`（与现有 `wikiRootDir` 同根）。`wikiId` 只能是安全路径段，且不得等于 `wiki-sources.json`。目录内容沿用参考实现：

- `raw/sources/`：原文，`.md` 与 `.txt`
- `wiki/entities`、`wiki/concepts`、`wiki/sources`、`wiki/comparisons`、`wiki/synthesis`：生成页，只索引 `.md`
- `wiki/purpose.md`、`wiki/schema.md`、`wiki/index.md`：默认内容；文件已存在则不覆盖
- `wiki/overview.md`、`wiki/log.md`：抽取收尾维护
- `.llm-wiki/`：参考实现建库时一并创建的空目录，保留
- `_debug/`：generate 解析失败时落原文便于排查，保留
- `index.db`：四张表——`wiki_fts(page_id,title_tok,content_tok)`、`page_meta(page_id,title,type,rel_path,snippet)`、`graph_edge(source_id,target_id)`、`source(filename,sha256,size,status,created_at,updated_at,last_modified_by,ingested_at,ingest_error)`

`source.status` 是文件粒度状态：`uploaded`/`ingested`/`failed`。写原文时登记：新文件 `uploaded`；内容哈希变化则回到 `uploaded` 并清 `ingest_error`（保留 `created_at`）；哈希未变则幂等不动。原文列表读 `source` 表。

库状态放在现有 AgentData SQLite 的新表 `wiki_assets`（`<应用数据目录>/agent-data.db`，不带 `service_id` 和 `team_id`）：`wiki_id`、`name`、`status`、`internal_status`、`sync_error`、`page_count`、`summary`、`version`、`last_sync_at`、`created_at`、`updated_at`。`status` 取 `draft`（建库初值）、`pending`、`processing`、`ready`、`failed`；抽取不会让它回到 `draft`，唯一的回退通道是工作台的显式重置（见 §4）；`internal_status` 取 `scanning`（入队后开始）、`ingesting`、`rebuilding-index`。抽取失败原因写入 `sync_error`（截断 500 字）。同一目录的旧表（`wiki_pages`、`wiki_documents`、`wiki_fts`、`wiki_libraries`、`wiki_sources`、`wiki_source_revisions`、`wiki_page_state`、`wiki_legacy_source_map`、`wiki_schema_migrations`）随旧实现在迁移里删除，不迁移数据。

**写入门**：只有 `processing` 拒绝写入（原文写/删、页面写/删）；`draft`、`pending`、`ready`、`failed` 都允许。页面列表要求 `ready`。

进程内保留串行构建队列，以及删除进行中的内存取消标记（`Set<wikiId>`，删除时置位，worker 在入口与结束前检查）。**引擎状态文件** `<应用数据目录>/wiki/wiki-sources.json` 只存 `wikiId → path`，不再存状态：状态以 `wiki_assets` 为唯一真相源（参考实现把该文件放在 `<dataDir>/_wiki_engines/` 并同时存 `status`/`pageCount`/`lastSyncAt`，两处状态会分叉）。

本地调用面与参考实现的 wiki 操作对应：创建（同名幂等）、读取、列出、删除、更新名称和摘要、原文的列出/阅读/写入/删除、页面的列出/阅读/写入/删除、抽取、检索、图谱。这些操作在进程内完成，不经过 HTTP。工作台可以使用全部操作。

写入约束沿用参考实现：页面写入在 frontmatter 注入 `locked: true`；页面写入**与页面删除**都拒绝 `index`、`schema`、`purpose`（含 `wiki/` 前缀，有无 `.md` 都算）；`log` 和 `overview` 不在这份拒绝列表里。抽取生成的 FILE 块不能覆盖 `wiki/index.md`、`wiki/schema.md`、`wiki/purpose.md`、`wiki/log.md`、`wiki/overview.md`。人要改抽取模板时，直接改 `purpose.md` 和 `schema.md`，不走页面写入。

删除级联：删原文时按各页 frontmatter 的 `sources` 处理——独占该源的页删除，共享的页重写去掉该源；删页面时清理其他页里指向已删页的 `[[wikilink]]`（替换为展示文本）。结构性页面不参与级联。

写入后的索引：参考实现由 HTTP 路由在 `page/write`、`page/rm`、`raw/rm` 之后调用 `wikiMgr.sync(wikiId)` 全量重建索引（扫描 `wiki/` → 事务重建三表 → 驱逐读连接）。不经过 HTTP 后这个职责由进程内 API 承担；否则工作台改完页面后检索与图谱看不到改动。

容量与并发：单页写入上限 512 KB，单份原文上限 5 MB。批量上限以服务层常量为准：原文读 50、原文写 50、原文删 50、页面读 20、页面写 20、页面删 20。参考实现的 HTTP 路由对 `raw/write` 另有「最多 10 个文件、总量 5 MB」的限制，属外壳，不搬入。抽取并发默认 3，范围 1 到 10（`KNOWLEDGE_WIKI_INGEST_CONCURRENCY`）；全局模型并发默认 5，范围 1 到 20（`KNOWLEDGE_LLM_GLOBAL_CONCURRENCY`）；抽取模式默认 `two-stage`（另一档 `single-stage`）。

读连接沿用参考实现的结构：写连接独立创建、事务提交后 `wal_checkpoint(TRUNCATE)` 并关闭；读连接走按 `wikiId` 索引的池（默认上限 300，`KNOWLEDGE_WIKI_POOL_MAX`；不引入 `lru-cache` 时用 Map + 上限淘汰等价实现）。删库时先驱逐读连接，再删行，再 `rmSync` 目录。

Agent 只使用列出、检索、阅读。检索参数沿用默认值：`limit` 20、`hop` 0、`decay` 0.5、`minScore` 0.1，`hop` 最大 5，扩展最多 200 个节点；工具透传 `hop`/`decay`/`minScore`，越界值拒绝。抽取只从工作台显式开始。去掉 `wiki_update` 和 `wiki_reindex`。参考实现的 Agent 面是 4 个工具（多一个 `wiki_graph`），本文只给 3 个，图谱仅工作台可用。

**与参考实现的偏差（有意为之）**：`purpose.md`、`schema.md`、`index.md` 在建库时即写入默认内容；参考实现是在首次抽取（`manager.initWikiProject`）时才落盘。提前的理由是工作台要在抽取前编辑模板，否则抽取前无文件可改。已存在的文件仍不覆盖。

旧的库绑定、资料版本、一对一 `generatedPageId`、旧管理接口和对应工作台页面删除；进程内不再创建 `wiki.ingest`/`wiki.sync` 任务，任务面板不再展示 Wiki 抽取，也不再写 `wiki.*` 审计事件。工作台改为操作上面这套调用：建库、上传原文、修改名称和摘要、直接编辑 `purpose.md` 与 `schema.md`、开始抽取、浏览页面、检索、删库。不设计新的视觉布局。

同步修改（现有代码/文档随删除一起改，避免留半截接线）：`extensions/wiki-rag`（去掉两个写工具与对应测试）、`extensions/_shared/tool-groups.ts` 的 `WRITE_TOOLS`、`extensions/multi-agent/agents.ts` 的 `WRITE_TOOL_HINTS`、`extensions/agent-data-manifests.ts` 与 `cli/src/agent-data-plugins.test.ts` 的工具清单、`docs/architecture.md` 与 `docs/agent-data-wiki.md`、`electron-agent/electron/agentData` 下的 `wiki*` 模块与其测试、`app/agentDataDiagnostics`、`auditViewStore` 的 `wiki.*` 分支。

## 3. 数据流

建库时创建目录、默认模板与空的 `index.db`（四张表），`wiki_assets` 行记为 `draft`。写入原文不调用模型，只落盘并登记 `source` 行。

人显式开始抽取。没有原文就拒绝，不调用模型。库已是 `pending` 或 `processing` 时返回 busy，不重新入队。否则版本加一，状态改为 `pending`，进入进程内队列。执行前若库已删除，则跳过。开始后状态改为 `processing`，`internal_status` 依次为 `scanning`、`ingesting`、`rebuilding-index`。

抽取沿用 `runIngestIncremental`：

1. 按内容哈希分类。上次抽取成功（`source.status = ingested`）且哈希未变的原文跳过；其余进入抽取（新增、`uploaded`、`failed`，以及哈希变化的，即使上次失败过也重抽）；磁盘上已不存在的原文进入删除。
2. 抽取前扫描一次 `wiki/` 作为「已有页面」快照，各源共用。并行抽取：每份原文读取 `purpose.md` 与 `schema.md`（缺失或只有占位骨架时用默认模板），先分析再生成候选页（`two-stage`）；单份失败只记在这份原文上。单源超过约 28000 字符时分块，块目标 12000 字符、重叠 400。
3. 已删除的原文做级联清理。然后串行合并：没有同名页就新建；`locked: true` 跳过；候选正文已被旧页覆盖时只合并来源列表；旧页正文不超过 4000 字则整页重写，超过则只追加增量片段（LLM 未产出增量则正文不变、只并来源）。随后重写 `index.md`，并把结果追加到 `log.md`。
4. 至少一份原文抽取成功、且可综述的页面不少于 2 张时，覆盖写 `overview.md`。这一步失败不影响已写入的页面。
5. 扫描 `wiki/`，在同一个写事务里重建全文索引、页元数据、链接边，并登记原文状态、删除已消失的原文行。

页面写入、页面删除、原文删除之后按 §2 重建索引。

部分原文失败时库变为 `ready`。本次尝试的原文全部失败时，索引和原文状态写下之后抛错，库变为 `failed`。检索先做全文匹配：查询与页面文本走同一套分词（英文整词去停用词，中文 bigram + 整段），每个 token 加 `*` 前缀后 OR 连接，标题权重 5、正文权重 1，`bm25` 取负转成正分。`hop` 为 0 时只返回这些命中。`hop` 为 1 到 5 时沿 `[[wikilink]]` 扩展，每跳分数乘以 `decay`，低于 `minScore` 丢弃。结果带 `path`、`title`、`snippet`、`score`、`type`、`hop`、`via`，以及 `related`（出链/入链邻居，按度数降序，最多 10）与 `links`（结果之间的边）。阅读按路径读磁盘 Markdown：接受页面 id、带或不带 `wiki/` 前缀、带或不带 `.md`；`raw/` 前缀读原文；路径越出库目录返回未找到。

## 4. 错误处理

沿用 TencentDB 的失败语义，不做启动修复。

状态门（库不存在时：阅读、页面列表、检索返回未找到或空）：

| 操作 | draft | pending | processing | ready | failed |
| --- | --- | --- | --- | --- | --- |
| 原文写/删、页面写/删 | 允许 | 允许 | 拒绝 | 允许 | 允许 |
| 抽取 | 允许 | busy | busy | 允许 | 允许 |
| 页面列表 | 空 | 空 | 空 | 有 | 空 |
| 检索、图谱 | 空 | 空 | 空 | 有 | 空 |
| 按路径读页面 | 读磁盘 | 读磁盘 | 读磁盘 | 读磁盘 | 读磁盘 |

参考实现把「库不是 `ready` 就返回空」的门放在路由层，进程内 API 必须自己承担这一层判断。

部分原文失败时库为 `ready`，失败原文保留错误，成功页保留。全部失败时库为 `failed`，并带上第一份失败原因。单页合并失败不影响其他页；一份原文的候选页全部合并失败时，只把这份原文记为失败。`overview` 失败和级联清理失败只记警告。`locked: true` 被跳过，不算失败。索引事务失败时库变为 `failed`，页面文件在该事务之前已经落盘，不回滚。

路径越出库目录，或页面写入、页面删除碰到被拒绝的结构页，直接拒绝。指定库不存在时，该库的阅读、页面列表和检索返回未找到。删除在任何状态都可以进行。抽取过程中库被删掉后，结束时不再标成 `ready` 或 `failed`，并做一次幂等清理（关连接、删行、删目录）。

进程中途退出时，库停在 `pending` 或 `processing`，启动时不改写这个状态。**后果必须一并接受**：该库此后抽取永远返回 busy、写入永远被拒、页面列表永远为空（只剩按路径读），UI 上不可恢复。因此工作台必须提供显式的「重置状态到 `draft`」入口（清 `internal_status` 与 `sync_error`，不动磁盘文件）；否则崩溃一次就等于该库报废。启动仍不重放、不自动改写状态。

## 5. 测试

删除现有一对一知识库测试，不保留兼容用例。新测试使用临时目录、临时数据库和模型替身，不访问真实付费模型。

必须验证：

- 建库后存在默认的 `purpose.md`、`schema.md`、`index.md`，`index.db` 建好四张表，库状态为 `draft`。已存在的这三个文件不被建库覆盖。
- 只写入原文时，模型替身不被调用；`source` 行依次为 `uploaded`，抽取成功转 `ingested`，失败转 `failed`。
- 一份原文抽出多张页，并按已有页面合并。上次成功且哈希未变的原文跳过；上次失败过的原文即使哈希未变也重抽。
- 旧页 `locked: true` 时跳过且这份原文仍算成功。页面写入会注入 `locked: true`。
- 合并分档：旧页正文 ≤4000 字走整页重写，>4000 字走追加且旧正文保留。
- 部分原文失败时库为 `ready`。全部失败时库为 `failed` 并带上首条失败原因。
- 没有原文时抽取被拒绝；`pending` 或 `processing` 时抽取返回 busy。
- `processing` 期间的原文写/删与页面写/删被拒绝；`draft`、`pending`、`ready`、`failed` 期间允许。
- 页面写入与页面删除都不能碰 `index`、`schema`、`purpose`，也不能写出库目录。超过 512 KB 的页面和超过 5 MB 的原文被拒绝；超过 20/50 条批量的请求被拒绝。
- 删原文后独占页被删、共享页被重写去掉该源；删页面后其他页里的悬空 `[[wikilink]]` 被替换为展示文本。
- 页面写入后（不跑抽取）检索能立刻命中新页，图谱能看到新边。
- `hop` 为 0 时只返回全文命中；传入跳数后，结果包含沿 `[[wikilink]]` 扩展到的页，且扩展结果分数按 `decay` 递减。
- 库不是 `ready` 时，页面列表、检索和图谱为空；原文列表仍读 `source` 表；按路径仍能读到已落盘文件。
- 抽取过程中删库，结束后库不会被标成 `ready` 或 `failed`，磁盘目录与读连接被清理。
- 抽取失败与状态停留后，工作台的「重置状态到 `draft`」能让该库重新抽取。
- Agent 的列出、检索、阅读走这套引擎。工具列表里没有抽取、`wiki_update` 和 `wiki_reindex`，`WRITE_TOOLS` 已同步。

不测试启动时把 `pending` 或 `processing` 改成 `failed`，也不测试启动时重建 `ready` 库索引。

## 6. 非目标

不引入多租户、团队权限、HTTP API、Panel、CodeGraph 服务、向量检索、ClickHouse 和 Langfuse。不迁移旧 wiki 目录、旧 SQL 正文或旧工作区映射。不搬入启动时的中断状态改写（`markInterruptedAsFailed`）与启动时全量索引重建。不在进程重启时自动重放或改写中断的抽取。
