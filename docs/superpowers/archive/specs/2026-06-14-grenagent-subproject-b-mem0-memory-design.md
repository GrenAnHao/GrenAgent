# 子项目 B：记忆系统迁移（mem0 风格智能记忆）— 设计

- 日期：2026-06-14
- 状态：设计待审（brainstorming 产出）
- 父任务：GrenAgent / Pi agent 能力补全（A→B→C，本文档为 **B**）
- 关联：A = 扩展能力 + 安全框架（已完成）；C = 借鉴 MiMo-Code/opencode 深度优化
- 决策来源：brainstorming（2026-06-14，用户逐项确认）

## 1. 目标

把现有 `extensions/long-term-memory/` 从「朴素 append + hash 去重」升级为 **mem0 风格智能记忆**：写入时用 LLM 抽取事实、召回相似旧记忆、决策 `ADD/UPDATE/DELETE/NOOP`，自动消解重复与矛盾；并提供**完整的变更历史、每条记忆的版本历史与回滚**。

核心价值（对比现状）：当前 `uses npm` 之后又出现 `uses pnpm` 会**两条都留**；mem0 风格会 UPDATE/DELETE 旧的，使记忆保持一致、可解释、可审计。

## 2. 关键决策（brainstorming 已确认）

| 决策点 | 选择 |
|--------|------|
| 迁移方式 | **B：在现有 `node:sqlite`/`bun:sqlite` 上自研 mem0 风格管线**（非官方 mem0 库、非云）。本地零外部依赖，可进 `bun --compile` 单文件二进制 |
| 智能合并生效范围 | **所有写入**（`memory_save` 工具 / `/memory add` / 自动提取）默认走智能合并；`MEMORY_SMART=0` 退回朴素 hash 去重 |
| LLM 调用方式 | **进程内直调** `completeSimple(ctx.model, …)`（`@earendil-works/pi-ai` 已是依赖）；默认用当前模型 `ctx.model`，`MEMORY_MODEL` 可覆盖（经 `ctx.modelRegistry` 解析） |
| 历史/版本 | **完整**：`memory_history` 表 + 时间线 UI + 每条记忆版本历史 + 回滚 |

## 3. 背景与现状

现状 `extensions/long-term-memory/`：
- `store.ts`：`bun:sqlite`（经 `extensions/_shared/sqlite.ts` 跨运行时 shim）。表 `memories(id, text, category, createdAt, embedding)`；`id = sha1(lower(text))[:12]`，`INSERT OR REPLACE` 幂等；cosine（有 embedding）或关键词召回。
- `embedding.ts`：OpenAI 兼容 `/embeddings`，无 key 时降级关键词。
- `index.ts`：`memory_save` / `memory_recall` 工具 + `/memory list|add|forget|clear|promote` 命令 + `before_agent_start` 自动召回注入 + 「记住:」自动捕获 + `agent_end` 自动提取（默认关）。两级 scope：项目 `<cwd>/.pi/memory/memory.db`、全局 `~/.pi/agent/long-term-memory.db`。
- `extractor.ts`：`agent_end` 时 **spawn 一个 pi 子进程** 抽取要点（`--mode json -p --no-session`）。
- Rust `src-tauri/src/commands/memory.rs`：只读 `mem_stats` / `mem_list`。
- 前端 `src/features/memory/MemoryPanel.tsx`：列表/筛选/添加/删除/清空/提升，变更经 `pi.runCommand('/memory ...')`。

关键技术事实（已核实）：
- `ExtensionContext` 暴露 `model: Model` 与 `modelRegistry: ModelRegistry`；`@earendil-works/pi-ai` 导出 `complete()/completeSimple(model, context, options)` → 扩展可**进程内**直调 LLM，取代旧的 spawn 子进程。
- `extensions/_shared/sqlite.ts` 已在运行时按 Bun 选 `bun:sqlite`、Node 选 `node:sqlite`，本设计沿用，不引入新依赖。

## 4. 架构

面向隔离设计，拆为职责单一、可独立测试的单元。

### 4.1 `store.ts`（扩展持久层）

**表结构变更（向后兼容迁移）：**

```sql
-- 现有 memories 表加列
ALTER TABLE memories ADD COLUMN updatedAt INTEGER;   -- 迁移：默认 = createdAt
ALTER TABLE memories ADD COLUMN version  INTEGER;     -- 迁移：默认 = 1

-- 新表：变更历史 + 版本（每个 scope 的 db 各自一份）
CREATE TABLE IF NOT EXISTS memory_history (
  historyId   INTEGER PRIMARY KEY AUTOINCREMENT,
  memoryId    TEXT NOT NULL,
  op          TEXT NOT NULL,          -- ADD | UPDATE | DELETE | ROLLBACK
  oldText     TEXT,
  newText     TEXT,
  oldCategory TEXT,
  newCategory TEXT,
  reason      TEXT,                    -- LLM/用户给出的变更原因
  model       TEXT,                    -- 触发本次决策的模型（智能合并时）
  version     INTEGER NOT NULL,
  createdAt   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_memory ON memory_history(memoryId, historyId);
```

