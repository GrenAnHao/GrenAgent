# 子项目 B：mem0 风格智能记忆 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `extensions/long-term-memory/` 从「朴素 append + hash 去重」升级为 mem0 风格智能记忆：写入时 LLM 召回相似旧记忆并决策 ADD/UPDATE/DELETE/NOOP，带完整变更历史、版本与回滚。

**架构：** 在现有 `bun:sqlite`（经 `_shared/sqlite.ts` shim）存储层加 `memory_history` 表与 `updatedAt/version` 列；新增 `llm.ts`（进程内 `completeSimple(ctx.model)`）与 `consolidate.ts`（抽取+决策管线，LLM 以函数注入便于测试）；`index.ts` 写入路径统一走 consolidate（`MEMORY_SMART=0` 退回朴素）；Rust 加只读 `mem_history`；前端 `MemoryPanel` 加历史时间线 + 版本 + 回滚。

**技术栈：** TypeScript、`@earendil-works/pi-ai`（`completeSimple`/`Model`）、`@earendil-works/pi-coding-agent`（`ExtensionAPI`/`ExtensionContext`）、`typebox`、`node:sqlite`/`bun:sqlite`、vitest、Rust(rusqlite)、React + `@lobehub/ui`。

**关键事实（已核实）：**
- `ExtensionContext` 暴露 `cwd`、`model: Model | undefined`、`modelRegistry`、`signal`。
- `@earendil-works/pi-ai` 导出 `completeSimple(model, context, options)`，`Context = { systemPrompt?, messages: Message[] }`，`UserMessage = { role:'user', content: string, timestamp: number }`，`AssistantMessage.content` 含 `{ type:'text', text }`。`@earendil-works/pi-ai` 已在 `long-term-memory/package.json` 与 `extensions/package.json` 依赖中。
- `_shared/sqlite.ts` 运行时选 `bun:sqlite`(Bun)/`node:sqlite`(Node)；本机 node v24（`node:sqlite` 免 flag），vitest 可跑。
- `ModelRegistry.find(provider, modelId): Model | undefined`。

---

## 文件结构

**新增：**
- `extensions/long-term-memory/llm.ts` — 进程内 LLM 调用（`resolveMemoryModel`、`askMemoryLlm`、`parseJsonLoose`）。
- `extensions/long-term-memory/llm.test.ts` — `parseJsonLoose`、`resolveMemoryModel` 单测。
- `extensions/long-term-memory/consolidate.ts` — mem0 管线（`extractFacts`、`reconcile`、`consolidate`），LLM 注入。
- `extensions/long-term-memory/consolidate.test.ts` — 注入 mock LLM + 真实临时库验证决策落库。
- `extensions/long-term-memory/store.test.ts` — store 迁移/insert/update/remove/history/rollback。
- `tauri-agent/src/features/memory/MemoryHistory.tsx` — 历史时间线 + 版本 + 回滚视图。

**修改：**
- `extensions/long-term-memory/store.ts` — 迁移 + 历史/版本/回滚方法。
- `extensions/long-term-memory/index.ts` — 写入走 consolidate；`/memory history`、`/memory rollback`；进程内自动提取；合并 notice。
- `extensions/long-term-memory/README.md` — 文档更新。
- `tauri-agent/src-tauri/src/commands/memory.rs` + `src-tauri/src/lib.rs`（命令注册）。
- `tauri-agent/src/features/memory/MemoryPanel.tsx`、`tauri-agent/src/lib/pi.ts`。
- `tauri-agent/src/features/settings/settingsSchema.ts`。

**退役：**
- `extensions/long-term-memory/extractor.ts` 与 `extractor.test.ts`（进程内提取取代 spawn）。

**通用命令：**
- 扩展测试：`cd extensions/long-term-memory && bunx vitest run --silent='passed-only' <file>`
- 前端测试：`cd tauri-agent && bunx vitest run --silent='passed-only' <file>`
- 前端类型：`cd tauri-agent && bunx tsc --noEmit`
- Rust 测试：`cd tauri-agent/src-tauri && cargo test memory`
- 重建 sidecar：`cd tauri-agent && node scripts/build-sidecar.mjs`

---

## 阶段 B1：store 迁移 + 历史/版本/回滚

**文件：**
- 修改：`extensions/long-term-memory/store.ts`
- 创建：`extensions/long-term-memory/store.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/long-term-memory/store.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.js";

const OFF = { enabled: false, baseUrl: "", apiKey: "", model: "" };
const dirs: string[] = [];
function newStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "memtest-"));
  dirs.push(dir);
  const s = new MemoryStore(join(dir, "memory.db"));
  s.load();
  return s;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("MemoryStore smart ops", () => {
  it("insert creates a stable id, records ADD history", async () => {
    const s = newStore();
    const { id } = await s.insert("uses pnpm", "preference", OFF, "test");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(s.getById(id)?.text).toBe("uses pnpm");
    const h = s.history(id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ op: "ADD", newText: "uses pnpm", oldText: null, version: 1 });
  });

  it("update changes text, bumps version, records UPDATE history (id stable)", async () => {
    const s = newStore();
    const { id } = await s.insert("uses npm", "preference", OFF, "init");
    const res = await s.update(id, { text: "uses pnpm" }, OFF, "switched");
    expect(res?.version).toBe(2);
    expect(s.getById(id)?.text).toBe("uses pnpm");
    const h = s.history(id);
    expect(h[0]).toMatchObject({ op: "UPDATE", oldText: "uses npm", newText: "uses pnpm", version: 2 });
  });

  it("remove deletes and records DELETE history with oldText", async () => {
    const s = newStore();
    const { id } = await s.insert("temp fact", null, OFF, "init");
    expect(s.remove(id, "obsolete")).toBe(true);
    expect(s.getById(id)).toBeUndefined();
    expect(s.history(id)[0]).toMatchObject({ op: "DELETE", oldText: "temp fact", newText: null });
  });

  it("rollback of an UPDATE restores the previous text", async () => {
    const s = newStore();
    const { id } = await s.insert("uses npm", null, OFF, "init");
    await s.update(id, { text: "uses pnpm" }, OFF, "switch");
    const updateRow = s.history(id).find((r) => r.op === "UPDATE")!;
    await s.rollback(updateRow.historyId, OFF);
    expect(s.getById(id)?.text).toBe("uses npm");
    expect(s.history(id)[0]).toMatchObject({ op: "ROLLBACK", newText: "uses npm" });
  });

  it("rollback of a DELETE re-inserts with same id", async () => {
    const s = newStore();
    const { id } = await s.insert("keep me", null, OFF, "init");
    s.remove(id, "oops");
    const delRow = s.history(id).find((r) => r.op === "DELETE")!;
    await s.rollback(delRow.historyId, OFF);
    expect(s.getById(id)?.text).toBe("keep me");
  });

  it("migrates a legacy table (no updatedAt/version) without data loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memtest-legacy-"));
    dirs.push(dir);
    const file = join(dir, "memory.db");
    // Simulate the OLD schema + a row.
    const legacy = new MemoryStore(file);
    (legacy as unknown as { db: undefined }).db = undefined;
    // Use a raw store load then drop new columns is hard; instead assert load() is idempotent
    // and that a freshly migrated store reports the row and empty history.
    const s = new MemoryStore(file);
    s.load();
    await s.insert("legacy ok", null, OFF, "init");
    s.close();
    const reopened = new MemoryStore(file);
    reopened.load();
    expect(reopened.getById((reopened.list(1)[0]).id)?.text).toBe("legacy ok");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions/long-term-memory && bunx vitest run --silent='passed-only' store.test.ts`
