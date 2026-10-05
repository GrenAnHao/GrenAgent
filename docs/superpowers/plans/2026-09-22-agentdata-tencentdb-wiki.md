# AgentData TencentDB Wiki 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用 TencentDB MemoryKnowledge 的整套 wiki 替换未使用的一对一知识库，接到现有 Electron 进程。

**架构：** 引擎放在 `electron-agent/electron/agentData/wikiEngine/`。正文仍是 Markdown 目录，`index.db` 用 `node:sqlite`。库状态只存在 `agent-data.db` 的 `wiki_assets`。图用邻接表，不引入 graphology。模型调用走 `ModelRuntimeHost.completeSimple`。工作台使用全部操作，Agent 只有列出、检索、阅读。

**技术栈：** TypeScript、Vitest、`node:sqlite`、现有 `yaml`、Electron IPC。

**规格：** `docs/superpowers/specs/2026-09-22-agentdata-tencentdb-wiki-design.md`

**参考源（只读，不要改）：** `D:/System Dir/Downloads/TencentDB-Agent-Memory/MemoryKnowledge/src/engines/wiki` 与 `src/store/wiki-service.ts`、`src/store/build-queue.ts`、`src/store/serial-queue.ts`、`src/config.ts`。

**不做：** HTTP、租户、Panel、CodeGraph、启动时把 `pending`/`processing` 改成 `failed`、启动时重建 `ready` 库索引、旧数据迁移、`wiki_update`、`wiki_reindex`、Agent 抽取。

---

## 文件结构

创建：

- `electron-agent/electron/agentData/wikiEngine/logger.ts` — 本地日志，替代参考实现的 `createLogger`
- `electron-agent/electron/agentData/wikiEngine/graph.ts` — 无向邻接图与多跳检索
- `electron-agent/electron/agentData/wikiEngine/indexDb.ts` — `index.db` 四张表、读写连接、分词、FTS
- `electron-agent/electron/agentData/wikiEngine/llm.ts` — `LlmClient`，底层注入 `complete`
- `electron-agent/electron/agentData/wikiEngine/ingest/` — 从参考 `ingest-v2/` 拷入，改 import
- `electron-agent/electron/agentData/wikiEngine/manager.ts` — 从参考 `manager.ts` 改 sqlite 与图
- `electron-agent/electron/agentData/wikiEngine/service.ts` — 状态机、写入门、队列、级联后的索引重建
- `electron-agent/electron/agentData/wikiEngine/*.test.ts` — 行为测试

修改：

- `electron-agent/electron/agentData/runtime.ts` — 旧 `wiki.*` 换成新调用
- `electron-agent/electron/ipc/register.ts` — 旧 `agentData_wiki_*` 换成新命令
- `electron-agent/src/lib/agentData.ts` — 前端 API
- `electron-agent/src/features/agentData/wiki/` — 工作台改为新操作
- `extensions/wiki-rag/index.ts` — 三个工具
- `extensions/_shared/tool-groups.ts` — 从 `WRITE_TOOLS` 去掉两个旧工具
- `extensions/multi-agent/agents.ts` — `WRITE_TOOL_HINTS` 同步
- `docs/agent-data-wiki.md`、`docs/architecture.md` — 改成这套行为

删除：旧 `wikiStore`、`wikiLibraryStore`、`wikiSourceStore`、`wikiFiles`、`wikiContracts`、`wikiLibraryService`、`wikiSyncService` 及其一对一测试。不保留兼容用例。

每个拷入文件顶部保留一行：`Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).`

测试命令都在 `electron-agent` 目录执行，除非步骤写明 `extensions`。

---

### 任务 1：索引库

**文件：**

- 创建：`electron-agent/electron/agentData/wikiEngine/indexDb.ts`
- 测试：`electron-agent/electron/agentData/wikiEngine/indexDb.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { initIndexDb, withWriteDb } from './indexDb';

describe('index.db', () => {
  it('creates the four tables and rolls back a failed write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-index-'));
    initIndexDb(dir);
    const db = new DatabaseSync(join(dir, 'index.db'));
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all() as Array<{ name: string }>;
    expect(names.map((row) => row.name).sort()).toEqual(
      expect.arrayContaining(['wiki_fts', 'page_meta', 'graph_edge', 'source']),
    );
    db.close();
    expect(() => withWriteDb(dir, (write) => {
      write.prepare(`INSERT INTO page_meta(page_id,title,type,rel_path,snippet) VALUES(?,?,?,?,?)`).run('a', 'A', 'concept', 'wiki/concepts/a.md', '');
      throw new Error('boom');
    })).toThrow('boom');
    const check = new DatabaseSync(join(dir, 'index.db'));
    expect(check.prepare('SELECT COUNT(*) AS n FROM page_meta').get()).toEqual({ n: 0 });
    check.close();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/indexDb.test.ts`