**迁移策略**：`load()` 时检测缺列（`PRAGMA table_info`），缺则 `ALTER TABLE` 补列并回填（`updatedAt=createdAt`、`version=1`），建空 `memory_history`。不丢任何现有数据。

**新增方法**（均记 history）：
- `insert({ text, category?, embedding? }, reason, model?): { id }` — 智能路径新增；生成**稳定 id**（见下），写 `ADD` 历史行
- `getById(id): Memory | undefined`
- `update(id, { text?, category?, embedding? }, reason, model?): { version }` — `version++`、`updatedAt=now`、写 `UPDATE` 历史行
- `remove(id, reason, model?): boolean` — 删除 `memories` 行、写 `DELETE` 历史行（保留 `oldText` 以便回滚）
- `history(memoryId?): HistoryRow[]` — 全量时间线或单条记忆版本史
- `rollback(historyId): { id }` — 取该历史行的「目标状态」重放为一次新 `update`/`insert`（再记一条 `ROLLBACK` 历史），不物理改旧历史
- 保留 `save()`（`MEMORY_SMART=0` 朴素路径）、`recall()`、`list()`、`clear()`、`forget()`、`stats()`

> **id 策略（关键）**：智能路径 `insert` 用**与内容解耦的稳定 id**（随机 12 位 hex，或 `sha1(text+now)`），这样 `UPDATE` 改文本时 id 不变、版本史可串联。朴素 `save`（`MEMORY_SMART=0`）仍用内容哈希 id（`sha1(lower(text))[:12]`）保持幂等去重。两条路径都补记 `ADD` 历史以便 UI 一致。`recall` 返回的候选含 `id`，供 `reconcile` 决策定位 `targetId`。

### 4.2 `llm.ts`（新，进程内 LLM 封装）

- `resolveMemoryModel(ctx): Model` — `MEMORY_MODEL` 经 `ctx.modelRegistry` 解析，否则回退 `ctx.model`；都没有则抛「无可用模型」（调用方据此回退朴素路径）。
- `askJson<T>(model, systemPrompt, userPrompt, signal?): Promise<T>` — 用 `completeSimple(model, context)` 取最终文本，鲁棒解析 JSON（容忍 ```json 围栏、前后噪声）；失败抛错。
- LLM 调用以**函数注入**方式提供给 `consolidate`，使其单测可 mock，不依赖真实模型。

### 4.3 `consolidate.ts`（新，mem0 管线）

- `extractFacts(askJsonFn, conversation): Promise<string[]>` — 仅自动提取路径：从整段对话抽取「值得长期记住的原子事实」。
- `reconcile(askJsonFn, candidates: Memory[], newFact): Promise<Decision>` — `Decision = { op: 'ADD'|'UPDATE'|'DELETE'|'NOOP', targetId?, text?, category?, reason }`。给 LLM 候选相似记忆 + 新事实，要求 JSON 决策。
- 编排 `consolidate(store, fact, { askJsonFn, embedConfig, model }): Promise<AppliedOp[]>`：
  1. `store.recall(fact, K, embedConfig)` 取相似候选（无 key → 关键词）。
  2. **无候选 → 直接 `ADD`**（省一次 LLM 调用）。
  3. 有候选 → `reconcile` → 应用：ADD/`store.insert`、UPDATE/`store.update`、DELETE/`store.remove`、NOOP/跳过。
  4. 返回 applied ops（供工具结果/notice 展示）。
- 纯逻辑（决策→落库映射、JSON 解析、候选裁剪）与 LLM 调用分离，便于测试。

### 4.4 `index.ts`（改）

- `memory_save` 工具、`/memory add`、`agent_end` 自动提取：`MEMORY_SMART≠0` 走 `consolidate()`，否则朴素 `save()`。
- 自动提取改为**进程内** `extractFacts`（用 `ctx.model`），逐条 `consolidate`。
- 新命令：`/memory history [id]`（打印时间线/版本）、`/memory rollback <historyId>`。
- 智能合并产生 UPDATE/DELETE 时，发一条轻量 `display` notice（如「🧠 记忆已更新：旧X → 新Y（原因）」），`MEMORY_SMART_NOTICE=0` 关闭。
- 保留自动召回注入、自动捕获不变。

### 4.5 `extractor.ts`（退役）

进程内 `extractFacts` 取代旧 spawn 子进程提取，删除 `extractor.ts` 与其 stdin/子进程复杂度（及 `extractor.test.ts` 相应调整/移除）。`MEMORY_EXTRACT` 开关语义保留（控制 `agent_end` 是否自动提取）。

### 4.6 Rust 层（`src-tauri/src/commands/memory.rs`）

- 新增只读 `mem_history(workspace, memory_id: Option<String>) -> Vec<MemHistoryItem>`（读 `memory_history`，按 `historyId` DESC；可按 `memoryId` 过滤）。两级 scope 合并并标 `scope`。
- 变更（rollback/forget/clear/add/promote）仍走 `/memory ...` 命令（与现有模式一致，Rust 保持只读）。
- 注册命令到 `invoke_handler`。

### 4.7 前端（`src/features/memory/`）

- `MemoryPanel.tsx`：
  - 顶部加视图切换：「记忆」（现状）/「历史」（时间线）。
  - 历史时间线：每行 op + 前后文本 + 原因 + 时间 + scope。
  - 选中某条记忆时，详情区展示其**版本历史**（该 memoryId 的 history）+「回滚到此版本」按钮 → `pi.runCommand('/memory rollback <historyId>')` → reload。
- `lib/pi.ts`：加 `memHistory(workspace, memoryId?)` 绑定 + `MemHistoryItem` 类型。

### 4.8 设置（`settingsSchema.ts`，「记忆」分类）

新增：`MEMORY_SMART`（默认开，0 关）、`MEMORY_MODEL`（留空＝继承当前模型）、`MEMORY_SMART_NOTICE`（默认开，0 关）。

## 5. 数据流

```
写入（memory_save 工具 / /memory add / agent_end 自动提取）
  → consolidate(): recall 相似候选(embedding/关键词) → LLM 决策 ADD/UPDATE/DELETE/NOOP
  → store 落库 + 记 memory_history
  → 工具结果 / 轻量 notice 展示「变更了什么」
