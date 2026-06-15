# long-term-memory 检索升级设计规格 — sqlite-vec 向量索引 / 结构化过滤 / 降权老化

> **面向 AI 代理：** 这是设计规格（spec）。下一步用 `superpowers:writing-plans` 产出实现计划，再用 `superpowers:executing-plans` 内联执行（本仓库**禁止子代理**）。
>
> 配套计划：`docs/superpowers/plans/2026-06-15-memory-retrieval-plan.md`（writing-plans 阶段生成）。

**目标：** 把 `extensions/long-term-memory` 的召回从「全表加载 + 内存 cosine」升级为 **sqlite-vec ANN**，并补齐**结构化过滤**与**基于使用度的降权排序**，使记忆量增长后仍快、召回更准——同时保持扩展「开箱即跑、可回退、不丢事实」的现有特性。

**架构原则：** 改动全部落在 `extensions/long-term-memory/`。**不动** `consolidate.ts`（mem0 写入决策）、`history`/`rollback`、双 scope（project/global）合并语义；**不改** Rust/Tauri 后端、不改 `cli` runtime、不改前端。

**技术栈：** TypeScript（Node **≥ 23.5**，因 `loadExtension`）+ `node:sqlite` + `sqlite-vec` + `@earendil-works/pi-coding-agent` ExtensionAPI + typebox + vitest（node 环境）。

---

## 1. 背景与动机

### 1.1 现状（实测）

- **存储：** `store.ts` 用 `node:sqlite`(DatabaseSync)。`memories` 表：`id`(TEXT pk)、`text`、`category`、`createdAt`、`updatedAt`、`version`、`embedding`(Float32 BLOB)；另有 `memory_history` 表。双 scope：`project`(`<cwd>/.pi/memory/memory.db`) 与 `global`(`~/.pi/agent/long-term-memory.db`) 各一 `MemoryStore` 实例。
- **召回：** `recall()` 全表 `SELECT ... FROM memories` 后在 JS 内存逐条算 `cosine`（无 embedding 时退化 `keywordScore`），再排序取 topK。复杂度 O(n) 扫描 + O(n·d) 算分。
- **写入：** `consolidate.ts` mem0 风格——召回相似 top5 → LLM 决策 ADD/UPDATE/DELETE/NOOP；`history` + `rollback` 保证可撤销、不丢事实。
- **依赖：** `package.json` 无 `dependencies`，纯 `node:` 内置 + 宿主注入；无 key 时关键词兜底，开箱即跑。

### 1.2 缺口

| 维度 | 现状 | 缺口 |
|------|------|------|
| 检索性能 | 全表内存 cosine | 记忆上千条后线性扫描变慢（唯一扩展性硬伤） |
| 结构化过滤 | 仅按 score 排序 | 无法按 `category`/时间/scope 收窄候选 |
| 排序质量 | 纯相似度 | 无使用度/时效加权，常用记忆不上浮、旧记忆不沉降 |

---

## 2. 范围

### 2.1 覆盖（三块，按阶段实现）

- **向量索引：** 用 sqlite-vec `vec0` 影子表替换全表内存 cosine，含加载失败回退。
- **结构化过滤：** `category` / 时间范围 / scope 进入查询，缩小候选集。
- **降权老化：** 新增 `useCount` / `lastUsedAt`，命中即更新，融入加权排序（**只降权、不删除**）。

### 2.2 非目标（YAGNI）

- 不引入五层记忆 / persona 聚合（对单用户 coding agent 过度设计）。
- 不改 `consolidate` 写入决策、不改 `history`/`rollback`、不改双 scope 合并语义。
- 不改 Rust/Tauri 后端、`cli` runtime、前端。
- 不自动删除任何记忆（老化仅影响排序）。
- 不引入外部向量服务 / 向量数据库（保持 in-process、单文件）。

---

## 3. 数据层：vec0 影子表

### 3.1 设计

现有 `memories` 表**保持不变**，每个库新增一张 vec0 虚拟表，与 `memories` 的隐式 `rowid` 一对一对齐：

```sql
-- N = embedding 维度（见 3.3）
CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[N]);
```

新增两列老化字段（**Phase 3 引入**，沿用现有 `migrate()` 的 PRAGMA 增量迁移，老库无损升级）：

```sql
ALTER TABLE memories ADD COLUMN lastUsedAt INTEGER;          -- 最近一次被召回命中的时间(ms)
ALTER TABLE memories ADD COLUMN useCount   INTEGER DEFAULT 0; -- 被召回命中的累计次数
```

加载时启用扩展并 `load`：

```ts
const db = new DatabaseSync(file, { allowExtension: true });
sqliteVec.load(db);   // 见 8. 降级：此处包 try/catch
```

### 3.2 rowid 对齐与同步