预期：FAIL，`initIndexDb` 未定义。

- [ ] **步骤 3：编写最少实现代码**

`indexDb.ts` 用 `DatabaseSync`。没有 `pragma()` 和 `transaction()`。建表 SQL 与参考 `index-db.ts` 的 `initSchema` 相同：`wiki_fts` 使用 `tokenize = 'unicode61 remove_diacritics 0'`。

```ts
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -2000');
  db.exec('PRAGMA busy_timeout = 5000');
}

export function initIndexDb(wikiDir: string): void {
  const db = new DatabaseSync(join(wikiDir, 'index.db'));
  applyPragmas(db);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
    page_id UNINDEXED, title_tok, content_tok,
    tokenize = 'unicode61 remove_diacritics 0')`);
  db.exec(`CREATE TABLE IF NOT EXISTS page_meta (
    page_id TEXT PRIMARY KEY, title TEXT, type TEXT, rel_path TEXT, snippet TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS graph_edge (
    source_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY (source_id, target_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS source (
    filename TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_modified_by TEXT,
    ingested_at TEXT, ingest_error TEXT)`);
  db.close();
}

export function withWriteDb<T>(wikiDir: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(wikiDir, 'index.db'));
  applyPragmas(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}
```

读连接池在同文件后补：`Map`，`getReadDb` 命中时把 key 移到末尾，超过 `KNOWLEDGE_WIKI_POOL_MAX`（默认 300）时关闭并删除最久未用的连接。`evictWikiDb` 关闭并删除该 key。不要依赖 `lru-cache`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/indexDb.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine/indexDb.ts electron-agent/electron/agentData/wikiEngine/indexDb.test.ts
git commit -m "feat: add wiki index.db on node sqlite"
```

---

### 任务 2：邻接图多跳

**文件：**

- 创建：`electron-agent/electron/agentData/wikiEngine/graph.ts`
- 测试：`electron-agent/electron/agentData/wikiEngine/graph.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { createWikiGraph, graphMultiHopSearch } from './graph';

describe('wiki graph', () => {
  it('keeps seeds at hop 0 and decays neighbors', () => {
    const graph = createWikiGraph(
      [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
    );
    const hits = graphMultiHopSearch(graph, [{ id: 'a', score: 1 }], { hop: 2, decay: 0.5, minScore: 0.1 });
    expect(hits.find((hit) => hit.id === 'a')).toMatchObject({ hop: 0, score: 1 });
    expect(hits.find((hit) => hit.id === 'b')).toMatchObject({ hop: 1, score: 0.5, via: 'A' });
    expect(hits.find((hit) => hit.id === 'c')).toMatchObject({ hop: 2, score: 0.25 });
  });

  it('does not expand when hop is 0', () => {
    const graph = createWikiGraph(
      [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      [{ source: 'a', target: 'b' }],
    );
    expect(graphMultiHopSearch(graph, [{ id: 'a', score: 1 }], { hop: 0, decay: 0.5, minScore: 0.1 }).map((hit) => hit.id)).toEqual(['a']);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/graph.test.ts`

预期：FAIL，`createWikiGraph` 未定义。

- [ ] **步骤 3：编写最少实现代码**

把参考 `graph-search.ts` 的 `graphMultiHopSearch` 原样搬来。参数类型从 `Graph` 换成下面的接口。`neighbors` 返回无向邻居（边的两端互相可见），与参考实现的 undirected graphology 一致。默认 `maxNodes` 为 200。