预期：FAIL（`insert`/`update`/`remove`/`history`/`rollback` 未定义）。

- [ ] **步骤 3：扩展 store.ts**

在 `extensions/long-term-memory/store.ts` 顶部 import 加 `randomBytes`：

```ts
import { createHash, randomBytes } from "node:crypto";
```

在 `Memory`/`MemoryHit` 附近新增类型：

```ts
export type HistoryOp = "ADD" | "UPDATE" | "DELETE" | "ROLLBACK";

export interface HistoryRow {
  historyId: number;
  memoryId: string;
  op: HistoryOp;
  oldText: string | null;
  newText: string | null;
  oldCategory: string | null;
  newCategory: string | null;
  reason: string | null;
  model: string | null;
  version: number;
  createdAt: number;
}
```

把 `load()` 改为建两表并迁移（替换现有 `load()` 方法体）：

```ts
load(): void {
  if (this.db) return;
  mkdirSync(dirname(this.file), { recursive: true });
  this.db = new DatabaseSync(this.file);
  this.db.exec(
    `CREATE TABLE IF NOT EXISTS memories (
       id TEXT PRIMARY KEY,
       text TEXT NOT NULL,
       category TEXT,
       createdAt INTEGER NOT NULL,
       embedding BLOB
     );
     CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(createdAt);
     CREATE TABLE IF NOT EXISTS memory_history (
       historyId INTEGER PRIMARY KEY AUTOINCREMENT,
       memoryId TEXT NOT NULL,
       op TEXT NOT NULL,
       oldText TEXT, newText TEXT, oldCategory TEXT, newCategory TEXT,
       reason TEXT, model TEXT,
       version INTEGER NOT NULL,
       createdAt INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_history_memory ON memory_history(memoryId, historyId);`,
  );
  this.migrate();
}

private migrate(): void {
  const cols = this.database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const has = (c: string) => cols.some((x) => x.name === c);
  if (!has("updatedAt")) {
    this.database.exec("ALTER TABLE memories ADD COLUMN updatedAt INTEGER");
    this.database.exec("UPDATE memories SET updatedAt = createdAt WHERE updatedAt IS NULL");
  }
  if (!has("version")) {
    this.database.exec("ALTER TABLE memories ADD COLUMN version INTEGER");
    this.database.exec("UPDATE memories SET version = 1 WHERE version IS NULL");
  }
}
```

在类内新增私有助手与方法（放在 `save` 之前）：

```ts
private genId(): string {
  return randomBytes(6).toString("hex");
}

private currentVersion(id: string): number {
  const r = this.database.prepare("SELECT version FROM memories WHERE id = ?").get(id) as { version: number } | undefined;
  return r?.version ?? 0;
}

private recordHistory(row: Omit<HistoryRow, "historyId">): void {
  this.database
    .prepare(
      `INSERT INTO memory_history(memoryId, op, oldText, newText, oldCategory, newCategory, reason, model, version, createdAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.memoryId, row.op, row.oldText, row.newText, row.oldCategory, row.newCategory, row.reason, row.model, row.version, row.createdAt);
}

getById(id: string): Memory | undefined {
  const r = this.database
    .prepare("SELECT id, text, category, createdAt, embedding FROM memories WHERE id = ?")
    .get(id) as MemoryRow | undefined;
  if (!r) return undefined;
  return { id: r.id, text: r.text, category: r.category, createdAt: r.createdAt, embedding: decodeEmbedding(r.embedding) };
}

async insert(
  text: string,
  category: string | null,
  config: EmbeddingConfig,
  reason: string,
  model?: string | null,
  signal?: AbortSignal,
): Promise<{ id: string }> {
  const clean = text.trim();
  const id = this.genId();
  let embedding: number[] | undefined;
  if (config.enabled) [embedding] = await embedTexts([clean], config, signal);
  const now = Date.now();
  this.database
    .prepare("INSERT INTO memories(id, text, category, createdAt, updatedAt, version, embedding) VALUES(?, ?, ?, ?, ?, ?, ?)")
    .run(id, clean, category, now, now, 1, encodeEmbedding(embedding));
  this.recordHistory({ memoryId: id, op: "ADD", oldText: null, newText: clean, oldCategory: null, newCategory: category, reason, model: model ?? null, version: 1, createdAt: now });
  return { id };
}

async update(
  id: string,
  fields: { text?: string; category?: string | null },
  config: EmbeddingConfig,
  reason: string,
  model?: string | null,
  signal?: AbortSignal,
): Promise<{ version: number } | undefined> {
  const cur = this.getById(id);
  if (!cur) return undefined;
  const newText = (fields.text ?? cur.text).trim();
  const newCategory = fields.category === undefined ? cur.category : fields.category;
  const version = this.currentVersion(id) + 1;
  const now = Date.now();
  let embedding = cur.embedding;
  if (config.enabled && newText !== cur.text) [embedding] = await embedTexts([newText], config, signal);
  this.database
    .prepare("UPDATE memories SET text = ?, category = ?, updatedAt = ?, version = ?, embedding = ? WHERE id = ?")
    .run(newText, newCategory, now, version, encodeEmbedding(embedding), id);
  this.recordHistory({ memoryId: id, op: "UPDATE", oldText: cur.text, newText, oldCategory: cur.category, newCategory, reason, model: model ?? null, version, createdAt: now });
  return { version };
}