读取/管理
  MemoryPanel → RPC(mem_stats / mem_list / mem_history) → 渲染 当前记忆 + 时间线 + 版本史
  回滚/删除/清空/添加/提升 → pi.runCommand('/memory ...') → store 变更 + 记历史
```

## 6. 错误处理

- LLM 决策失败 / JSON 非法 / 无可用模型 → **回退为朴素 ADD**（绝不丢事实），可选 warn。
- 无 embedding key → 关键词召回候选，决策照常。
- `MEMORY_SMART=0` → 完全跳过 LLM，朴素 hash 去重（现行为）。
- `rollback` 不存在的 historyId → notify warn。
- 旧库无新列 → 迁移自动补列，零数据丢失。

## 7. 测试策略

- `consolidate.test.ts`（注入 mock LLM）：无匹配→ADD、矛盾→UPDATE、过时→DELETE、重复→NOOP、非法 JSON→ADD 回退。
- `store.test.ts`（扩展）：`update/remove/history/rollback`；旧 schema 迁移（补列+回填+建 history）。
- Rust：`mem_history` 读取 + scope 标注（沿用 `memory.rs` 现有测试风格）。
- 前端：MemoryPanel 历史视图渲染 + 回滚动作（mock `pi`）。
- 集成：`build-sidecar.mjs` 重建 + 启动冒烟。

## 8. 实现顺序（交给 writing-plans 拆 phase）

`B1 store 迁移+历史/版本/回滚 → B2 llm.ts 进程内调用 → B3 consolidate 管线 → B4 index 接线（含 extractor 退役、新命令、notice）→ B5 Rust mem_history → B6 前端历史/版本/回滚 UI → B7 settings + 重建冒烟`

每 phase 自带 TDD（红→绿→重构）+ commit。

## 9. 文件清单

**新增**：
- `extensions/long-term-memory/consolidate.ts` + `consolidate.test.ts`
- `extensions/long-term-memory/llm.ts`
- 前端历史/版本视图（`MemoryPanel.tsx` 内或拆子组件 `MemoryHistory.tsx`）

**修改**：
- `extensions/long-term-memory/store.ts`、`store.test.ts`
- `extensions/long-term-memory/index.ts`
- `extensions/long-term-memory/README.md`（文档智能合并/历史/回滚）
- `src-tauri/src/commands/memory.rs` + 命令注册处
- `src/features/memory/MemoryPanel.tsx`、`src/lib/pi.ts`
- `src/features/settings/settingsSchema.ts`

**退役**：
- `extensions/long-term-memory/extractor.ts`（+ `extractor.test.ts`）

## 10. 非目标（YAGNI）

- 不做图记忆 / 实体-关系（留待 C 或后续）。
- 不接外部向量库（仍 cosine；大规模时再上 `sqlite-vec`）。
- 不接 mem0 官方库 / mem0 云。
- 不改两级 scope、embedding、自动召回/捕获的既有语义（仅在写入路径插入智能合并）。