```ts
export interface WikiGraph {
  hasNode(id: string): boolean;
  neighbors(id: string): string[];
  getNodeAttribute(id: string, key: 'label'): string | undefined;
}

export function createWikiGraph(
  nodes: Array<{ id: string; label: string }>,
  edges: Array<{ source: string; target: string }>,
): WikiGraph {
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const adj = new Map<string, Set<string>>();
  for (const node of nodes) adj.set(node.id, new Set());
  for (const edge of edges) {
    if (!adj.has(edge.source) || !adj.has(edge.target) || edge.source === edge.target) continue;
    adj.get(edge.source)!.add(edge.target);
    adj.get(edge.target)!.add(edge.source);
  }
  return {
    hasNode: (id) => adj.has(id),
    neighbors: (id) => [...(adj.get(id) ?? [])],
    getNodeAttribute: (id, key) => (key === 'label' ? labels.get(id) : undefined),
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/graph.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine/graph.ts electron-agent/electron/agentData/wikiEngine/graph.test.ts
git commit -m "feat: add wiki link traversal without graphology"
```

---

### 任务 3：分词与全文检索

**文件：**

- 修改：`electron-agent/electron/agentData/wikiEngine/indexDb.ts`
- 测试：`electron-agent/electron/agentData/wikiEngine/search.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ftsSearch, initIndexDb, tokenize, writeIndex } from './indexDb';

describe('wiki search index', () => {
  it('tokenizes CJK as bigrams and ranks a title hit above body-only text', () => {
    expect(tokenize('权限模型')).toEqual(expect.arrayContaining(['权限', '限模', '模型', '权限模型']));
    const dir = mkdtempSync(join(tmpdir(), 'wiki-fts-'));
    initIndexDb(dir);
    writeIndex(dir, [
      { id: 'title', title: '权限模型', type: 'concept', relPath: 'wiki/concepts/auth.md', content: '其他', links: [] },
      { id: 'body', title: '其他', type: 'concept', relPath: 'wiki/concepts/other.md', content: '权限模型在正文', links: [] },
    ]);
    const hits = ftsSearch(dir, '权限模型', 10);
    expect(hits[0].id).toBe('title');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits.every((hit) => hit.score > 0)).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/search.test.ts`

预期：FAIL，`tokenize` 未定义。

- [ ] **步骤 3：编写最少实现代码**

从参考 `manager.ts` 的 `tokenize`、`STOP_WORDS` 和 `ftsSearch` 搬过来。`ftsSearch` 的 SQL 保持：

```sql
SELECT page_id, bm25(wiki_fts, 5.0, 1.0) AS score
FROM wiki_fts WHERE wiki_fts MATCH ? ORDER BY score LIMIT ?
```

`bm25` 为负，返回前乘 `-1`。查询 token 加 `*` 前缀后用 `OR` 连接，内部双引号改成两个双引号。`writeIndex` 在 `withWriteDb` 里清空三张索引表再插入。`title_tok` 和 `content_tok` 存 `tokenize` 结果用空格连接。`[[wikilink]]` 解析出的边写入 `graph_edge`，只在可见页之间。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/search.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine/indexDb.ts electron-agent/electron/agentData/wikiEngine/search.test.ts
git commit -m "feat: add wiki full text search"
```

---

### 任务 4：建库

**文件：**

- 创建：`electron-agent/electron/agentData/wikiEngine/service.ts`
- 测试：`electron-agent/electron/agentData/wikiEngine/service.create.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WikiService } from './service';

describe('create wiki', () => {
  it('writes default templates, four tables, and a draft row without overwriting templates', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-root-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => 'unused' });
    const created = service.create({ name: '产品' });
    expect(created.status).toBe('draft');
    expect(existsSync(join(created.dir, 'wiki/purpose.md'))).toBe(true);
    expect(existsSync(join(created.dir, 'wiki/schema.md'))).toBe(true);
    expect(existsSync(join(created.dir, 'wiki/index.md'))).toBe(true);
    expect(existsSync(join(created.dir, 'raw/sources'))).toBe(true);
    expect(existsSync(join(created.dir, '.llm-wiki'))).toBe(true);
    expect(existsSync(join(created.dir, 'index.db'))).toBe(true);
    writeFileSync(join(created.dir, 'wiki/purpose.md'), '自定义', 'utf8');
    const again = service.create({ name: '产品' });
    expect(again.wikiId).toBe(created.wikiId);
    expect(again.status).toBe('draft');
    expect(readFileSync(join(created.dir, 'wiki/purpose.md'), 'utf8')).toBe('自定义');
  });
});
```

第二次 `create({ name: '产品' })` 返回同一个 `wikiId`，不覆盖已有模板。`wikiId` 拒绝 `..`、分隔符和 `wiki-sources.json`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/service.create.test.ts`