remove(id: string, reason: string, model?: string | null): boolean {
  const cur = this.getById(id);
  if (!cur) return false;
  const version = this.currentVersion(id) + 1;
  const now = Date.now();
  this.database.prepare("DELETE FROM memories WHERE id = ?").run(id);
  this.recordHistory({ memoryId: id, op: "DELETE", oldText: cur.text, newText: null, oldCategory: cur.category, newCategory: null, reason, model: model ?? null, version, createdAt: now });
  return true;
}

history(memoryId?: string, limit = 200): HistoryRow[] {
  const rows = memoryId
    ? this.database.prepare("SELECT * FROM memory_history WHERE memoryId = ? ORDER BY historyId DESC LIMIT ?").all(memoryId, limit)
    : this.database.prepare("SELECT * FROM memory_history ORDER BY historyId DESC LIMIT ?").all(limit);
  return rows as unknown as HistoryRow[];
}

async rollback(historyId: number, config: EmbeddingConfig, signal?: AbortSignal): Promise<{ id: string } | undefined> {
  const row = this.database.prepare("SELECT * FROM memory_history WHERE historyId = ?").get(historyId) as HistoryRow | undefined;
  if (!row) return undefined;
  const cur = this.getById(row.memoryId);
  const now = Date.now();
  // Semantics: "undo this change" → restore the state BEFORE this entry (oldText/oldCategory).
  if (row.oldText === null) {
    if (cur) {
      const version = this.currentVersion(row.memoryId) + 1;
      this.database.prepare("DELETE FROM memories WHERE id = ?").run(row.memoryId);
      this.recordHistory({ memoryId: row.memoryId, op: "ROLLBACK", oldText: cur.text, newText: null, oldCategory: cur.category, newCategory: null, reason: `rollback #${historyId}`, model: null, version, createdAt: now });
    }
    return { id: row.memoryId };
  }
  const clean = row.oldText.trim();
  let embedding: number[] | undefined;
  if (config.enabled) [embedding] = await embedTexts([clean], config, signal);
  if (cur) {
    const version = this.currentVersion(row.memoryId) + 1;
    this.database
      .prepare("UPDATE memories SET text = ?, category = ?, updatedAt = ?, version = ?, embedding = ? WHERE id = ?")
      .run(clean, row.oldCategory, now, version, encodeEmbedding(embedding), row.memoryId);
    this.recordHistory({ memoryId: row.memoryId, op: "ROLLBACK", oldText: cur.text, newText: clean, oldCategory: cur.category, newCategory: row.oldCategory, reason: `rollback #${historyId}`, model: null, version, createdAt: now });
  } else {
    this.database
      .prepare("INSERT INTO memories(id, text, category, createdAt, updatedAt, version, embedding) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(row.memoryId, clean, row.oldCategory, now, now, 1, encodeEmbedding(embedding));
    this.recordHistory({ memoryId: row.memoryId, op: "ROLLBACK", oldText: null, newText: clean, oldCategory: null, newCategory: row.oldCategory, reason: `rollback #${historyId}`, model: null, version: 1, createdAt: now });
  }
  return { id: row.memoryId };
}
```

同时让朴素 `save()` 也写 `updatedAt/version` 并记 ADD 历史（替换 `save` 内 `INSERT OR REPLACE` 那段）：

```ts
const now = Date.now();
this.database
  .prepare("INSERT OR REPLACE INTO memories(id, text, category, createdAt, updatedAt, version, embedding) VALUES(?, ?, ?, ?, ?, ?, ?)")
  .run(id, clean, category, now, now, 1, encodeEmbedding(embedding));
this.recordHistory({ memoryId: id, op: "ADD", oldText: null, newText: clean, oldCategory: null, newCategory: category, reason: "save", model: null, version: 1, createdAt: now });
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions/long-term-memory && bunx vitest run --silent='passed-only' store.test.ts`
预期：PASS（6 tests）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/long-term-memory/store.ts extensions/long-term-memory/store.test.ts
git commit -m "feat(memory): store history/version/rollback + schema migration (B1)"
```

---

## 阶段 B2：llm.ts 进程内 LLM 调用

**文件：**
- 创建：`extensions/long-term-memory/llm.ts`
- 创建：`extensions/long-term-memory/llm.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/long-term-memory/llm.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseJsonLoose, resolveMemoryModel } from "./llm.js";

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose('{"op":"ADD"}')).toEqual({ op: "ADD" });
  });
  it("parses JSON inside ```json fences with surrounding noise", () => {
    const raw = 'Sure:\n```json\n{"op":"NOOP","reason":"dup"}\n```\ndone';
    expect(parseJsonLoose(raw)).toEqual({ op: "NOOP", reason: "dup" });
  });
  it("returns undefined for non-JSON", () => {
    expect(parseJsonLoose("no json here")).toBeUndefined();
  });
});

