# 子项目 C1：Checkpoint/快照 + 回滚 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 给 GrenAgent 增加 opencode 式工作区快照 + 一键文件回滚：每轮自动给工作区拍 git 影子快照，「检查点」面板看 diff 并回滚。

**架构：** Pi 扩展 `extensions/checkpoint/`（独立 `--git-dir`+`--work-tree=cwd` 的 git 影子仓库，`before_agent_start` 拍快照 + `/checkpoint` 命令）；Rust 只读 `cp_list/cp_diff`；前端新「检查点」模块（ManagerLayout：时间线 + shiki diff + 回滚）。

**技术栈：** TypeScript、Node `child_process`(git)、`bun:sqlite`/`node:sqlite`（`_shared/sqlite` shim）、vitest、Rust(`std::process::Command`)、React + `@lobehub/ui` + shiki `LazyHighlighter`。

**关键事实（已核实）：**
- opencode 影子仓库技法：独立 git-dir/work-tree、尊重源仓 `.gitignore`、跳过 >2MB、Windows flag `core.autocrlf=false/longpaths=true/quotepath=false/symlinks=true`。
- Pi `before_agent_start` event 带 `prompt`（memory 扩展已用 `event.prompt`）；`ctx.cwd`、`ctx.ui.notify` 可用；扩展可 `child_process` 调 git。
- `_shared/sqlite.ts` 运行时选 `bun:sqlite`/`node:sqlite`；node v24 免 flag。
- Rust 跑 git 用 `std::process::Command`（见 `commands/git.rs`）；只读 sqlite 用 `commands/knowledge::open_readonly`；`resolve_workspace_dir`。
- 前端模块：`moduleStore.ModuleId`、`ModuleRail` MODULES 数组（lucide 图标）、`ModuleContainer` switch、`ManagerLayout({header,list,detail,testId})`、`pi.runCommand`、`LazyHighlighter language="diff"`。

---

## 文件结构

**新增：**
- `extensions/checkpoint/snapshot.ts` — git 影子仓库封装（`gitArgs`/`parseNameStatus`/`ensureRepo`/`track`/`diff`/`restore`）。
- `extensions/checkpoint/snapshot.test.ts` — 纯函数单测 + 真实 git 临时目录往返。
- `extensions/checkpoint/store.ts` — checkpoint 元数据（sqlite）。
- `extensions/checkpoint/store.test.ts` — 元数据 CRUD。
- `extensions/checkpoint/index.ts` — 接线（before_agent_start + /checkpoint 命令）。
- `extensions/checkpoint/package.json` — 包清单。
- `tauri-agent/src-tauri/src/commands/checkpoint.rs` — 只读 `cp_list`/`cp_diff`。
- `tauri-agent/src/features/checkpoints/CheckpointsPanel.tsx` + `CheckpointsPanel.test.tsx`。

**修改：**
- `extensions/index.ts`（注册 checkpoint 到 allExtensions）。
- `tauri-agent/src-tauri/src/lib.rs`（`mod`/注册命令）；`commands/mod.rs`（声明 module，如有该文件）。
- `tauri-agent/src/stores/moduleStore.ts`、`features/layout/ModuleRail.tsx`、`features/workspace/ModuleContainer.tsx`、`lib/pi.ts`。

**通用命令：**
- 扩展测试：`cd extensions/checkpoint && bunx vitest run --silent='passed-only' <file>`
- 前端测试：`cd tauri-agent && bunx vitest run --silent='passed-only' <file>`；类型：`bunx tsc --noEmit`
- Rust 测试：`cd tauri-agent/src-tauri && cargo test checkpoint`
- 重建 sidecar：`cd tauri-agent && node scripts/build-sidecar.mjs`

---

## 阶段 C1-1：snapshot.ts（git 影子仓库）

**文件：** 创建 `extensions/checkpoint/snapshot.ts`、`extensions/checkpoint/snapshot.test.ts`、`extensions/checkpoint/package.json`

- [ ] **步骤 1：包清单**

创建 `extensions/checkpoint/package.json`：

```json
{
  "name": "pi-checkpoint",
  "version": "0.1.0",
  "description": "Workspace checkpoints (git shadow repo) + file revert for the Pi coding agent.",
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "checkpoint", "snapshot"],
  "license": "MIT",
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": { "typebox": "*" },
  "devDependencies": { "@earendil-works/pi-coding-agent": "*", "typebox": "*" }
}
```

- [ ] **步骤 2：编写失败的测试**