- `vec_memories.rowid` 取 `memories` 行的隐式 `rowid`（`memories` 主键是 TEXT，不是 rowid alias，故有独立隐式 rowid）。
- `insert`/`save`：写 `memories` 后取 `info.lastInsertRowid`，以该 rowid 写入 `vec_memories(rowid, embedding)`。
- `update`：文本变更重算 embedding 时，`UPDATE vec_memories SET embedding=? WHERE rowid=?`。
- `remove`/`rollback`：删除 `memories` 行的同时 `DELETE FROM vec_memories WHERE rowid=?`。

### 3.3 维度管理

- `meta` 表记录建表时的向量维度 `dim`；首次建 `vec_memories` 用当前 embedding 模型维度（`text-embedding-3-small` = 1536）。
- 若 `resolveEmbeddingConfig()` 的模型维度与 `meta.dim` 不符（换模型）→ `DROP TABLE vec_memories` 重建并回填（见 7. 迁移）。

### 3.4 决策

| 决策 | 选项 | 结论 | 理由 |
|------|------|------|------|
| 索引组织 | vec0 影子表 / vec0 元数据列 / 重构 | **影子表** | 最小侵入；现有 CRUD/history/rollback 全复用；删表即回退 |
| `save()` 幂等写 | 保留 `INSERT OR REPLACE` / 改显式 upsert | **改 `ON CONFLICT(id) DO UPDATE`** | `REPLACE` 会变更 rowid 致影子表错位；upsert 保持 rowid 稳定（有针对性的现有代码改进） |
| 过滤位置 | 应用层 join 后过滤 / vec0 元数据过滤 | **起步 join 后过滤** | 不改 vec0 表结构；vec0 元数据过滤留作 Phase 2 可选优化 |

---

## 4. 检索流程（两段式 + 加权重排）

```
recall(query, topK, filters):
  1. vecEnabled? 否 → 回退现有全表 cosine/keyword（见 8）
  2. qv = embed(query)
  3. KNN over-fetch:
       SELECT rowid, distance FROM vec_memories
       WHERE embedding MATCH :qv ORDER BY distance LIMIT topK * F   -- F 默认 4
  4. join memories 取正文/元数据/useCount/lastUsedAt
  5. 结构化过滤: category ∈ filters?、createdAt ∈ [from,to]?（scope 由 recallMerged 合并两库后处理）
  6. 加权重排（见 5），截取 topK
  7. 命中项批量 UPDATE useCount = useCount + 1, lastUsedAt = now
```

- **over-fetch 因子 F**：因结构化过滤会筛掉部分候选，KNN 先多取 `topK×F` 保证过滤后仍够 `topK`；过滤后不足时按现有数据返回。
- 向量参数与 BLOB 编解码沿用现有 `encodeEmbedding`/`decodeEmbedding`（Float32 ↔ `Uint8Array`），vec0 `MATCH` 入参为 `new Uint8Array(Float32Array.from(qv).buffer)`。

---

## 5. 排序公式

```
score = w_sim · (1 − distance)
      + w_recency · exp(−Δt / τ)        // Δt = now − lastUsedAt；从未命中按 createdAt
      + w_usage · norm(useCount)        // norm = log(1 + useCount) / log(1 + USE_CAP)
```

- 默认权重 `w_sim=0.7 / w_recency=0.2 / w_usage=0.1`，`τ` 默认 30 天，`USE_CAP` 默认 20。
- 权重/常量先以模块常量实现；如需可调再加 env（YAGNI，先不加）。
- Phase 1 仅用 `w_sim`（行为对齐现状，纯距离排序）；Phase 2 引入 recency；Phase 3 引入 usage。

---

## 6. 老化（降权不删）

- 召回命中 → `useCount+1`、`lastUsedAt=now`；久不命中者经公式自然降分下沉。
- **永不自动物理删除**，与现有 `history`/`rollback`「不丢事实」哲学一致。物理删除仍只经 `/memory forget`/`clear` 人工触发。

---

## 7. 迁移 / 兼容

- **回填：** 首次加载若 `vec_memories` 为空而 `memories` 已有 embedding BLOB → 批量回填进 `vec_memories`（一次性，按 rowid）。
- **惰性补算：** 无 embedding 的老库，在配置了 key 后，写入/召回路径按现有逻辑逐步补算并落 `vec_memories`。
- **维度变更：** `meta.dim` 与当前模型不符 → 重建 `vec_memories` 并回填。
- **老库字段：** `lastUsedAt`/`useCount` 由 `migrate()` 增列，缺省 `useCount=0`、`lastUsedAt=NULL`（排序按 `createdAt` 兜底）。

---

## 8. 降级 / 错误处理（关键）

`sqliteVec.load(db)` 必须包 try/catch，失败时置 `vecEnabled=false`，召回回退现有实现，扩展永不因此崩。