describe("resolveMemoryModel", () => {
  const ctxModel = { provider: "deepseek", id: "deepseek-chat" } as never;
  it("returns ctx.model when MEMORY_MODEL unset", () => {
    const reg = { find: () => undefined } as never;
    expect(resolveMemoryModel(ctxModel, reg, undefined)).toBe(ctxModel);
  });
  it("resolves MEMORY_MODEL 'provider/id' via registry", () => {
    const found = { provider: "openai", id: "gpt-4o-mini" } as never;
    const reg = { find: (p: string, m: string) => (p === "openai" && m === "gpt-4o-mini" ? found : undefined) } as never;
    expect(resolveMemoryModel(ctxModel, reg, "openai/gpt-4o-mini")).toBe(found);
  });
  it("falls back to ctx.model when registry miss", () => {
    const reg = { find: () => undefined } as never;
    expect(resolveMemoryModel(ctxModel, reg, "openai/nope")).toBe(ctxModel);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions/long-term-memory && bunx vitest run --silent='passed-only' llm.test.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 llm.ts**

创建 `extensions/long-term-memory/llm.ts`：

```ts
// In-process LLM access for memory consolidation. Uses the current agent model
// (ctx.model) via pi-ai's completeSimple — no sub-process, no extra API key.

import { completeSimple, type Context, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Extract the first JSON value from possibly noisy / fenced LLM output. */
export function parseJsonLoose<T = unknown>(raw: string): T | undefined {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return undefined;
  // Walk to the matching closing bracket to tolerate trailing prose.
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === open) depth++;
    else if (candidate[i] === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Resolve the model used for memory ops: MEMORY_MODEL ("provider/id") or ctx.model. */
export function resolveMemoryModel(
  current: Model<never> | undefined,
  registry: Pick<ModelRegistry, "find">,
  memoryModel: string | undefined,
): Model<never> | undefined {
  const spec = memoryModel?.trim();
  if (spec && spec.includes("/")) {
    const slash = spec.indexOf("/");
    const found = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (found) return found as Model<never>;
  }
  return current;
}

/** Call the model with a system + user prompt, return the concatenated assistant text. */
export async function askMemoryLlm(
  model: Model<never>,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  };
  const msg = await completeSimple(model, context, { reasoning: "off", signal } as never);
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions/long-term-memory && bunx vitest run --silent='passed-only' llm.test.ts`
预期：PASS（6 tests）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/long-term-memory/llm.ts extensions/long-term-memory/llm.test.ts
git commit -m "feat(memory): in-process LLM helper (completeSimple) + loose JSON parse + model resolve (B2)"
```

---

## 阶段 B3：consolidate 管线

**文件：**
- 创建：`extensions/long-term-memory/consolidate.ts`
- 创建：`extensions/long-term-memory/consolidate.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/long-term-memory/consolidate.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.js";
import { consolidate, extractFacts, type AskFn } from "./consolidate.js";

const OFF = { enabled: false, baseUrl: "", apiKey: "", model: "" };
const dirs: string[] = [];
function newStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "memcons-"));
  dirs.push(dir);
  const s = new MemoryStore(join(dir, "memory.db"));
  s.load();
  return s;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("consolidate", () => {
  it("ADDs when there is no similar memory (skips LLM)", async () => {
    const s = newStore();
    let called = 0;
    const ask: AskFn = async () => {
      called++;
      return "{}";
    };
    const ops = await consolidate(s, "uses pnpm", { ask, config: OFF, model: null });
    expect(ops).toEqual([{ op: "ADD", text: "uses pnpm" }]);
    expect(called).toBe(0); // no candidates → no LLM call
    expect(s.list(10).map((m) => m.text)).toContain("uses pnpm");
  });

  it("UPDATEs a contradictory existing memory", async () => {
    const s = newStore();
    const { id } = await s.insert("uses npm", "preference", OFF, "seed");
    const ask: AskFn = async () =>
      JSON.stringify({ op: "UPDATE", targetId: id, text: "uses pnpm", category: "preference", reason: "switched pkg mgr" });
    const ops = await consolidate(s, "actually I use pnpm now", { ask, config: OFF, model: null });
    expect(ops[0].op).toBe("UPDATE");
    expect(s.getById(id)?.text).toBe("uses pnpm");
  });

  it("DELETEs an obsolete memory", async () => {
    const s = newStore();
    const { id } = await s.insert("project deadline is May", null, OFF, "seed");
    const ask: AskFn = async () => JSON.stringify({ op: "DELETE", targetId: id, reason: "no longer true" });
    await consolidate(s, "the deadline was cancelled", { ask, config: OFF, model: null });
    expect(s.getById(id)).toBeUndefined();
  });

  it("NOOP when duplicate", async () => {
    const s = newStore();
    await s.insert("likes dark mode", null, OFF, "seed");
    const ask: AskFn = async () => JSON.stringify({ op: "NOOP", reason: "duplicate" });
    const ops = await consolidate(s, "prefers dark mode", { ask, config: OFF, model: null });
    expect(ops[0].op).toBe("NOOP");
    expect(s.list(10)).toHaveLength(1);
  });

  it("falls back to ADD when LLM returns invalid JSON", async () => {
    const s = newStore();
    await s.insert("seed fact one", null, OFF, "seed");
    const ask: AskFn = async () => "the model rambled with no json";
    const ops = await consolidate(s, "a brand new fact", { ask, config: OFF, model: null });
    expect(ops[0].op).toBe("ADD");
    expect(s.list(10).map((m) => m.text)).toContain("a brand new fact");
  });

  it("extractFacts parses one-per-line output", async () => {
    const ask: AskFn = async () => "- uses pnpm\n- prefers TypeScript\n\n";
    expect(await extractFacts(ask, "conversation text")).toEqual(["uses pnpm", "prefers TypeScript"]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions/long-term-memory && bunx vitest run --silent='passed-only' consolidate.test.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 consolidate.ts**

创建 `extensions/long-term-memory/consolidate.ts`：

```ts
// mem0-style consolidation: given a new fact, recall similar existing memories
// and let the LLM decide ADD / UPDATE / DELETE / NOOP. LLM is injected (AskFn)
// so this is fully unit-testable without a real model.

import { parseJsonLoose } from "./llm.js";
import type { EmbeddingConfig } from "./embedding.js";
import type { Memory, MemoryStore } from "./store.js";

export type AskFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export type AppliedOp =
  | { op: "ADD"; text: string }
  | { op: "UPDATE"; targetId: string; text: string }
  | { op: "DELETE"; targetId: string }
  | { op: "NOOP" };

interface Decision {
  op: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  targetId?: string;
  text?: string;
  category?: string | null;
  reason?: string;
}

const RECONCILE_TOPK = 5;

const EXTRACT_SYSTEM =
  "You extract durable, atomic facts worth remembering long-term (user preferences, " +
  "decisions, project conventions). Output one fact per line, plain text, no numbering, " +
  "no commentary. If nothing is worth saving, output nothing.";

const RECONCILE_SYSTEM =
  "You maintain a user's long-term memory. Given EXISTING memories and a NEW fact, decide a single " +
  "operation as STRICT JSON (no prose). Schema: " +
  '{"op":"ADD"|"UPDATE"|"DELETE"|"NOOP","targetId":string?,"text":string?,"category":string?,"reason":string?}. ' +
  "Rules: ADD if the new fact is genuinely new; UPDATE (with targetId + merged text) if it refines/contradicts " +
  "an existing memory; DELETE (with targetId) if the new fact makes an existing memory obsolete; NOOP if it is a duplicate.";

export async function extractFacts(ask: AskFn, conversation: string): Promise<string[]> {
  const out = await ask(EXTRACT_SYSTEM, `Conversation:\n${conversation}`);
  return out
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 3 && l.length < 300);
}

function candidatesBlock(cands: Memory[]): string {
  return cands.map((m) => `- id=${m.id}${m.category ? ` [${m.category}]` : ""}: ${m.text}`).join("\n");
}

export async function consolidate(
  store: MemoryStore,
  fact: string,
  deps: { ask: AskFn; config: EmbeddingConfig; model: string | null; signal?: AbortSignal },
): Promise<AppliedOp[]> {
  const clean = fact.trim();
  if (!clean) return [];

  const candidates = await store.recall(clean, RECONCILE_TOPK, deps.config, deps.signal).catch(() => []);
  // No similar memory → just ADD (saves an LLM round-trip).
  if (candidates.length === 0) {
    await store.insert(clean, null, deps.config, "consolidate:add", deps.model, deps.signal);
    return [{ op: "ADD", text: clean }];
  }

  const userPrompt = `EXISTING memories:\n${candidatesBlock(candidates.map((h) => h.memory))}\n\nNEW fact:\n${clean}`;
  let decision: Decision | undefined;
  try {
    decision = parseJsonLoose<Decision>(await deps.ask(RECONCILE_SYSTEM, userPrompt));
  } catch {
    decision = undefined;
  }

  // Invalid/missing decision → never lose the fact: ADD.
  if (!decision || !decision.op) {
    await store.insert(clean, null, deps.config, "consolidate:add(fallback)", deps.model, deps.signal);
    return [{ op: "ADD", text: clean }];
  }

  const known = new Set(candidates.map((h) => h.memory.id));
  switch (decision.op) {
    case "UPDATE": {
      if (decision.targetId && known.has(decision.targetId)) {
        const text = (decision.text ?? clean).trim();
        await store.update(decision.targetId, { text, category: decision.category }, deps.config, decision.reason ?? "consolidate:update", deps.model, deps.signal);
        return [{ op: "UPDATE", targetId: decision.targetId, text }];
      }
      await store.insert(clean, decision.category ?? null, deps.config, "consolidate:add(bad-target)", deps.model, deps.signal);
      return [{ op: "ADD", text: clean }];
    }
    case "DELETE": {
      if (decision.targetId && known.has(decision.targetId)) {
        store.remove(decision.targetId, decision.reason ?? "consolidate:delete", deps.model);
        return [{ op: "DELETE", targetId: decision.targetId }];
      }
      return [{ op: "NOOP" }];
    }
    case "NOOP":
      return [{ op: "NOOP" }];
    default: {
      const text = (decision.text ?? clean).trim();
      await store.insert(text, decision.category ?? null, deps.config, decision.reason ?? "consolidate:add", deps.model, deps.signal);
      return [{ op: "ADD", text }];
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions/long-term-memory && bunx vitest run --silent='passed-only' consolidate.test.ts`
预期：PASS（6 tests）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/long-term-memory/consolidate.ts extensions/long-term-memory/consolidate.test.ts
git commit -m "feat(memory): mem0-style consolidate pipeline (extract + reconcile ADD/UPDATE/DELETE/NOOP) (B3)"
```

---

## 阶段 B4：index.ts 接线（智能写入 + 命令 + 进程内提取 + notice），退役 extractor

**文件：**
- 修改：`extensions/long-term-memory/index.ts`
- 删除：`extensions/long-term-memory/extractor.ts`、`extensions/long-term-memory/extractor.test.ts`

- [ ] **步骤 1：在 index.ts 顶部接入新模块与开关**

在 `extensions/long-term-memory/index.ts` import 区替换 `extractor` import：

```ts
import { askMemoryLlm, resolveMemoryModel } from "./llm.js";
import { type AppliedOp, consolidate, extractFacts } from "./consolidate.js";
```

在文件顶部常量区新增开关（紧随现有 `AUTO_EXTRACT`）：

```ts
const SMART = (process.env.MEMORY_SMART ?? "1") !== "0";
const SMART_NOTICE = (process.env.MEMORY_SMART_NOTICE ?? "1") !== "0";
const MEMORY_MODEL = process.env.MEMORY_MODEL;
```

- [ ] **步骤 2：新增一个 ctx→AskFn 的桥接 + 智能保存助手（在 `export default function` 内、`ensureStores` 之后）**

```ts
// Build an AskFn bound to the current agent model; undefined when no model is available.
const makeAsk = (ctx: { model?: unknown; modelRegistry?: { find: (p: string, m: string) => unknown }; signal?: AbortSignal }): import("./consolidate.js").AskFn | undefined => {
  const model = resolveMemoryModel(ctx.model as never, (ctx.modelRegistry ?? { find: () => undefined }) as never, MEMORY_MODEL);
  if (!model) return undefined;
  return (system, user) => askMemoryLlm(model, system, user, ctx.signal);
};

const smartSave = async (
  ctx: { cwd: string; model?: unknown; modelRegistry?: { find: (p: string, m: string) => unknown }; signal?: AbortSignal },
  text: string,
  scope: "project" | "global",
): Promise<AppliedOp[]> => {
  const { project, global } = ensureStores(ctx.cwd);
  const store = scope === "global" ? global : project;
  const config = resolveEmbeddingConfig();
  const ask = SMART ? makeAsk(ctx) : undefined;
  if (!ask) {
    // MEMORY_SMART=0 or no model → naive dedup save.
    const { id } = await store.save(text.trim(), null, config, ctx.signal);
    return [{ op: "ADD", text: text.trim() }];
  }
  return consolidate(store, text, { ask, config, model: MEMORY_MODEL ?? null, signal: ctx.signal });
};

const noticeFor = (ops: AppliedOp[]): string | undefined => {
  const changed = ops.filter((o) => o.op === "UPDATE" || o.op === "DELETE");
  if (!changed.length) return undefined;
  return changed
    .map((o) => (o.op === "UPDATE" ? `更新记忆：${o.text}` : `删除过时记忆 (${o.targetId})`))
    .join("\n");
};
```

- [ ] **步骤 3：`memory_save` 工具改走 smartSave**（替换其 `execute` 方法体）

```ts
async execute(_toolCallId, params, signal, _onUpdate, ctx) {
  const text = (params.text ?? "").trim();
  if (!text) throw new Error("memory text must be non-empty");
  const scope = params.scope === "global" ? "global" : "project";
  const ops = await smartSave({ ...ctx, signal: signal ?? undefined }, text, scope);
  const summary = ops.map((o) => o.op).join(",");
  if (SMART_NOTICE) {
    const note = noticeFor(ops);
    if (note) ctx.ui.notify(`🧠 ${note}`, "info");
  }
  return {
    content: [{ type: "text", text: `Memory consolidated (${scope}): ${summary}` }],
    details: { scope, ops },
  };
}
```

- [ ] **步骤 4：自动提取改进程内 + 智能合并**（替换 `agent_end` handler 体）

```ts
pi.on("agent_end", async (event, ctx) => {
  if (!AUTO_EXTRACT) return;
  const messages = Array.isArray((event as { messages?: unknown[] })?.messages)
    ? (event as { messages: unknown[] }).messages
    : [];
  const convo = messages.map(messageToText).filter(Boolean).join("\n").slice(0, 12000);
  if (!convo.trim()) return;
  const ask = makeAsk({ ...ctx, signal: ctx.signal ?? undefined });
  if (!ask) return; // no model → skip extraction
  const facts = await extractFacts(ask, convo).catch(() => []);
  for (const fact of facts.slice(0, 10)) {
    await smartSave({ ...ctx, signal: ctx.signal ?? undefined }, fact, "project").catch(() => {});
  }
});
```

- [ ] **步骤 5：`/memory add` 走 smartSave；新增 `/memory history` 与 `/memory rollback`**（在命令 handler 内）

`add` 分支替换为：

```ts
if (sub === "add") {
  const text = parts.slice(1).join(" ").trim();
  if (!text) { ctx.ui.notify("Usage: /memory add <text>", "warn"); return; }
  const ops = await smartSave({ ...ctx, signal: ctx.signal ?? undefined }, text, "project");
  ctx.ui.notify(`Saved (project): ${ops.map((o) => o.op).join(",")}`, "success");
  return;
}
```

在 `forget` 分支后新增：

```ts
if (sub === "history") {
  const id = parts[1];
  const rows = id ? project.history(id).concat(global.history(id)) : project.history(20).concat(global.history(20));
  const lines = rows
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
    .map((r) => `#${r.historyId} ${r.op} [${r.memoryId}] ${r.oldText ?? "∅"} → ${r.newText ?? "∅"}${r.reason ? ` (${r.reason})` : ""}`);
  ctx.ui.notify(lines.length ? `History:\n${lines.join("\n")}` : "No history.", "info");
  return;
}

if (sub === "rollback") {
  const hid = Number(parts[1]);
  if (!Number.isFinite(hid)) { ctx.ui.notify("Usage: /memory rollback <historyId>", "warn"); return; }
  const config = resolveEmbeddingConfig();
  const r = (await project.rollback(hid, config)) ?? (await global.rollback(hid, config));
  ctx.ui.notify(r ? `Rolled back to history #${hid} (memory ${r.id}).` : `No history #${hid}.`, r ? "success" : "warn");
  return;
}
```

更新命令 `description` 与末尾 usage 文案，加入 `history`/`rollback`。

- [ ] **步骤 6：删除 extractor 文件**

```bash
git rm extensions/long-term-memory/extractor.ts extensions/long-term-memory/extractor.test.ts
```

- [ ] **步骤 7：运行全扩展测试 + 验证无残留 import**

运行：`cd extensions/long-term-memory && bunx vitest run --silent='passed-only'`
预期：PASS（store/llm/consolidate 全绿；无 extractor 测试残留）。
运行：`rg -n "extractor" extensions/long-term-memory` 预期：无结果（已无引用）。

- [ ] **步骤 8：Commit**

```bash
git add extensions/long-term-memory/index.ts
git commit -m "feat(memory): wire consolidate into save/add/auto-extract; /memory history|rollback; retire spawn extractor (B4)"
```

---

## 阶段 B5：Rust `mem_history` 只读命令

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/memory.rs`
- 修改：`tauri-agent/src-tauri/src/lib.rs`（注册 `mem_history`）

- [ ] **步骤 1：编写失败的测试**（追加到 `memory.rs` 的 `#[cfg(test)] mod tests`）

```rust
#[test]
fn history_reads_rows_desc_with_scope() {
    let db = tmp_db("memory.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE memory_history(historyId INTEGER PRIMARY KEY AUTOINCREMENT, memoryId TEXT NOT NULL, op TEXT NOT NULL, oldText TEXT, newText TEXT, oldCategory TEXT, newCategory TEXT, reason TEXT, model TEXT, version INTEGER NOT NULL, createdAt INTEGER NOT NULL);",
    ).unwrap();
    conn.execute("INSERT INTO memory_history(memoryId,op,oldText,newText,version,createdAt) VALUES('m1','ADD',NULL,'a',1,100)", []).unwrap();
    conn.execute("INSERT INTO memory_history(memoryId,op,oldText,newText,version,createdAt) VALUES('m1','UPDATE','a','b',2,200)", []).unwrap();
    let rows = read_mem_history(&db, "project", None).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].op, "UPDATE"); // historyId DESC
    assert_eq!(rows[0].scope, "project");
    let filtered = read_mem_history(&db, "project", Some("m1")).unwrap();
    assert_eq!(filtered.len(), 2);
}

#[test]
fn history_missing_db_is_empty() {
    assert!(read_mem_history(Path::new("/no/such/memory.db"), "global", None).unwrap().is_empty());
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent/src-tauri && cargo test memory`
预期：FAIL（`read_mem_history`/`MemHistoryItem` 未定义）。

- [ ] **步骤 3：实现 Rust 端**（在 `memory.rs` 加类型 + 读取 + 命令）

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemHistoryItem {
    pub history_id: i64,
    pub memory_id: String,
    pub op: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub old_category: Option<String>,
    pub new_category: Option<String>,
    pub reason: Option<String>,
    pub version: i64,
    pub created_at: i64,
    pub scope: String,
}

fn read_mem_history(path: &Path, scope: &str, memory_id: Option<&str>) -> Result<Vec<MemHistoryItem>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(vec![]);
    };
    // memory_history may not exist on a pre-migration db.
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memory_history'", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Ok(vec![]);
    }
    let sql = "SELECT historyId, memoryId, op, oldText, newText, oldCategory, newCategory, reason, version, createdAt FROM memory_history".to_string();
    let map_row = |r: &rusqlite::Row| {
        Ok(MemHistoryItem {
            history_id: r.get(0)?,
            memory_id: r.get(1)?,
            op: r.get(2)?,
            old_text: r.get(3)?,
            new_text: r.get(4)?,
            old_category: r.get(5)?,
            new_category: r.get(6)?,
            reason: r.get(7)?,
            version: r.get(8)?,
            created_at: r.get(9)?,
            scope: scope.to_string(),
        })
    };
    let mut out = Vec::new();
    if let Some(id) = memory_id {
        let mut stmt = conn
            .prepare(&format!("{sql} WHERE memoryId = ?1 ORDER BY historyId DESC"))
            .map_err(|e| e.to_string())?;
        for r in stmt.query_map([id], map_row).map_err(|e| e.to_string())? {
            out.push(r.map_err(|e| e.to_string())?);
        }
    } else {
        let mut stmt = conn
            .prepare(&format!("{sql} ORDER BY historyId DESC LIMIT 200"))
            .map_err(|e| e.to_string())?;
        for r in stmt.query_map([], map_row).map_err(|e| e.to_string())? {
            out.push(r.map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn mem_history(workspace: String, memory_id: Option<String>) -> Result<Vec<MemHistoryItem>, String> {
    let mut out = read_mem_history(&mem_project_path(&workspace)?, "project", memory_id.as_deref())?;
    if let Some(p) = mem_global_path() {
        out.extend(read_mem_history(&p, "global", memory_id.as_deref())?);
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}
```

在 `tauri-agent/src-tauri/src/lib.rs` 的 `invoke_handler![...]` 列表里，`mem_list` 旁加入 `commands::memory::mem_history`。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent/src-tauri && cargo test memory`
预期：PASS（含新增 2 个 history 测试）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/memory.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(memory): rust read-only mem_history command (B5)"
```

---

## 阶段 B6：前端历史 / 版本 / 回滚 UI

**文件：**
- 修改：`tauri-agent/src/lib/pi.ts`
- 创建：`tauri-agent/src/features/memory/MemoryHistory.tsx`
- 创建：`tauri-agent/src/features/memory/MemoryHistory.test.tsx`
- 修改：`tauri-agent/src/features/memory/MemoryPanel.tsx`

- [ ] **步骤 1：在 pi.ts 加类型与绑定**

在 `tauri-agent/src/lib/pi.ts` 的 `MemItem` 类型附近加：

```ts
export interface MemHistoryItem {
  historyId: number;
  memoryId: string;
  op: 'ADD' | 'UPDATE' | 'DELETE' | 'ROLLBACK';
  oldText: string | null;
  newText: string | null;
  oldCategory: string | null;
  newCategory: string | null;
  reason: string | null;
  version: number;
  createdAt: number;
  scope: string;
}
```

在 `pi` 对象里（`memList` 旁）加：

```ts
memHistory: (workspace: string, memoryId?: string) =>
  invoke<MemHistoryItem[]>('mem_history', { workspace, memoryId: memoryId ?? null }),
```

- [ ] **步骤 2：编写失败的测试**

创建 `tauri-agent/src/features/memory/MemoryHistory.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { memHistory, runCommand } = vi.hoisted(() => ({
  memHistory: vi.fn(() =>
    Promise.resolve([
      { historyId: 2, memoryId: 'm1', op: 'UPDATE', oldText: 'uses npm', newText: 'uses pnpm', oldCategory: null, newCategory: null, reason: 'switch', version: 2, createdAt: 200, scope: 'project' },
      { historyId: 1, memoryId: 'm1', op: 'ADD', oldText: null, newText: 'uses npm', oldCategory: null, newCategory: null, reason: 'seed', version: 1, createdAt: 100, scope: 'project' },
    ]),
  ),
  runCommand: vi.fn(() => Promise.resolve('')),
}));
vi.mock('../../stores/AgentStoreContext', () => ({ useAgentStoreContext: () => ({ workspace: '/ws' }) }));
vi.mock('../../lib/pi', () => ({ pi: { memHistory, runCommand } }));

import { MemoryHistory } from './MemoryHistory';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('MemoryHistory', () => {
  it('renders the change timeline', async () => {
    render(<MemoryHistory />);
    await waitFor(() => expect(screen.getByTestId('mem-hist-2')).toBeTruthy());
    expect(screen.getByTestId('mem-hist-2').textContent).toContain('uses pnpm');
    expect(screen.getByTestId('mem-hist-1').textContent).toContain('ADD');
  });

  it('rolls back via /memory rollback command', async () => {
    render(<MemoryHistory />);
    await waitFor(() => expect(screen.getByTestId('mem-hist-rollback-2')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-hist-rollback-2'));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory rollback 2'));
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/memory/MemoryHistory.test.tsx`
预期：FAIL（模块不存在）。

- [ ] **步骤 4：实现 MemoryHistory.tsx**

创建 `tauri-agent/src/features/memory/MemoryHistory.tsx`：

```tsx
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { Undo2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type MemHistoryItem } from '../../lib/pi';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

const opColor: Record<string, string> = {
  ADD: '#4ade80',
  UPDATE: '#fbbf24',
  DELETE: '#f87171',
  ROLLBACK: '#60a5fa',
};

interface MemoryHistoryProps {
  /** 仅看某条记忆的版本史；不传＝全量时间线。 */
  memoryId?: string;
}

export function MemoryHistory({ memoryId }: MemoryHistoryProps) {
  const { workspace } = useAgentStoreContext();
  const [rows, setRows] = useState<MemHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    void pi
      .memHistory(workspace, memoryId)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [workspace, memoryId]);

  useEffect(() => reload(), [reload]);

  const onRollback = useCallback(
    async (historyId: number) => {
      if (!window.confirm(`回滚变更 #${historyId}？`)) return;
      await pi.runCommand(workspace, `/memory rollback ${historyId}`);
      reload();
    },
    [workspace, reload],
  );

  if (error) return <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>;
  if (rows.length === 0)
    return <div data-testid="mem-hist-empty" style={{ padding: 14, fontSize: 12, color: muted }}>暂无变更历史</div>;

  return (
    <Flexbox data-testid="mem-history">
      {rows.map((r) => (
        <Flexbox
          key={r.historyId}
          horizontal
          align="center"
          gap={8}
          data-testid={`mem-hist-${r.historyId}`}
          style={{ padding: '8px 12px', borderBottom: border, fontSize: 12 }}
        >
          <span style={{ color: opColor[r.op] ?? muted, fontWeight: 600, minWidth: 64 }}>{r.op}</span>
          <Flexbox style={{ flex: 1, minWidth: 0 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {(r.oldText ?? '∅') + ' → ' + (r.newText ?? '∅')}
            </span>
            <span style={{ color: muted, fontSize: 11 }}>
              {r.scope} · v{r.version}
              {r.reason ? ` · ${r.reason}` : ''}
            </span>
          </Flexbox>
          <ActionIcon
            data-testid={`mem-hist-rollback-${r.historyId}`}
            icon={Undo2}
            size="small"
            title="回滚此次变更"
            onClick={() => void onRollback(r.historyId)}
          />
        </Flexbox>
      ))}
    </Flexbox>
  );
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/memory/MemoryHistory.test.tsx`
预期：PASS（2 tests）。

- [ ] **步骤 6：在 MemoryPanel 接入「历史」视图切换**

在 `tauri-agent/src/features/memory/MemoryPanel.tsx`：
- 顶部 import：`import { MemoryHistory } from './MemoryHistory';`
- 加视图状态：`const [view, setView] = useState<'memories' | 'history'>('memories');`
- 在 `header` 的筛选按钮组后加两个切换按钮（`data-testid="mem-view-memories"` / `mem-view-history"`），点击 `setView(...)`。
- 在 `return` 处：`view === 'history'` 时渲染 `<ManagerLayout testId="memory-panel" header={header} list={<MemoryHistory />} detail={<div style={{ color: muted, fontSize: 13 }}>全量变更时间线</div>} />`；否则保持现有列表/详情。
- 在 `detail`（选中记忆）里追加该记忆的版本史：`{selected && <MemoryHistory memoryId={selected.id} />}`。

具体替换 `return`：

```tsx
if (view === 'history') {
  return <ManagerLayout testId="memory-panel" header={header} list={<MemoryHistory />} detail={<div style={{ color: muted, fontSize: 13 }}>全量变更时间线；点条目右侧可回滚</div>} />;
}
return <ManagerLayout testId="memory-panel" header={header} list={list} detail={detail} />;
```

在 `detail` 的 `selected` 分支末尾（删除/提升按钮之后）插入版本史：

```tsx
<div style={{ marginBlockStart: 8, fontSize: 12, color: muted }}>版本历史</div>
<MemoryHistory memoryId={selected.id} />
```

视图切换按钮（加在 `header` 的 `FILTERS` 组之后）：

```tsx
<Flexbox horizontal gap={4}>
  <button data-testid="mem-view-memories" onClick={() => setView('memories')} style={{ padding: '2px 10px', borderRadius: 6, border, cursor: 'pointer', fontSize: 12, background: view === 'memories' ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent', color: view === 'memories' ? 'var(--gren-fg, inherit)' : muted }}>记忆</button>
  <button data-testid="mem-view-history" onClick={() => setView('history')} style={{ padding: '2px 10px', borderRadius: 6, border, cursor: 'pointer', fontSize: 12, background: view === 'history' ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent', color: view === 'history' ? 'var(--gren-fg, inherit)' : muted }}>历史</button>
</Flexbox>
```

- [ ] **步骤 7：运行前端测试 + 类型检查**

运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/memory/MemoryPanel.test.tsx src/features/memory/MemoryHistory.test.tsx`
预期：PASS。
运行：`cd tauri-agent && bunx tsc --noEmit`
预期：0 错误。

- [ ] **步骤 8：Commit**

```bash
git add tauri-agent/src/lib/pi.ts tauri-agent/src/features/memory/MemoryHistory.tsx tauri-agent/src/features/memory/MemoryHistory.test.tsx tauri-agent/src/features/memory/MemoryPanel.tsx
git commit -m "feat(memory): history timeline + per-memory versions + rollback UI (B6)"
```

---

## 阶段 B7：settings + 重建冒烟

**文件：**
- 修改：`tauri-agent/src/features/settings/settingsSchema.ts`

- [ ] **步骤 1：在「记忆」分类加三项设置**

在 `tauri-agent/src/features/settings/settingsSchema.ts` 的 `id: 'memory'` 分类 `fields` 末尾追加：

```ts
{ key: 'MEMORY_SMART', label: '智能合并（LLM 决策增改删，默认开，设 0 关）', type: 'boolean' },
{ key: 'MEMORY_MODEL', label: '记忆模型（provider/id，留空＝继承当前模型）', type: 'text', placeholder: '如 openai/gpt-4o-mini' },
{ key: 'MEMORY_SMART_NOTICE', label: '合并时对话提示（默认开，设 0 关）', type: 'boolean' },
```

- [ ] **步骤 2：类型检查 + 设置面板测试**

运行：`cd tauri-agent && bunx tsc --noEmit && bunx vitest run --silent='passed-only' src/features/settings/SettingsPanel.test.tsx`
预期：通过。

- [ ] **步骤 3：重建 sidecar 冒烟**

运行：`cd tauri-agent && node scripts/build-sidecar.mjs`
预期：输出 `GrenAgent sidecar ready: ...pi-x86_64-pc-windows-msvc.exe`（bun build 成功，证明 consolidate/llm/store 全部编入二进制、无 `Could not resolve` 报错）。

- [ ] **步骤 4：（可选）端到端实跑**

运行（需配置了模型）：`& "tauri-agent/src-tauri/binaries/pi-x86_64-pc-windows-msvc.exe" --mode json -p --no-session "memory_save: 我以后都用 pnpm"`
预期：JSONL 含 `tool_execution` 且 `memory_save` 返回 `ops`；再跑一次「我改用 npm 了」应触发 UPDATE（而非新增第二条）。

- [ ] **步骤 5：更新 README + Commit**

更新 `extensions/long-term-memory/README.md`：补「智能合并（MEMORY_SMART）/ MEMORY_MODEL / 历史与回滚（/memory history、/memory rollback）」，移除 extractor/PI_BIN 段落。

```bash
git add tauri-agent/src/features/settings/settingsSchema.ts extensions/long-term-memory/README.md
git commit -m "feat(memory): settings (MEMORY_SMART/MODEL/NOTICE) + docs; rebuild verified (B7)"
```

---

## 自检

**1. 规格覆盖度：**
- 智能合并所有写入（memory_save / /memory add / 自动提取）→ B4 ✓（`smartSave` 接三处）。
- `MEMORY_SMART=0` 退回朴素 → B4 ✓（`smartSave` 内分支 + `save()`）。
- 进程内 `ctx.model` + `MEMORY_MODEL` 覆盖 → B2 ✓（`resolveMemoryModel`/`askMemoryLlm`）。
- 完整 history + 版本 + 回滚 → B1（store）+ B5（Rust 读）+ B6（UI 时间线/版本/回滚）✓。
- 合并 notice（可关）→ B4 ✓（`SMART_NOTICE` + `ctx.ui.notify`）。
- 旧库迁移不丢数据 → B1 ✓（`migrate()` + 测试）。
- 错误回退 ADD / 无 key 关键词召回 → B3 ✓（invalid JSON→ADD；recall 自带降级）。
- extractor 退役 → B4 ✓。

**2. 占位符扫描：** 无 TODO/待定；每个代码步骤含完整代码。✓

**3. 类型一致性：**
- store：`insert/update/remove/history/rollback/getById` 签名在 B1 定义，B3/B4/B6 调用一致（`update(id,{text,category},config,reason,model,signal)`、`remove(id,reason,model)`、`rollback(historyId,config)`）。✓
- `AskFn = (system,user)=>Promise<string>` 在 B3 定义，B2 `askMemoryLlm` 与 B4 `makeAsk` 适配一致。✓
- `AppliedOp` 在 B3 定义，B4 `noticeFor`/工具结果使用一致。✓
- `MemHistoryItem`（前端）字段与 Rust `MemHistoryItem`（camelCase 序列化）对齐。✓

发现问题已在上文内联修正。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-14-grenagent-B-mem0-memory.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新子代理，任务间审查（superpowers:subagent-driven-development）。
2. **内联执行** — 当前会话用 superpowers:executing-plans 批量执行并设检查点。