创建 `extensions/checkpoint/snapshot.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitArgs, parseNameStatus, ensureRepo, track, diff, restore } from "./snapshot.js";

describe("gitArgs", () => {
  it("prepends windows-safe flags + git-dir + work-tree", () => {
    const a = gitArgs("/gd", "/wt", ["status"]);
    expect(a).toContain("--git-dir");
    expect(a[a.indexOf("--git-dir") + 1]).toBe("/gd");
    expect(a[a.indexOf("--work-tree") + 1]).toBe("/wt");
    expect(a).toContain("core.autocrlf=false");
    expect(a.at(-1)).toBe("status");
  });
});

describe("parseNameStatus", () => {
  it("parses name-status lines", () => {
    expect(parseNameStatus("A\tfoo.txt\nM\tbar/baz.ts\n")).toEqual([
      { file: "foo.txt", status: "A" },
      { file: "bar/baz.ts", status: "M" },
    ]);
  });
  it("ignores blanks", () => {
    expect(parseNameStatus("\n\n")).toEqual([]);
  });
});

const dirs: string[] = [];
function ws(): { cwd: string; gitdir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "cp-ws-"));
  dirs.push(cwd);
  return { cwd, gitdir: join(cwd, ".pi", "snapshots", "git") };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("track / diff / restore round-trip", () => {
  it("tracks changes, diffs, and restores file contents", async () => {
    const { cwd, gitdir } = ws();
    writeFileSync(join(cwd, "a.txt"), "v1");
    await ensureRepo(gitdir, cwd);
    const s1 = await track(gitdir, cwd);
    expect(s1?.hash).toMatch(/^[0-9a-f]{7,40}$/);

    writeFileSync(join(cwd, "a.txt"), "v2-modified");
    writeFileSync(join(cwd, "b.txt"), "added");
    const s2 = await track(gitdir, cwd);
    expect(s2).not.toBeNull();
    const d = await diff(gitdir, cwd, s1!.hash);
    expect(d).toContain("v2-modified");

    await restore(gitdir, cwd, s1!.hash);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("v1");
    expect(existsSync(join(cwd, "b.txt"))).toBe(false); // file added after s1 removed on revert
  });

  it("returns null when nothing changed", async () => {
    const { cwd, gitdir } = ws();
    writeFileSync(join(cwd, "a.txt"), "x");
    await ensureRepo(gitdir, cwd);
    expect(await track(gitdir, cwd)).not.toBeNull();
    expect(await track(gitdir, cwd)).toBeNull();
  });

  it("respects .gitignore and skips the .pi dir", async () => {
    const { cwd, gitdir } = ws();
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(cwd, "ignored.txt"), "secret");
    writeFileSync(join(cwd, "kept.txt"), "ok");
    await ensureRepo(gitdir, cwd);
    const s = await track(gitdir, cwd);
    const files = (s?.files ?? []).map((f) => f.file);
    expect(files).toContain("kept.txt");
    expect(files).not.toContain("ignored.txt");
  });
});
```

- [ ] **步骤 3：运行验证失败**

运行：`cd extensions/checkpoint && bunx vitest run --silent='passed-only' snapshot.test.ts`
预期：FAIL（`./snapshot.js` 不存在）。

- [ ] **步骤 4：实现 snapshot.ts**

创建 `extensions/checkpoint/snapshot.ts`：

