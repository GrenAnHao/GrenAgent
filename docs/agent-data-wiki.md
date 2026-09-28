# AgentData Wiki 使用说明

Wiki 采用 TencentDB MemoryKnowledge 同款引擎：每个知识库是应用数据目录下的独立目录，库状态记在 `agent-data.db` 的 `wiki_assets` 表。不迁移旧一对一知识库，不保留项目绑定契约。

## 目录布局

```text
<应用数据目录>/
├── agent-data.db              # wiki_assets 等元数据（status 唯一真相源）
└── wiki/
    ├── wiki-sources.json      # 仅 wikiId → path，不存状态
    └── <wikiId>/
        ├── raw/sources/       # 原文（.md / .txt）
        ├── wiki/
        │   ├── entities/ concepts/ sources/ comparisons/ synthesis/
        │   ├── purpose.md schema.md index.md   # 建库默认模板；已存在不覆盖
        │   ├── overview.md log.md              # 抽取收尾维护
        ├── .llm-wiki/         # 空目录占位
        ├── _debug/            # generate 解析失败时的原文
        └── index.db           # wiki_fts / page_meta / graph_edge / source
```

`wikiId` 只能是安全路径段，且不得等于 `wiki-sources.json`。

## 库状态

`wiki_assets.status`：`draft`（建库初值）→ `pending` → `processing` → `ready` 或 `failed`。抽取不会回到 `draft`。

| 操作 | draft | pending | processing | ready | failed |
| --- | --- | --- | --- | --- | --- |
| 原文写/删、页面写/删 | 允许 | 允许 | 拒绝 | 允许 | 允许 |
| 抽取 | 允许 | busy | busy | 允许 | 允许 |
| 页面列表 / 检索 / 图谱 | 空 | 空 | 空 | 有 | 空 |
| 按路径读页面 | 读磁盘 | 读磁盘 | 读磁盘 | 读磁盘 | 读磁盘 |

只有 `processing` 拒绝写入。进程中途退出时库可能停在 `pending` 或 `processing`，启动不改写该状态；工作台提供「重置状态到 `draft`」（`resetDraft`：清 `internal_status` 与 `sync_error`，不动磁盘文件），否则该库无法再抽取或写入。

## 管理工作台

工作台可调用全部进程内操作：建库、改名称与摘要、原文列出/读/写/删、页面列出/读/写/删、开始抽取、检索、图谱、删库、重置到 `draft`。

- **新建知识库**：创建目录、默认 `purpose.md` / `schema.md` / `index.md`、空 `index.db`，状态 `draft`。允许同名（幂等按实现）。
- **原文**：上传或录入 `.md` / `.txt`。只落盘并登记 `source`（`uploaded` / `ingested` / `failed`），不调用模型。
- **模板**：直接编辑 `purpose.md` 与 `schema.md`；页面写入接口拒绝改 `index` / `schema` / `purpose`。
- **开始抽取**：人显式触发；无原文则拒绝。`pending` / `processing` 返回 busy。抽取在进程内串行队列完成，不创建 `wiki.ingest` / `wiki.sync` 任务，任务面板不展示 Wiki 抽取。
- **页面**：`ready` 时可列表与检索。页面写入注入 `locked: true`；写/删后重建该库 `index.db`。知识页面默认只读，点“编辑页面”后进入编辑；抽取进行中每 2 秒刷新一次状态。

删除任意状态均可进行。删库驱逐读连接后删行与目录。

## Agent 工具

Agent 只有三个只读工具；没有抽取、`wiki_update` 或 `wiki_reindex`。图谱仅工作台可用。

| 工具 | 用途 |
| --- | --- |
| `wiki_list` | 不传 `wikiId` 列出知识库；传 `wikiId` 列出该库页面（非 `ready` 时页面列表为空） |
| `wiki_search` | 按 `wikiId` 检索；可传 `hop`（0..5）、`decay`、`minScore` |
| `wiki_read` | 用列表或检索返回的 `wikiId` 与 `ref` 读 Markdown |

## 容量与并发

单页写入上限 512 KB，单份原文上限 5 MB。批量上限：原文读/写/删各 50，页面读/写/删各 20。抽取并发默认 3（1..10），全局模型并发默认 5（1..20）。

## 范围

不引入多租户、HTTP API、向量检索。不迁移旧 wiki 目录与旧 SQL 正文。不在启动时把中断状态改成 `failed`，也不在启动时全量重建索引。