预期：FAIL，`WikiService` 未定义。

- [ ] **步骤 3：编写最少实现代码**

`wiki_assets` 列：`wiki_id`、`name`、`status`、`internal_status`、`sync_error`、`page_count`、`summary`、`version`、`last_sync_at`、`created_at`、`updated_at`。建库状态是 `draft`，`version` 为 0。目录是 `<root>/<wikiId>/`。默认模板正文用参考 `DEFAULT_PURPOSE` 和 `DEFAULT_SCHEMA`，外加 frontmatter。`index.md` 用参考 `initWikiProject` 的默认内容。文件已存在则不写。同时 `initIndexDb`。`<root>/wiki-sources.json` 只写 `{ [wikiId]: dir }`。

这是相对参考实现的显式偏差：模板在建库时写入，不是等首次抽取。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/service.create.test.ts`

预期：PASS。自定义模板在第二次 create 后仍是 `自定义`。在断言里读文件确认。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine/service.ts electron-agent/electron/agentData/wikiEngine/service.create.test.ts
git commit -m "feat: create a draft wiki with default templates"
```

---

### 任务 5：原文登记

**文件：**

- 修改：`electron-agent/electron/agentData/wikiEngine/service.ts`
- 测试：`electron-agent/electron/agentData/wikiEngine/raw.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it('records uploaded sources and does not call the model', async () => {
  let calls = 0;
  const service = new WikiService({ root, db, complete: async () => { calls += 1; return ''; } });
  const wiki = service.create({ name: '产品' });
  service.writeRaw(wiki.wikiId, 'note.md', '第一版');
  service.writeRaw(wiki.wikiId, 'note.md', '第一版');
  service.writeRaw(wiki.wikiId, 'note.md', '第二版');
  const rows = service.listRaw(wiki.wikiId);
  expect(rows).toEqual([expect.objectContaining({ filename: 'note.md', status: 'uploaded' })]);
  expect(calls).toBe(0);
  expect(() => service.writeRaw(wiki.wikiId, 'big.md', 'x'.repeat(5 * 1024 * 1024 + 1))).toThrow(/too_large/);
});
```

哈希未变时保留 `created_at` 且不改状态。哈希变了则回到 `uploaded` 并清空 `ingest_error`。超过 5 MB 拒绝。一次超过 50 个文件拒绝。`processing` 时写和删都拒绝。`draft` 时允许。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/raw.test.ts`

预期：FAIL，`writeRaw` 不存在。

- [ ] **步骤 3：编写最少实现代码**

原文路径限制在 `raw/sources/` 内，只接受 `.md` 和 `.txt`。`source` 行用参考 `recordSource` 的字段。列表读 `source` 表，不扫目录凑状态。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/raw.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine/service.ts electron-agent/electron/agentData/wikiEngine/raw.test.ts
git commit -m "feat: record wiki raw sources without calling a model"
```

---

### 任务 6：页面写入门

**文件：**

- 修改：`electron-agent/electron/agentData/wikiEngine/service.ts`
- 测试：`electron-agent/electron/agentData/wikiEngine/pageWrite.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it('injects locked true and rejects structural pages and escapes', () => {
  const wiki = service.create({ name: '产品' });
  const written = service.writePage(wiki.wikiId, 'concepts/auth', '# 权限');
  expect(written.lockedInjected).toBe(true);
  expect(service.readPage(wiki.wikiId, 'concepts/auth')).toContain('locked: true');
  expect(() => service.writePage(wiki.wikiId, 'purpose', 'x')).toThrow(/forbidden_path/);
  expect(() => service.removePage(wiki.wikiId, 'schema.md')).toThrow(/forbidden_path/);
  expect(() => service.writePage(wiki.wikiId, '../outside', 'x')).toThrow(/invalid_path/);
  expect(() => service.writePage(wiki.wikiId, 'concepts/big', 'x'.repeat(512 * 1024 + 1))).toThrow(/too_large/);
});
```