```ts
// git shadow-repo snapshots: a separate --git-dir tracking the workspace
// (--work-tree=cwd) so we never touch the user's .git. Mirrors opencode's snapshot.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FLAGS = [
  "-c", "core.autocrlf=false",
  "-c", "core.longpaths=true",
  "-c", "core.quotepath=false",
  "-c", "core.symlinks=true",
];
const SNAP_REF = "refs/heads/snapshots";
const MAX_BYTES = 2 * 1024 * 1024;

export interface FileChange {
  file: string;
  status: string;
}

/** Build git argv: windows-safe flags + git-dir + work-tree + cmd. Pure (testable). */
export function gitArgs(gitdir: string, cwd: string, cmd: string[]): string[] {
  return [...FLAGS, "--git-dir", gitdir, "--work-tree", cwd, ...cmd];
}

/** Parse `git diff --name-status` output. Pure (testable). */
export function parseNameStatus(out: string): FileChange[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      if (tab < 0) return { file: "", status: "" };
      return { status: line.slice(0, tab).trim()[0] ?? "M", file: line.slice(tab + 1).trim() };
    })
    .filter((c) => c.file);
}

function run(
  gitdir: string,
  cwd: string,
  cmd: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", gitArgs(gitdir, cwd, cmd), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function ensureRepo(gitdir: string, cwd: string): Promise<void> {
  if (existsSync(join(gitdir, "HEAD"))) return;
  mkdirSync(gitdir, { recursive: true });
  await run(gitdir, cwd, ["init", "-q"]);
  await run(gitdir, cwd, ["config", "core.bare", "false"]);
  await run(gitdir, cwd, ["config", "user.email", "checkpoint@grenagent.local"]);
  await run(gitdir, cwd, ["config", "user.name", "GrenAgent Checkpoint"]);
  mkdirSync(join(gitdir, "info"), { recursive: true });
  // Never snapshot the shadow store or the user's git metadata.
  writeFileSync(join(gitdir, "info", "exclude"), "/.pi/\n/.git/\n");
}

export async function track(gitdir: string, cwd: string): Promise<{ hash: string; files: FileChange[] } | null> {
  await run(gitdir, cwd, ["add", "-A", "--", "."]); // respects work-tree .gitignore + info/exclude
  // Drop oversized files from the snapshot index.
  const staged = (await run(gitdir, cwd, ["diff", "--cached", "--name-only"])).stdout.split(/\r?\n/).filter(Boolean);
  for (const f of staged) {
    try {
      if (statSync(join(cwd, f)).size > MAX_BYTES) await run(gitdir, cwd, ["rm", "--cached", "-q", "--", f]);
    } catch {
      /* file vanished; ignore */
    }
  }
  const tree = (await run(gitdir, cwd, ["write-tree"])).stdout.trim();
  if (!tree) return null;
  const parent = (await run(gitdir, cwd, ["rev-parse", "--verify", "-q", SNAP_REF])).stdout.trim();
  if (parent) {
    const parentTree = (await run(gitdir, cwd, ["rev-parse", `${parent}^{tree}`])).stdout.trim();
    if (parentTree === tree) return null; // nothing changed
  }
  const commitCmd = ["commit-tree", tree, "-m", "checkpoint"];
  if (parent) commitCmd.push("-p", parent);
  const hash = (await run(gitdir, cwd, commitCmd)).stdout.trim();
  if (!hash) return null;
  await run(gitdir, cwd, ["update-ref", SNAP_REF, hash]);
  const files = parent
    ? parseNameStatus((await run(gitdir, cwd, ["diff", "--name-status", parent, hash])).stdout)
    : parseNameStatus((await run(gitdir, cwd, ["show", "--name-status", "--format=", hash])).stdout);
  return { hash, files };
}

export async function diff(gitdir: string, cwd: string, hash: string): Promise<string> {
  return (await run(gitdir, cwd, ["diff", hash, "--", "."])).stdout;
}

export async function restore(gitdir: string, cwd: string, hash: string): Promise<void> {
  const latest = (await run(gitdir, cwd, ["rev-parse", "--verify", "-q", SNAP_REF])).stdout.trim();
  // Files the checkpoint system added after `hash` → delete them so the revert is complete.
  let added: string[] = [];
  if (latest && latest !== hash) {
    added = parseNameStatus(
      (await run(gitdir, cwd, ["diff", "--name-status", "--diff-filter=A", hash, latest])).stdout,
    ).map((c) => c.file);
  }
  await run(gitdir, cwd, ["read-tree", hash]);
  await run(gitdir, cwd, ["checkout-index", "-a", "-f"]);
  for (const f of added) {
    try {
      rmSync(join(cwd, f), { force: true });
    } catch {
      /* ignore */
    }
  }
}
```

- [ ] **步骤 5：运行验证通过**

运行：`cd extensions/checkpoint && bunx vitest run --silent='passed-only' snapshot.test.ts`
预期：PASS（gitArgs/parseNameStatus + 3 个 round-trip）。

- [ ] **步骤 6：Commit**

```bash
git add extensions/checkpoint/snapshot.ts extensions/checkpoint/snapshot.test.ts extensions/checkpoint/package.json
git commit -m "feat(checkpoint): git shadow-repo snapshot/diff/restore (C1-1)"
```

---

## 阶段 C1-2：store.ts（元数据）

**文件：** 创建 `extensions/checkpoint/store.ts`、`extensions/checkpoint/store.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/checkpoint/store.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "./store.js";

const dirs: string[] = [];
const opened: CheckpointStore[] = [];
function newStore(): CheckpointStore {
  const dir = mkdtempSync(join(tmpdir(), "cp-store-"));
  dirs.push(dir);
  const s = new CheckpointStore(join(dir, "meta.db"));
  opened.push(s);
  s.load();
  return s;
}
afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      /* closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("CheckpointStore", () => {
  it("adds and lists newest-first with a generated id", () => {
    const s = newStore();
    const { id } = s.add({ hash: "abc123", label: "fix bug", kind: "auto", files: '[{"file":"a.ts","status":"M"}]' });
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    const list = s.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, hash: "abc123", label: "fix bug", kind: "auto" });
  });

  it("getById returns the row; clear empties", () => {
    const s = newStore();
    const { id } = s.add({ hash: "h", label: "l", kind: "manual", files: "[]" });
    expect(s.getById(id)?.hash).toBe("h");
    s.clear();
    expect(s.list()).toEqual([]);
    expect(s.getById(id)).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd extensions/checkpoint && bunx vitest run --silent='passed-only' store.test.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 store.ts**

创建 `extensions/checkpoint/store.ts`：

```ts
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "../_shared/sqlite.js";