| 场景 | 处理 |
|------|------|
| Node < 23.5 / 缺 `loadExtension` | `load` 抛错 → `vecEnabled=false` → 回退全表 cosine/keyword |
| 缺平台预编译二进制 / `load` 失败 | 同上，回退；打印一次 warn |
| 无 embedding key（`config.enabled=false`） | 走现有关键词召回（与 vec 无关） |
| 维度不匹配 | 重建 `vec_memories` 回填；回填中临时走全表兜底 |
| KNN 过滤后不足 topK | 返回现有数量，不报错 |
| `save` upsert 迁移期老库仍 REPLACE | 迁移逻辑确保 rowid 稳定后再启用影子表写入 |

---

## 9. 测试（vitest，node 环境）

- KNN 召回正确性（装 sqlite-vec）：插入已知向量，验证 MATCH 排序与 topK。
- **降级路径**：强制 `vecEnabled=false`，验证回退到现有 cosine/keyword 且结果与升级前一致。
- 迁移：老库（有/无 embedding）首次加载回填；维度变更重建。
- rowid 同步：insert/update/remove/rollback 后 `vec_memories` 与 `memories` 一致；`save` upsert 后 rowid 不变。
- 老化：命中后 `useCount`/`lastUsedAt` 更新且影响排序顺序。
- 复用现有 `store.test.ts`/`consolidate.test.ts` 风格与夹具。

---

## 10. 分期实现顺序

| 阶段 | 内容 | 依赖 | 验收（独立可交付） |
|------|------|------|--------------------|
| **Phase 1 — 向量索引** | sqlite-vec 接入、`vec0` 影子表、rowid 同步、回填迁移、`recall` 走 ANN（仅 `w_sim`）、加载失败回退、`save` 改 upsert | 无 | 召回结果与现状对等，但走索引、去掉全表扫描；老 Node 自动回退 |
| **Phase 2 — 结构化过滤 + 时效** | `category`/时间过滤进查询、over-fetch、score 引入 `w_recency` | Phase 1 | 可按 category/时间筛；近期命中上浮 |
| **Phase 3 — 老化降权** | `lastUsedAt`/`useCount` 字段、命中更新、score 引入 `w_usage` | Phase 1 | 常用记忆上浮、久不用下沉，无删除 |

三阶段无强依赖于 P2/P3 之间（均依赖 P1 的数据层），可顺序内联实现，每阶段独立可合并、可验证、可回退。

---

## 11. 决策记录

| 决策 | 选项 | 结论 | 理由 |
|------|------|------|------|
| 范围 | 仅索引 / 索引+过滤+老化 / 含分层persona | **索引+过滤+老化** | 补齐召回质量与扩展性，不上重型建模 |
| 向量后端 | sqlite-vec / 纯 JS ANN / better-sqlite3 | **sqlite-vec** | node:sqlite 原生支持 `load`，预编译二进制免编译、in-process 零服务 |
| 依赖形态 | 硬依赖 / 可选回退 | **硬依赖 + 加载失败回退** | 用户决策；sqlite-vec 轻（非「重依赖」），但保留回退防老 Node 崩 |
| 老化行为 | 降权不删 / 软清理 / 硬删除 | **降权不删** | 契合现有「不丢事实 + 可回滚」哲学 |
| 索引组织 | 影子表 / vec0 元数据列 | **影子表起步** | 最小侵入、易回退；元数据过滤留 Phase 2 |
| Node 版本 | ≥22.5 / ≥23.5 | **≥23.5（或 22.13 LTS）** | `loadExtension` 引入版本 |

---

## 12. 相关文件（现状）

- `extensions/long-term-memory/store.ts` — `MemoryStore`：建表/CRUD/`recall`/history/rollback（**主改**：影子表、rowid 同步、ANN 召回、老化字段、`save` upsert）
- `extensions/long-term-memory/embedding.ts` — `resolveEmbeddingConfig`/`embedTexts`（维度来源；基本不改）
- `extensions/long-term-memory/index.ts` — 工具/命令/注入接线（`recall` 调用方；过滤参数透传）
- `extensions/long-term-memory/consolidate.ts` — mem0 写入决策（**不改**，仅复用 `recall`）
- `extensions/long-term-memory/store.test.ts` / `consolidate.test.ts` — 测试风格与夹具参考
- `extensions/long-term-memory/package.json` — 新增 `dependencies: { "sqlite-vec": "*" }`、Node engines `>=23.5`
- `extensions/long-term-memory/README.md` — 更新配置/版本要求/「进阶扩展点」勾选

---

**状态：** 设计已经用户批准，待 writing-plans 定稿计划。下一步 → `superpowers:writing-plans` 产出 `2026-06-15-memory-retrieval-plan.md`。