`index`、`schema`、`purpose` 在写入和删除时都拒绝，带不带 `wiki/` 和 `.md` 一样。`log` 和 `overview` 可以写。超过 20 条的批量读写删拒绝。库不是 `ready` 时 `listPages` 返回 `[]`，`readPage` 仍返回磁盘内容。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/pageWrite.test.ts`

预期：FAIL，`writePage` 不存在。

- [ ] **步骤 3：编写最少实现代码**

锁定注入沿用参考 `injectLockedTrue`：已有 `locked: true` 不重复，没有 frontmatter 时补上。拒绝列表就是参考 `PAGE_FORBIDDEN_REFS`。写入成功后调用与 `wikiMgr.sync` 相同的全量重建：扫描 `wiki/`、事务重写三张索引表、驱逐读连接。这样不跑抽取也能检索到新页。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/pageWrite.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine/service.ts electron-agent/electron/agentData/wikiEngine/pageWrite.test.ts
git commit -m "feat: lock wiki pages and rebuild the index after writes"
```

---

### 任务 7：状态门与重置

**文件：**

- 修改：`electron-agent/electron/agentData/wikiEngine/service.ts`
- 测试：`electron-agent/electron/agentData/wikiEngine/gates.test.ts`

- [ ] **步骤 1：编写失败的测试**

对 `draft`、`pending`、`ready`、`failed` 断言原文写/删和页面写/删成功。把状态写成 `processing` 后，这四类调用抛 `processing`。非 `ready` 时 `listPages`、`search`、`graph` 为空，`listRaw` 仍返回 `source` 行，`readPage` 仍返回磁盘内容。`resetDraft` 把 `pending` 或 `processing` 改回 `draft`，清掉 `internal_status` 和 `sync_error`，不删文件。不存在的库，读、列、检索抛 `not_found`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/gates.test.ts`

预期：FAIL，`resetDraft` 不存在。

- [ ] **步骤 3：编写最少实现代码**

门控表与规格 §4 一致。不要在服务启动时扫描并把 `pending`/`processing` 改成 `failed`。`resetDraft` 是唯一回到 `draft` 的通道。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/gates.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine/service.ts electron-agent/electron/agentData/wikiEngine/gates.test.ts
git commit -m "feat: gate wiki writes and allow an explicit draft reset"
```

---

### 任务 8：删除级联

**文件：**

- 创建：`electron-agent/electron/agentData/wikiEngine/ingest/cascade.ts`（从参考 `ingest-v2/cascade.ts` 拷入并改 import）
- 测试：`electron-agent/electron/agentData/wikiEngine/cascade.test.ts`

- [ ] **步骤 1：编写失败的测试**

准备两页：A 的 `sources` 只有 `note.md`，B 的 `sources` 有 `note.md` 和 `other.md`。C 含 `[[A]]`。删除原文 `note.md` 后 A 被删，B 仍在且 `sources` 只剩 `other.md`。删除页面 A 后，C 里的链接变成展示文本 `A`，不再是 `[[A]]`。`index.md`、`schema.md`、`purpose.md` 不参与级联。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/cascade.test.ts`

预期：FAIL。

- [ ] **步骤 3：编写最少实现代码**

拷入参考 `cascade.ts`。`removeRaw` 和 `removePage` 在改文件后重建索引，并删除或更新 `source` 行。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/cascade.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine/ingest/cascade.ts electron-agent/electron/agentData/wikiEngine/cascade.test.ts electron-agent/electron/agentData/wikiEngine/service.ts
git commit -m "feat: cascade wiki source and page deletes"
```

---

### 任务 9：抽取与合并

**文件：**

- 创建：`electron-agent/electron/agentData/wikiEngine/llm.ts`
- 创建：`electron-agent/electron/agentData/wikiEngine/logger.ts`
- 创建：`electron-agent/electron/agentData/wikiEngine/ingest/` 下参考 `ingest-v2` 的其余文件：`slug.ts`、`safe-path.ts`、`template.ts`、`prompts.ts`、`overview.ts`、`merge.ts`、`log-writer.ts`、`index-builder.ts`、`frontmatter.ts`、`file-protocol.ts`、`chunker.ts`、`index.ts`
- 测试：`electron-agent/electron/agentData/wikiEngine/ingest.test.ts`