export interface Checkpoint {
  id: string;
  hash: string;
  label: string;
  kind: string;
  files: string; // JSON-encoded FileChange[]
  createdAt: number;
}

interface Row {
  id: string;
  hash: string;
  label: string;
  kind: string;
  files: string;
  createdAt: number;
}

export class CheckpointStore {
  private db: DatabaseSync | undefined;
  constructor(private readonly file: string) {}

  load(): void {
    if (this.db) return;
    mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS checkpoints (
         id TEXT PRIMARY KEY,
         hash TEXT NOT NULL,
         label TEXT,
         kind TEXT NOT NULL,
         files TEXT,
         createdAt INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_cp_created ON checkpoints(createdAt);`,
    );
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private get database(): DatabaseSync {
    if (!this.db) this.load();
    return this.db as DatabaseSync;
  }

  add(input: { hash: string; label: string; kind: string; files: string }): { id: string } {
    const id = randomBytes(6).toString("hex");
    this.database
      .prepare("INSERT INTO checkpoints(id, hash, label, kind, files, createdAt) VALUES(?, ?, ?, ?, ?, ?)")
      .run(id, input.hash, input.label, input.kind, input.files, Date.now());
    return { id };
  }

  list(limit = 200): Checkpoint[] {
    return this.database
      .prepare("SELECT id, hash, label, kind, files, createdAt FROM checkpoints ORDER BY createdAt DESC LIMIT ?")
      .all(limit) as unknown as Row[];
  }

  getById(id: string): Checkpoint | undefined {
    return this.database
      .prepare("SELECT id, hash, label, kind, files, createdAt FROM checkpoints WHERE id = ?")
      .get(id) as Row | undefined;
  }

  clear(): void {
    this.database.exec("DELETE FROM checkpoints;");
  }
}
```

- [ ] **步骤 4：运行验证通过**

运行：`cd extensions/checkpoint && bunx vitest run --silent='passed-only' store.test.ts`
预期：PASS（2 tests）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/checkpoint/store.ts extensions/checkpoint/store.test.ts
git commit -m "feat(checkpoint): sqlite metadata store (C1-2)"
```

---

## 阶段 C1-3：index.ts 接线 + /checkpoint 命令 + 注册

**文件：** 创建 `extensions/checkpoint/index.ts`；修改 `extensions/index.ts`

- [ ] **步骤 1：实现 index.ts**

创建 `extensions/checkpoint/index.ts`：

```ts
// checkpoint: snapshot the workspace each turn (git shadow repo) and allow
// reverting the working-tree files to any snapshot. Conversation is untouched.
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diff, ensureRepo, restore, track } from "./snapshot.js";
import { CheckpointStore } from "./store.js";

const ENABLED = (process.env.CHECKPOINT ?? "1") !== "0";

export default function (pi: ExtensionAPI) {
  if (!ENABLED) return;
  let store: CheckpointStore | undefined;
  let gitdir = "";

  const ensure = (cwd: string): { store: CheckpointStore; gitdir: string } => {
    if (!store) {
      const base = join(cwd, ".pi", "snapshots");
      gitdir = join(base, "git");
      store = new CheckpointStore(join(base, "meta.db"));
      store.load();
    }
    return { store: store as CheckpointStore, gitdir };
  };

  const snapshot = async (cwd: string, label: string, kind: "auto" | "manual"): Promise<{ id: string; files: number } | null> => {
    const { store, gitdir } = ensure(cwd);
    await ensureRepo(gitdir, cwd);
    const r = await track(gitdir, cwd).catch(() => null);
    if (!r) return null;
    const { id } = store.add({ hash: r.hash, label, kind, files: JSON.stringify(r.files) });
    return { id, files: r.files.length };
  };

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = typeof (event as { prompt?: unknown }).prompt === "string" ? (event as { prompt: string }).prompt.trim() : "";
    await snapshot(ctx.cwd, prompt.slice(0, 80) || "(turn)", "auto").catch(() => {});
    return undefined;
  });