- [ ] **步骤 1：编写失败的测试**

模型替身按调用标签返回固定 FILE 块。一份原文 `raw/sources/note.md` 抽出 `wiki/concepts/auth.md` 和 `wiki/sources/note.md`。第二轮原文未改且第一轮已是 `ingested` 时，替身调用次数不增加。把该原文标成 `failed` 且哈希不变，再次抽取必须再调用替身。

另一份原文让替身抛错，成功页保留，库为 `ready`，失败原文的 `source.status` 为 `failed`。两份都抛错时库为 `failed`，`sync_error` 含第一份文件名。

旧页正文 10 字且未锁定：替身收到整页重写请求。旧页正文 4001 字：替身收到追加请求，旧正文仍在结果里。`locked: true` 的旧页内容不变，该原文仍算成功。

可综述页面达到 2 张时写入 `overview.md`。让 overview 调用抛错，库仍为 `ready`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/ingest.test.ts`

预期：FAIL，`ingest` 不存在。

- [ ] **步骤 3：编写最少实现代码**

`llm.ts` 保留 `LlmClient.chat({ system, prompt, label })` 和 `RawLlmConfig`。`createLlmClient` 调用注入的 `complete(system, prompt)`，不读 `process.env`，不引用 `ai` 包。

`logger.ts`：

```ts
export function createLogger(_name: string) {
  return { info() {}, warn() {}, error() {}, debug() {} };
}
```

拷入的 ingest 文件只改 import：日志指向 `../logger.ts`，模型指向 `../llm.ts`。分块常量保持 28000、12000、400。合并阈值保持 4000。并发读取函数从参考 `config.ts` 拷成 `concurrency.ts`，默认 3 和 5。

`service.ingest`：无原文抛错且不调用模型。`pending` 或 `processing` 返回 `{ kind: 'busy' }`。否则 `version + 1`，状态 `pending`，进入串行队列。worker 把 `internal_status` 设为 `scanning`、`ingesting`、`rebuilding-index`。抽取前若取消标记存在，直接清理返回。全部失败在索引事务提交后抛错，库写 `failed`。部分失败写 `ready`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/ingest.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine
git commit -m "feat: ingest wiki sources into merged pages"
```

---

### 任务 10：检索结果与抽取中删除

**文件：**

- 修改：`electron-agent/electron/agentData/wikiEngine/service.ts`
- 修改：`electron-agent/electron/agentData/wikiEngine/manager.ts`（从参考 `manager.ts` 改掉 better-sqlite3 和 graphology）
- 测试：`electron-agent/electron/agentData/wikiEngine/query.test.ts`

- [ ] **步骤 1：编写失败的测试**

`ready` 库里 A 链接 B。`search('A', { hop: 0 })` 的结果 id 只有 A。`hop: 1`、`decay: 0.5` 时结果含 B，B 的分数是 A 的一半，并带 `via`。结果含 `path`、`title`、`snippet`、`score`、`type`、`hop`、`related`，响应含结果之间的 `links`。`related` 最多 10 条。

页面写入一个含 `[[A]]` 的新页后，不调用抽取，`search` 能命中它，`graph` 能看到这条边。

抽取开始后、模型返回前调用 `remove`。结束后 `read` 为未找到，目录不存在，库不是 `ready` 也不是 `failed`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/query.test.ts`

预期：FAIL。

- [ ] **步骤 3：编写最少实现代码**

`manager.search` 沿用参考默认值：`limit` 20、`hop` 0、`decay` 0.5、`minScore` 0.1，`hop` 限制 0 到 5。越界由 service 拒绝。种子先走 `ftsSearch`，`hop > 0` 再走 `graphMultiHopSearch`。`readPage` 接受 id、可带 `wiki/`、可带 `.md`，`raw/` 前缀读原文，越界返回 `null`。

删除在任何状态都接受。`processing` 时把 `wikiId` 放进取消 `Set`。worker 在入口和写最终状态前检查，命中则关读连接、删 `wiki_assets` 行、删 `wiki-sources.json` 项、`rmSync` 目录，不写 `ready` 或 `failed`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/query.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiEngine
git commit -m "feat: search wiki links and cancel a deleted ingest"
```

---

### 任务 11：替换主进程接线

**文件：**

- 修改：`electron-agent/electron/agentData/runtime.ts`
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`electron-agent/electron/ipc/register.test.ts`
- 修改：`electron-agent/src/lib/agentData.ts`
- 删除：`electron-agent/electron/agentData/wikiStore.ts`、`wikiLibraryStore.ts`、`wikiSourceStore.ts`、`wikiFiles.ts`、`wikiContracts.ts`、`wikiTestFixture.ts` 及对应测试
- 删除：`electron-agent/electron/app/wikiLibraryService.ts`、`wikiSyncService.ts` 及对应测试
- 测试：`electron-agent/electron/agentData/wikiEngine/runtime.test.ts`

- [ ] **步骤 1：编写失败的测试**

通过 runtime 的管理调用创建库、写原文、读页面。断言没有 `wiki.libraries.*`、`wiki.ingest` 任务和 `wiki.*` 审计写入。`completeSimple` 用替身。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agentData/wikiEngine/runtime.test.ts`

预期：FAIL，旧方法仍在或新方法不存在。

- [ ] **步骤 3：编写最少实现代码**

`runtime.ts` 持有一个 `WikiService`。模型注入：

```ts
complete: (system, prompt) => modelRuntimeHost.completeSimple({ systemPrompt: system, user: prompt })
```

IPC 命令改为 `agentData_wiki_create`、`read`、`list`、`update`、`remove`、`resetDraft`、`ingest`、`rawWrite`、`rawRemove`、`rawList`、`rawRead`、`pageWrite`、`pageRemove`、`pageList`、`pageRead`、`search`、`graph`。删除旧 `agentData_wiki_libraries_*`。诊断和审计里的 `wiki.*` 分支、`reindex_wiki` 动作一并去掉。旧一对一测试文件删除，不改写成兼容测试。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agentData/wikiEngine/runtime.test.ts electron/ipc/register.test.ts`

预期：PASS。全仓库再搜 `wiki.libraries`、`generatedPageId`、`wikiLibraryService`，结果只允许出现在被取代的旧规格路径之外；实现代码中为 0。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData electron-agent/electron/app electron-agent/electron/ipc electron-agent/src/lib/agentData.ts
git commit -m "feat: route agent data wiki through the new engine"
```

---

### 任务 12：Agent 工具

**文件：**

- 修改：`extensions/wiki-rag/index.ts`
- 修改：`extensions/wiki-rag/index.test.ts`
- 修改：`extensions/wiki-rag/client.ts`
- 修改：`extensions/_shared/tool-groups.ts`
- 修改：`extensions/_shared/tool-groups.test.ts`
- 修改：`extensions/multi-agent/agents.ts`
- 删除或改写：`extensions/wiki-rag/sync.ts`、`sync.test.ts`（只服务旧 `wiki_update`）

- [ ] **步骤 1：编写失败的测试**

```ts
expect(Object.keys(tools()).sort()).toEqual(['wiki_list', 'wiki_read', 'wiki_search']);
```

`wiki_search` 把 `hop`、`decay`、`minScore` 传给 `wiki.search`。`hop: 6` 在执行前拒绝。注册结果没有 `wiki_update` 和 `wiki_reindex`。`WRITE_TOOLS` 等于 `['ast_edit', 'hl_edit']`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run wiki-rag/index.test.ts _shared/tool-groups.test.ts`，工作目录 `extensions`。

预期：FAIL，仍注册五个工具。

- [ ] **步骤 3：编写最少实现代码**

三个工具的 `promptSnippet` 各一行。guidelines 写明使用 `wiki_list`、`wiki_search`、`wiki_read`，并写明不要猜测 `wikiId`。`wiki_list` 不传 `wikiId` 时列出全部库，传入时列出该库页面。`wiki_read` 用返回的 `wikiId` 和 `ref`。不要留抽取参数。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run wiki-rag/index.test.ts _shared/tool-groups.test.ts prompt-metadata.test.ts`，工作目录 `extensions`。

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/wiki-rag extensions/_shared/tool-groups.ts extensions/_shared/tool-groups.test.ts extensions/multi-agent/agents.ts
git commit -m "feat: limit agent wiki tools to list search and read"
```

---

### 任务 13：工作台

**文件：**