  pi.registerCommand("checkpoint", {
    description: "Checkpoints: /checkpoint list | create [label] | diff <id> | revert <id> | clear",
    handler: async (args, ctx) => {
      const { store, gitdir } = ensure(ctx.cwd);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "list";

      if (sub === "list") {
        const rows = store.list(50);
        const lines = rows.map((r) => {
          const n = (() => {
            try {
              return (JSON.parse(r.files) as unknown[]).length;
            } catch {
              return 0;
            }
          })();
          return `[${r.id}] (${r.kind}) ${r.label} — ${n} file(s)`;
        });
        ctx.ui.notify(lines.length ? `${lines.length} checkpoint(s):\n${lines.join("\n")}` : "No checkpoints.", "info");
        return;
      }

      if (sub === "create") {
        const label = parts.slice(1).join(" ").trim() || "manual checkpoint";
        const r = await snapshot(ctx.cwd, label, "manual");
        ctx.ui.notify(r ? `Checkpoint [${r.id}] saved (${r.files} file(s)).` : "No changes to snapshot.", r ? "success" : "info");
        return;
      }

      if (sub === "diff") {
        const cp = store.getById(parts[1] ?? "");
        if (!cp) {
          ctx.ui.notify("Usage: /checkpoint diff <id>", "warn");
          return;
        }
        await ensureRepo(gitdir, ctx.cwd);
        const d = await diff(gitdir, ctx.cwd, cp.hash);
        ctx.ui.notify(d ? d.slice(0, 4000) : "No differences from this checkpoint.", "info");
        return;
      }

      if (sub === "revert") {
        const cp = store.getById(parts[1] ?? "");
        if (!cp) {
          ctx.ui.notify("Usage: /checkpoint revert <id>", "warn");
          return;
        }
        await ensureRepo(gitdir, ctx.cwd);
        await restore(gitdir, ctx.cwd, cp.hash);
        ctx.ui.notify(`Reverted working files to checkpoint [${cp.id}].`, "success");
        return;
      }

      if (sub === "clear") {
        store.clear();
        ctx.ui.notify("Cleared checkpoint metadata.", "info");
        return;
      }

      ctx.ui.notify("Usage: /checkpoint list | create [label] | diff <id> | revert <id> | clear", "warn");
    },
  });
}
```

- [ ] **步骤 2：注册到 allExtensions**

修改 `extensions/index.ts`：import + 加入导出与数组。

```ts
import checkpoint from "./checkpoint/index.js";
```

在 `export { ... }` 块加入 `checkpoint,`，并在 `allExtensions` 数组中（建议放 `safety` 之后、靠前，使每轮快照尽早发生）加入 `checkpoint,`：

```ts
export const allExtensions = [
  safety,
  checkpoint,
  todo,
  // ... 其余不变
];
```

- [ ] **步骤 3：验证扩展测试全绿（无回归）**

运行：`cd extensions/checkpoint && bunx vitest run --silent='passed-only'`
预期：PASS（snapshot + store）。

- [ ] **步骤 4：Commit**

```bash
git add extensions/checkpoint/index.ts extensions/index.ts
git commit -m "feat(checkpoint): wire before_agent_start snapshot + /checkpoint command; register extension (C1-3)"
```

---

## 阶段 C1-4：Rust `cp_list` / `cp_diff`

**文件：** 创建 `tauri-agent/src-tauri/src/commands/checkpoint.rs`；修改 `tauri-agent/src-tauri/src/commands/mod.rs`（如有）、`src-tauri/src/lib.rs`

- [ ] **步骤 1：编写失败的测试**（写在 `checkpoint.rs` 内 `#[cfg(test)]`）

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn tmp_meta(rows: &[(&str, &str, &str, &str, &str, i64)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cptest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("meta.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE checkpoints(id TEXT PRIMARY KEY, hash TEXT NOT NULL, label TEXT, kind TEXT NOT NULL, files TEXT, createdAt INTEGER NOT NULL);",
        )
        .unwrap();
        for (id, hash, label, kind, files, ts) in rows {
            conn.execute(
                "INSERT INTO checkpoints(id,hash,label,kind,files,createdAt) VALUES(?1,?2,?3,?4,?5,?6)",
                rusqlite::params![id, hash, label, kind, files, ts],
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn list_reads_rows_desc_and_parses_files() {
        let db = tmp_meta(&[
            ("a1", "h1", "first", "auto", "[{\"file\":\"x.ts\",\"status\":\"M\"}]", 100),
            ("a2", "h2", "second", "manual", "[]", 200),
        ]);
        let rows = read_cp_list(&db).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "a2"); // createdAt DESC
        assert_eq!(rows[1].files.len(), 1);
        assert_eq!(rows[1].files[0].file, "x.ts");
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }

    #[test]
    fn list_missing_db_is_empty() {
        assert!(read_cp_list(std::path::Path::new("/no/such/meta.db")).unwrap().is_empty());
    }
}
```

- [ ] **步骤 2：运行验证失败**

运行：`cd tauri-agent/src-tauri && cargo test checkpoint`
预期：FAIL（`read_cp_list`/类型未定义）。

- [ ] **步骤 3：实现 checkpoint.rs**

创建 `tauri-agent/src-tauri/src/commands/checkpoint.rs`：

```rust
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::commands::knowledge::open_readonly;
use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpFile {
    pub file: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpItem {
    pub id: String,
    pub hash: String,
    pub label: String,
    pub kind: String,
    pub files: Vec<CpFile>,
    pub created_at: i64,
}

fn snapshots_base(workspace: &str) -> Result<PathBuf, String> {
    Ok(resolve_workspace_dir(workspace)?.join(".pi").join("snapshots"))
}

fn read_cp_list(meta: &Path) -> Result<Vec<CpItem>, String> {
    let Some(conn) = open_readonly(meta)? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare("SELECT id, hash, label, kind, files, createdAt FROM checkpoints ORDER BY createdAt DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let files_json: String = r.get(4).unwrap_or_default();
            let files: Vec<CpFile> = serde_json::from_str(&files_json).unwrap_or_default();
            Ok(CpItem {
                id: r.get(0)?,
                hash: r.get(1)?,
                label: r.get(2).unwrap_or_default(),
                kind: r.get(3)?,
                files,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn cp_list(workspace: String) -> Result<Vec<CpItem>, String> {
    read_cp_list(&snapshots_base(&workspace)?.join("meta.db"))
}

#[tauri::command]
pub fn cp_diff(workspace: String, id: String) -> Result<String, String> {
    let base = snapshots_base(&workspace)?;
    let cwd = resolve_workspace_dir(&workspace)?;
    let Some(conn) = open_readonly(&base.join("meta.db"))? else {
        return Ok(String::new());
    };
    let hash: String = conn
        .query_row("SELECT hash FROM checkpoints WHERE id = ?1", [&id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let gitdir = base.join("git");
    let output = Command::new("git")
        .args([
            "-c", "core.autocrlf=false",
            "-c", "core.longpaths=true",
            "-c", "core.quotepath=false",
            "--git-dir",
            gitdir.to_string_lossy().as_ref(),
            "--work-tree",
            cwd.to_string_lossy().as_ref(),
            "diff",
            &hash,
            "--",
            ".",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// (tests from step 1 appended here)
```

如 `src-tauri/src/commands/mod.rs` 存在且显式列模块，加 `pub mod checkpoint;`（与 `pub mod memory;` 同处）。

- [ ] **步骤 4：注册命令**

修改 `src-tauri/src/lib.rs`，在 `commands::memory::mem_history,` 旁加：

```rust
            commands::checkpoint::cp_list,
            commands::checkpoint::cp_diff,
```

- [ ] **步骤 5：运行验证通过**

运行：`cd tauri-agent/src-tauri && cargo test checkpoint`
预期：PASS（2 tests）。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/checkpoint.rs tauri-agent/src-tauri/src/commands/mod.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(checkpoint): rust read-only cp_list/cp_diff (C1-4)"
```

---

## 阶段 C1-5：前端「检查点」模块 + 面板

**文件：** 修改 `stores/moduleStore.ts`、`features/layout/ModuleRail.tsx`、`features/workspace/ModuleContainer.tsx`、`lib/pi.ts`；创建 `features/checkpoints/CheckpointsPanel.tsx` + `.test.tsx`

- [ ] **步骤 1：pi.ts 类型 + 绑定**

在 `tauri-agent/src/lib/pi.ts`（`MemHistoryItem` 附近）加：

```ts
export interface CpFile {
  file: string;
  status: string;
}
export interface CpItem {
  id: string;
  hash: string;
  label: string;
  kind: string;
  files: CpFile[];
  createdAt: number;
}
```

在 `pi` 对象里（`memHistory` 旁）加：

```ts
  cpList: (workspace: string) => invoke<CpItem[]>('cp_list', { workspace }),
  cpDiff: (workspace: string, id: string) => invoke<string>('cp_diff', { workspace, id }),
```

- [ ] **步骤 2：moduleStore 加 id**

`tauri-agent/src/stores/moduleStore.ts`：`ModuleId` 联合类型加 `| 'checkpoints'`。

- [ ] **步骤 3：ModuleRail 加按钮**

`tauri-agent/src/features/layout/ModuleRail.tsx`：import `History`（lucide）；在 MODULES 数组 `create` 之后加：

```ts
  { id: 'checkpoints', label: '检查点', Icon: History },
```

- [ ] **步骤 4：ModuleContainer 路由**

`tauri-agent/src/features/workspace/ModuleContainer.tsx`：import `CheckpointsPanel`；加 `case 'checkpoints': return <CheckpointsPanel />;`。

- [ ] **步骤 5：编写失败的测试**

创建 `tauri-agent/src/features/checkpoints/CheckpointsPanel.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { cpList, cpDiff, runCommand } = vi.hoisted(() => ({
  cpList: vi.fn(() =>
    Promise.resolve([
      { id: 'c2', hash: 'h2', label: 'edit config', kind: 'auto', files: [{ file: 'a.ts', status: 'M' }], createdAt: 200 },
      { id: 'c1', hash: 'h1', label: 'init', kind: 'manual', files: [], createdAt: 100 },
    ]),
  ),
  cpDiff: vi.fn(() => Promise.resolve('--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new')),
  runCommand: vi.fn(() => Promise.resolve('')),
}));
vi.mock('../../stores/AgentStoreContext', () => ({ useAgentStoreContext: () => ({ workspace: '/ws' }) }));
vi.mock('../../lib/pi', () => ({ pi: { cpList, cpDiff, runCommand } }));
vi.mock('../chat/LazyHighlighter', () => ({
  LazyHighlighter: ({ children }: { children: string }) => <pre>{children}</pre>,
}));

import { CheckpointsPanel } from './CheckpointsPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CheckpointsPanel', () => {
  it('lists checkpoints newest-first', async () => {
    render(<CheckpointsPanel />);
    await waitFor(() => expect(screen.getByTestId('cp-item-c2')).toBeTruthy());
    expect(screen.getByTestId('cp-item-c2').textContent).toContain('edit config');
    expect(screen.getByTestId('cp-item-c1').textContent).toContain('init');
  });

  it('shows diff when a checkpoint is selected', async () => {
    render(<CheckpointsPanel />);
    await waitFor(() => expect(screen.getByTestId('cp-item-c2')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cp-item-c2'));
    await waitFor(() => expect(cpDiff).toHaveBeenCalledWith('/ws', 'c2'));
    expect(screen.getByTestId('cp-detail').textContent).toContain('+new');
  });

  it('reverts via /checkpoint revert', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CheckpointsPanel />);
    await waitFor(() => expect(screen.getByTestId('cp-item-c2')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cp-item-c2'));
    await waitFor(() => expect(screen.getByTestId('cp-revert')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cp-revert'));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/checkpoint revert c2'));
  });
});
```

- [ ] **步骤 6：运行验证失败**

运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/checkpoints/CheckpointsPanel.test.tsx`
预期：FAIL（模块不存在）。

- [ ] **步骤 7：实现 CheckpointsPanel.tsx**

创建 `tauri-agent/src/features/checkpoints/CheckpointsPanel.tsx`：

```tsx
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type CpItem } from '../../lib/pi';
import { ManagerLayout } from '../common/ManagerLayout';
import { LazyHighlighter } from '../chat/LazyHighlighter';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function CheckpointsPanel() {
  const { workspace } = useAgentStoreContext();
  const [items, setItems] = useState<CpItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    void pi
      .cpList(workspace)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [workspace]);

  useEffect(() => reload(), [reload]);

  const selected = useMemo(() => items.find((c) => c.id === selectedId) ?? null, [items, selectedId]);

  const onSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      setDiffText('');
      void pi
        .cpDiff(workspace, id)
        .then(setDiffText)
        .catch((e) => setDiffText(`diff 读取失败：${e instanceof Error ? e.message : String(e)}`));
    },
    [workspace],
  );

  const onRevert = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`回滚工作区文件到检查点「${selected.label}」？`)) return;
    await pi.runCommand(workspace, `/checkpoint revert ${selected.id}`);
    reload();
  }, [workspace, selected, reload]);

  const header = (
    <Flexbox horizontal align="center" gap={12} data-testid="cp-header" style={{ fontSize: 13, width: '100%' }}>
      <span>{items.length ? `${items.length} 个检查点` : '检查点'}</span>
    </Flexbox>
  );

  let list: ReactNode;
  if (error) {
    list = <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>;
  } else if (items.length === 0) {
    list = (
      <div data-testid="cp-empty" style={{ padding: 14, fontSize: 12, color: muted }}>
        暂无检查点。agent 改动文件后会自动生成。
      </div>
    );
  } else {
    list = (
      <Flexbox>
        {items.map((c) => {
          const active = c.id === selectedId;
          return (
            <button
              key={c.id}
              data-testid={`cp-item-${c.id}`}
              onClick={() => onSelect(c.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '8px 12px',
                border: 'none',
                borderBottom: border,
                cursor: 'pointer',
                textAlign: 'left',
                background: active ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent',
                color: 'inherit',
                fontSize: 12,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
              <span style={{ color: muted, fontSize: 11 }}>
                {c.kind === 'manual' ? '手动' : '自动'} · {c.files.length} 文件 · {formatTime(c.createdAt)}
              </span>
            </button>
          );
        })}
      </Flexbox>
    );
  }

  const detail = selected ? (
    <Flexbox gap={10} data-testid="cp-detail" style={{ height: '100%' }}>
      <Flexbox horizontal align="center" gap={8}>
        <span style={{ fontSize: 13, flex: 1 }}>{selected.label}</span>
        <ActionIcon data-testid="cp-revert" icon={Undo2} size="small" title="回滚到此检查点" onClick={() => void onRevert()} />
      </Flexbox>
      {diffText ? (
        <LazyHighlighter language="diff" copyable style={{ maxHeight: '100%' }}>
          {diffText}
        </LazyHighlighter>
      ) : (
        <span style={{ fontSize: 12, color: muted }}>无差异或加载中…</span>
      )}
    </Flexbox>
  ) : (
    <div style={{ color: muted, fontSize: 13 }}>选择左侧检查点查看 diff，可一键回滚</div>
  );

  return <ManagerLayout testId="checkpoints-panel" header={header} list={list} detail={detail} />;
}
```

> 注：`LazyHighlighter` 的 props（`language`/`copyable`/`style`）以 `ToolExecution.tsx` 现有用法为准；若签名不同按其调整。

- [ ] **步骤 8：运行验证通过 + 类型检查**

运行：`cd tauri-agent && bunx vitest run --silent='passed-only' src/features/checkpoints/CheckpointsPanel.test.tsx`
预期：PASS（3 tests）。
运行：`cd tauri-agent && bunx tsc --noEmit`
预期：0 错误。

- [ ] **步骤 9：Commit**

```bash
git add tauri-agent/src/lib/pi.ts tauri-agent/src/stores/moduleStore.ts tauri-agent/src/features/layout/ModuleRail.tsx tauri-agent/src/features/workspace/ModuleContainer.tsx tauri-agent/src/features/checkpoints/
git commit -m "feat(checkpoint): Checkpoints sidebar module - timeline + shiki diff + revert (C1-5)"
```

---

## 阶段 C1-6：重建 sidecar 冒烟 + README

**文件：** 创建 `extensions/checkpoint/README.md`

- [ ] **步骤 1：重建 sidecar**

运行：`cd tauri-agent && node scripts/build-sidecar.mjs`
预期：`GrenAgent sidecar ready: ...`（bun build 成功 → checkpoint 扩展编入二进制，无 `Could not resolve`）。

- [ ] **步骤 2：（可选）端到端实跑**

运行：`& "tauri-agent/src-tauri/binaries/pi-x86_64-pc-windows-msvc.exe" --mode json -p --no-session "创建 hello.txt 写入 hi"`，结束后检查工作区出现 `.pi/snapshots/`（git 影子仓库 + meta.db）。

- [ ] **步骤 3：写 README**

创建 `extensions/checkpoint/README.md`：说明能力（每轮自动快照 + `/checkpoint` 命令 + 文件回滚）、配置（`CHECKPOINT=0` 关闭）、存储（`<cwd>/.pi/snapshots/{git, meta.db}`，建议 `.pi` 加入 `.gitignore`）、非目标（只回退文件、不动对话）。

- [ ] **步骤 4：Commit**

```bash
git add extensions/checkpoint/README.md
git commit -m "docs(checkpoint): README; sidecar rebuild verified (C1-6)"
```

---

## 自检

**1. 规格覆盖度：**
- git 影子仓库 + 文件回退 → C1-1（snapshot.ts）✓
- 每轮自动（before_agent_start，无变化跳过）+ 手动 → C1-3 ✓
- 元数据/时间线 → C1-2 + C1-4 ✓
- 「检查点」模块 + diff(shiki) + 回滚 → C1-5 ✓
- Rust 只读 cp_list/cp_diff，回滚走命令 → C1-4 ✓
- Windows 安全 flag、尊重 .gitignore、跳过 >2MB → C1-1 ✓
- 存储 `<cwd>/.pi/snapshots/{git,meta.db}` → C1-2/3/4 一致 ✓
- 非目标（不动对话、无 Monaco、无单文件选择性回滚）→ 未实现，符合 ✓

**2. 占位符扫描：** 无 TODO/待定；每个代码步骤含完整代码。✓

**3. 类型一致性：**
- snapshot：`gitArgs/parseNameStatus/ensureRepo/track/diff/restore` 签名在 C1-1 定义，C1-3 调用一致。✓
- store：`add/list/getById/clear/close` 在 C1-2 定义，C1-3 调用一致；`add` 入参 `{hash,label,kind,files}` 一致。✓
- Rust `CpItem/CpFile`（camelCase）与前端 `CpItem/CpFile` 字段对齐；`cp_list/cp_diff` 命令名与 `pi.ts` 绑定一致（参数 camelCase `workspace`/`id`）。✓
- 前端 `cpList/cpDiff` 与 Rust 命令 `cp_list`/`cp_diff` 映射（Tauri camelCase→snake）一致。✓

发现问题已内联修复。

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-06-14-grenagent-C1-checkpoint.md`。两种执行方式：

1. **子代理驱动（推荐）** — superpowers:subagent-driven-development，每任务一子代理 + 审查。
2. **内联执行** — superpowers:executing-plans，批量 + 检查点。