- 修改：`electron-agent/src/features/agentData/wiki/WikiLibraryList.tsx` 及测试
- 修改：`electron-agent/src/features/agentData/wiki/WikiLibraryWorkspace.tsx` 及测试
- 修改：`electron-agent/src/features/agentData/AgentDataCenter.test.tsx`
- 修改：`electron-agent/src/features/agentData/AuditDiagnosticsPanel.tsx`，去掉 wiki 重建索引入口
- 删除：只服务旧抽取预览、旧资料版本和旧锁定对话框的测试替身

- [ ] **步骤 1：编写失败的测试**

工作台测试用新的 `agentDataApi.wiki`。能看到：创建、上传原文、保存 `purpose.md`、开始抽取、页面列表、检索、删除、重置状态。`processing` 时上传按钮不可用。`pending` 时重置按钮可用。没有「重建索引」和「关联项目」。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/agentData/wiki src/features/agentData/AgentDataCenter.test.tsx`

预期：FAIL，仍调用 `wiki.libraries`。

- [ ] **步骤 3：编写最少实现代码**

沿用现有 Wiki 面板的位置和组件，不新增布局。创建调用 `create`。上传调用 `rawWrite`。模板编辑调用 `writeTemplate(wikiId, 'purpose' | 'schema', content)`：只允许这两个文件名，直接覆盖对应 Markdown，不注入 `locked`，不走 `writePage`。抽取调用 `ingest`，busy 时显示处理中。重置调用 `resetDraft`。检索调用 `search`。图谱数据只在这个面板读取，不注册成 Agent 工具。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/agentData/wiki src/features/agentData/AgentDataCenter.test.tsx src/features/agentData/AuditDiagnosticsPanel.test.tsx`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData
git commit -m "feat: point the wiki workbench at the new engine"
```

---

### 任务 14：文档与残留

**文件：**

- 修改：`docs/agent-data-wiki.md`
- 修改：`docs/architecture.md` 中的 wiki 段落
- 修改：`extensions/agent-data-manifests.ts`
- 修改：`cli/src/agent-data-plugins.test.ts`

- [ ] **步骤 1：编写失败的测试**

`cli/src/agent-data-plugins.test.ts` 里的工具清单改为 `wiki_list`、`wiki_read`、`wiki_search`。若该测试仍期望 `wiki_update`，先改断言再跑，确认当前实现失败或清单不一致。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/agent-data-plugins.test.ts`，工作目录 `cli`。

预期：FAIL，清单仍含旧工具或缺少三工具之一。

- [ ] **步骤 3：编写最少实现代码**

`docs/agent-data-wiki.md` 改成规格中的目录、`draft` 到 `failed`、写入门、重置入口和 Agent 三工具。删掉一对一抽取、项目绑定和 `wiki_reindex` 的说明。`docs/architecture.md` 的 wiki 段落与此一致。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/agent-data-plugins.test.ts`，工作目录 `cli`。

再运行：`npx vitest run electron/agentData/wikiEngine extensions` 不可行时，分别在 `electron-agent` 跑 `npx vitest run electron/agentData/wikiEngine`，在 `extensions` 跑 `npx vitest run wiki-rag prompt-metadata.test.ts _shared/tool-groups.test.ts`。

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add docs/agent-data-wiki.md docs/architecture.md extensions/agent-data-manifests.ts cli/src/agent-data-plugins.test.ts
git commit -m "docs: describe the TencentDB wiki replacement"
```

---

## 规格对照

- 整套引擎、状态机、队列、两个并发函数：任务 8、9、10。
- `node:sqlite` 四张表和事务：任务 1、3。
- 邻接图、默认 hop 和衰减：任务 2、10。
- 建库即写模板、`draft`、`wiki_assets`、`wiki-sources.json` 只存路径：任务 4。
- 原文 `uploaded`/`ingested`/`failed` 与容量：任务 5、9。
- 锁定、结构页、写后重建索引：任务 6、10。
- 状态门、重置 `draft`、不在启动时改写中断状态：任务 7。
- 级联删除：任务 8。
- 抽取顺序、部分失败、全部失败、overview 失败只警告：任务 9。
- 抽取中删除：任务 10。
- 去掉旧实现、任务和审计：任务 11。
- Agent 三工具和 `WRITE_TOOLS`：任务 12。
- 工作台全部操作：任务 13。
- 文档和插件清单：任务 14。
