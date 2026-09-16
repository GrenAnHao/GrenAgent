# GrenAgent UI 第 3 期：知识库 / 记忆 管理面板（ManagerLayout 范式 + Rust 直读 sqlite）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把模块导航里的「知识库」「记忆」两个占位面板换成真实管理视图：统一的 `ManagerLayout`（顶部状态 / 左列表 / 右详情）范式落地一次、两面板复用，数据由新增的 Rust 命令**直读 sqlite**（`rusqlite` bundled）真实呈现。

**架构：**
- **数据读取**：新增 `rusqlite`（bundled）依赖；新增 `commands/knowledge.rs`、`commands/memory.rs`，把「纯读函数（接受 db 路径）」与「Tauri 命令（解析 workspace→cwd→db 路径后调纯函数）」分离——纯函数可用临时 db 做 Rust 单测，命令是薄包装。命令用**同步** `#[tauri::command]`（rusqlite 是阻塞 API，Tauri 自动在线程池执行同步命令，避免阻塞 async 运行时）。只读打开（`SQLITE_OPEN_READ_ONLY`），db 不存在时返回空/零值。
- **前端**：`lib/pi.ts` 加 5 个 binding + 类型；新增 `features/common/ManagerLayout.tsx` 通用三栏骨架；`features/knowledge/KnowledgePanel.tsx`、`features/memory/MemoryPanel.tsx` 各自用 `useAgentStoreContext().workspace` + `useEffect` 拉数据；`ModuleContainer` 把 `knowledge`/`memory` 分支改为渲染真实面板。
- **范围**：仅**只读展示**（状态 + 列表 + 详情 + 记忆 scope 筛选）。写操作（添加文档/重索引/清空/删除记忆/提升全局）按设计 §8「写经 extension 保证一致」需另接工具链路，**列为非本期**。

**技术栈：** Rust（`rusqlite` features=`bundled`、已有 `serde`/`dirs`/`uuid`）、React 19、zustand、`@lobehub/ui`（`Flexbox`）、vitest + @testing-library/react（**未开 `globals`、无自动 cleanup**，测试需显式从 `vitest` import 并手动 `afterEach(cleanup)`）。

---

## 范围

仅第 3 期（知识库 + 记忆 管理面板）。完成后：模块栏点「知识库」显示真实 chunks/文档列表/片段；点「记忆」显示项目+全局记忆列表/详情，可按 scope 筛选；数据来自 Rust 直读 `.pi/*.db`。**不含**写操作、知识库「测试检索」框、审查/创作/连接/设置面板（后续期）。可独立运行与测试。

**前置事实（已核实）**
- 知识库 db：`<cwd>/.pi/knowledge/default.db`，表 `chunks(id TEXT PK, source TEXT, text TEXT, embedding BLOB)`、`meta(key TEXT PK, value TEXT)`（`meta` 里 `key='model'` 存 embedding 模型名，keyword 模式下无此行）。
- 记忆 db：项目 `<cwd>/.pi/memory/memory.db`、全局 `~/.pi/agent/long-term-memory.db`（实测路径以 `long-term-memory/index.ts` 代码为准；可被环境变量 `MEMORY_GLOBAL_DB` 覆盖）。表 `memories(id TEXT PK, text TEXT, category TEXT NULL, createdAt INTEGER, embedding BLOB)`。
- `chunks` 表**无时间列**、静态行**无 score**（score 仅检索时计算）；故知识库列表显示 `source + chunk 数`、详情显示 chunk 文本（不显示时间/score）。
- Rust：`Cargo.toml` 无 sqlite 依赖；`resolve_workspace_dir(workspace: &str) -> Result<PathBuf,String>` 在 `src-tauri/src/commands/sessions.rs` 是 `pub`，解析前端传入的 `workspace`（常为 `.`）为绝对 cwd；`dirs` crate 已依赖；`uuid` 已依赖（测试用）。命令注册在 `src-tauri/src/lib.rs` 的 `invoke_handler!` + `commands/mod.rs`。
- 前端：`ModuleContainer({ chat })` 当前对非 chat 模块渲染 `PlaceholderPanel`；面板渲染时在 `AgentStoreProvider` 内，可用 `useAgentStoreContext()` 取 `workspace`；现有 `MessageList`/`actions.test.tsx` 证明真实 `@lobehub/ui` 组件可在 jsdom 渲染。
- 现有可复用：`features/chat/LazyMarkdown.tsx`（命名导出，渲染 markdown）。

## 文件结构

- 修改 `tauri-agent/src-tauri/Cargo.toml` — 加 `rusqlite`（bundled）
- 创建 `tauri-agent/src-tauri/src/commands/knowledge.rs` — `kb_stats`/`kb_sources`/`kb_chunks` 命令 + 纯读函数 + 单测
- 创建 `tauri-agent/src-tauri/src/commands/memory.rs` — `mem_stats`/`mem_list` 命令 + 纯读函数 + 单测
- 修改 `tauri-agent/src-tauri/src/commands/mod.rs` — 声明 `pub mod knowledge; pub mod memory;`
- 修改 `tauri-agent/src-tauri/src/lib.rs` — `invoke_handler!` 注册 5 个命令
- 修改 `tauri-agent/src/lib/pi.ts` — 5 个 binding + 类型
- 创建 `tauri-agent/src/features/common/ManagerLayout.tsx` + `ManagerLayout.test.tsx`
- 创建 `tauri-agent/src/features/knowledge/KnowledgePanel.tsx` + `KnowledgePanel.test.tsx`
- 创建 `tauri-agent/src/features/memory/MemoryPanel.tsx` + `MemoryPanel.test.tsx`
- 修改 `tauri-agent/src/features/workspace/ModuleContainer.tsx` + `ModuleContainer.test.tsx`

命令：
- 前端测试 `cd tauri-agent && npx vitest run <file>`；前端类型检查 `cd tauri-agent && npx tsc --noEmit`
- Rust 测试 `cd tauri-agent/src-tauri && cargo test knowledge`（或 `memory`）；**首次编译 `rusqlite` bundled 会编译 sqlite3（数分钟），属正常**。

---

## 任务 1：Rust — rusqlite 依赖 + 知识库读命令

**文件：**
- 修改：`tauri-agent/src-tauri/Cargo.toml`
- 创建：`tauri-agent/src-tauri/src/commands/knowledge.rs`
- 修改：`tauri-agent/src-tauri/src/commands/mod.rs`

> Rust 为编译型语言，沿用现有 `sessions.rs` 的「实现 + `#[cfg(test)]` 同文件」模式：本任务一次写好纯函数 + 命令 + 单测，用 `cargo test` 验证（红/绿体现在断言通过与否）。

- [ ] **步骤 1：加 rusqlite 依赖**

在 `tauri-agent/src-tauri/Cargo.toml` 的 `[dependencies]` 末尾（`portable-pty = "0.9"` 之后）追加：

```toml
rusqlite = { version = "0.32", features = ["bundled"] }
```

> 若 `0.32` 解析失败，运行 `cargo add rusqlite --features bundled` 取当前兼容版本；`bundled` 让 rusqlite 自带 sqlite3，无需系统库。

- [ ] **步骤 2：声明子模块**

把 `tauri-agent/src-tauri/src/commands/mod.rs` 改为：

```rust
pub mod agent;
pub mod files;
pub mod git;
pub mod knowledge;
pub mod memory;
pub mod sessions;
pub mod shell;
pub mod terminal;

pub use agent::*;
pub use sessions::*;
```

> 同时声明了任务 2 的 `memory`，避免两个任务各改一次 `mod.rs`。任务 2 才创建 `memory.rs`，但因为本任务紧接着会创建 `knowledge.rs` 并立即 `cargo test`，需保证编译通过——所以**本步骤先只加 `pub mod knowledge;`**，把 `pub mod memory;` 留到任务 2 步骤 1 再加。最终内容（任务 2 完成后）即上方版本。本任务实际写入：

```rust
pub mod agent;
pub mod files;
pub mod git;
pub mod knowledge;
pub mod sessions;
pub mod shell;
pub mod terminal;

pub use agent::*;
pub use sessions::*;
```

- [ ] **步骤 3：写 knowledge.rs（命令 + 纯函数 + 单测）**

创建 `tauri-agent/src-tauri/src/commands/knowledge.rs`：

```rust
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbStats {
    pub chunks: i64,
    pub sources: i64,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbSource {
    pub source: String,
    pub chunks: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbChunk {
    pub id: String,
    pub text: String,
}

/// 只读打开一个 sqlite 文件；文件不存在时返回 None（上层据此返回空/零值）。
pub(crate) fn open_readonly(path: &Path) -> Result<Option<Connection>, String> {
    if !path.exists() {
        return Ok(None);
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map(Some)
        .map_err(|e| e.to_string())
}

fn kb_db_path(workspace: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_dir(workspace)?;
    Ok(cwd.join(".pi").join("knowledge").join("default.db"))
}

fn read_kb_stats(path: &Path) -> Result<KbStats, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(KbStats { chunks: 0, sources: 0, model: None });
    };
    let chunks: i64 = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let sources: i64 = conn
        .query_row("SELECT COUNT(DISTINCT source) FROM chunks", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    // model 行可能不存在（keyword 模式）；用 .ok() 容忍。
    let model: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'model'", [], |r| r.get(0))
        .ok();
    Ok(KbStats { chunks, sources, model })
}

fn read_kb_sources(path: &Path) -> Result<Vec<KbSource>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare("SELECT source, COUNT(*) AS n FROM chunks GROUP BY source ORDER BY source")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(KbSource { source: r.get(0)?, chunks: r.get(1)? })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn read_kb_chunks(path: &Path, source: &str) -> Result<Vec<KbChunk>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare("SELECT id, text FROM chunks WHERE source = ?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([source], |r| Ok(KbChunk { id: r.get(0)?, text: r.get(1)? }))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn kb_stats(workspace: String) -> Result<KbStats, String> {
    read_kb_stats(&kb_db_path(&workspace)?)
}

#[tauri::command]
pub fn kb_sources(workspace: String) -> Result<Vec<KbSource>, String> {
    read_kb_sources(&kb_db_path(&workspace)?)
}

#[tauri::command]
pub fn kb_chunks(workspace: String, source: String) -> Result<Vec<KbChunk>, String> {
    read_kb_chunks(&kb_db_path(&workspace)?, &source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn make_kb(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE chunks(id TEXT PRIMARY KEY, source TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB);
             INSERT INTO meta(key,value) VALUES('model','test-model');
             INSERT INTO chunks(id,source,text,embedding) VALUES('c1','a.md','hello',NULL);
             INSERT INTO chunks(id,source,text,embedding) VALUES('c2','a.md','world',NULL);
             INSERT INTO chunks(id,source,text,embedding) VALUES('c3','b.md','foo',NULL);",
        )
        .unwrap();
    }

    fn tmp_db() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kbtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("default.db")
    }

    #[test]
    fn stats_counts_chunks_sources_model() {
        let db = tmp_db();
        make_kb(&db);
        let s = read_kb_stats(&db).unwrap();
        assert_eq!(s.chunks, 3);
        assert_eq!(s.sources, 2);
        assert_eq!(s.model.as_deref(), Some("test-model"));
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }

    #[test]
    fn missing_db_returns_zero() {
        let s = read_kb_stats(Path::new("/no/such/default.db")).unwrap();
        assert_eq!(s.chunks, 0);
        assert_eq!(s.sources, 0);
        assert!(s.model.is_none());
    }

    #[test]
    fn sources_grouped_and_chunks_by_source() {
        let db = tmp_db();
        make_kb(&db);
        let srcs = read_kb_sources(&db).unwrap();
        assert_eq!(srcs.len(), 2);
        assert_eq!(srcs[0].source, "a.md");
        assert_eq!(srcs[0].chunks, 2);
        let chunks = read_kb_chunks(&db, "a.md").unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].id, "c1");
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }
}
```

- [ ] **步骤 4：运行 Rust 测试验证通过**

运行：`cd tauri-agent/src-tauri && cargo test knowledge`
预期：首次编译 rusqlite（数分钟）后，`stats_counts_chunks_sources_model`、`missing_db_returns_zero`、`sources_grouped_and_chunks_by_source` 全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/Cargo.toml tauri-agent/src-tauri/Cargo.lock tauri-agent/src-tauri/src/commands/knowledge.rs tauri-agent/src-tauri/src/commands/mod.rs
git commit -m "feat(grenagent): add rusqlite + knowledge read commands (phase3)"
```

---

## 任务 2：Rust — 记忆读命令

**文件：**
- 创建：`tauri-agent/src-tauri/src/commands/memory.rs`
- 修改：`tauri-agent/src-tauri/src/commands/mod.rs`

- [ ] **步骤 1：在 mod.rs 声明 memory 子模块**

把 `tauri-agent/src-tauri/src/commands/mod.rs` 的子模块声明区改为（在 `pub mod knowledge;` 后加 `pub mod memory;`）：

```rust
pub mod agent;
pub mod files;
pub mod git;
pub mod knowledge;
pub mod memory;
pub mod sessions;
pub mod shell;
pub mod terminal;

pub use agent::*;
pub use sessions::*;
```

- [ ] **步骤 2：写 memory.rs（命令 + 纯函数 + 单测）**

创建 `tauri-agent/src-tauri/src/commands/memory.rs`：

```rust
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::knowledge::open_readonly;
use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemStats {
    pub project: i64,
    pub global: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemItem {
    pub id: String,
    pub text: String,
    pub category: Option<String>,
    pub created_at: i64,
    pub scope: String,
}

fn mem_project_path(workspace: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_dir(workspace)?;
    Ok(cwd.join(".pi").join("memory").join("memory.db"))
}

/// 全局记忆 db：env `MEMORY_GLOBAL_DB` 优先，否则 `~/.pi/agent/long-term-memory.db`。
fn mem_global_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MEMORY_GLOBAL_DB") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| h.join(".pi").join("agent").join("long-term-memory.db"))
}

fn read_mem_count(path: &Path) -> Result<i64, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(0);
    };
    conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn read_mem_list(path: &Path, scope: &str) -> Result<Vec<MemItem>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare("SELECT id, text, category, createdAt FROM memories ORDER BY createdAt DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MemItem {
                id: r.get(0)?,
                text: r.get(1)?,
                category: r.get(2)?,
                created_at: r.get(3)?,
                scope: scope.to_string(),
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
pub fn mem_stats(workspace: String) -> Result<MemStats, String> {
    let project = read_mem_count(&mem_project_path(&workspace)?)?;
    let global = match mem_global_path() {
        Some(p) => read_mem_count(&p)?,
        None => 0,
    };
    Ok(MemStats { project, global })
}

#[tauri::command]
pub fn mem_list(workspace: String) -> Result<Vec<MemItem>, String> {
    let mut out = read_mem_list(&mem_project_path(&workspace)?, "project")?;
    if let Some(p) = mem_global_path() {
        out.extend(read_mem_list(&p, "global")?);
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn make_mem(path: &Path, rows: &[(&str, &str, Option<&str>, i64)]) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE memories(id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT, createdAt INTEGER NOT NULL, embedding BLOB);",
        )
        .unwrap();
        for (id, text, cat, ts) in rows {
            conn.execute(
                "INSERT INTO memories(id,text,category,createdAt,embedding) VALUES(?1,?2,?3,?4,NULL)",
                rusqlite::params![id, text, cat, ts],
            )
            .unwrap();
        }
    }

    fn tmp_db(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("memtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn count_and_list_with_scope_tag() {
        let db = tmp_db("memory.db");
        make_mem(&db, &[("m1", "likes dark mode", Some("preference"), 100), ("m2", "uses pnpm", None, 200)]);
        assert_eq!(read_mem_count(&db).unwrap(), 2);
        let list = read_mem_list(&db, "project").unwrap();
        assert_eq!(list.len(), 2);
        // createdAt DESC：m2(200) 在前
        assert_eq!(list[0].id, "m2");
        assert_eq!(list[0].scope, "project");
        assert_eq!(list[1].category.as_deref(), Some("preference"));
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }

    #[test]
    fn missing_db_is_empty() {
        assert_eq!(read_mem_count(Path::new("/no/such/memory.db")).unwrap(), 0);
        assert!(read_mem_list(Path::new("/no/such/memory.db"), "global").unwrap().is_empty());
    }
}
```

- [ ] **步骤 3：运行 Rust 测试验证通过**

运行：`cd tauri-agent/src-tauri && cargo test memory`
预期：`count_and_list_with_scope_tag`、`missing_db_is_empty` PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/memory.rs tauri-agent/src-tauri/src/commands/mod.rs
git commit -m "feat(grenagent): add memory read commands (phase3)"
```

---

## 任务 3：注册命令 + 前端 pi.ts binding

**文件：**
- 修改：`tauri-agent/src-tauri/src/lib.rs`
- 修改：`tauri-agent/src/lib/pi.ts`

- [ ] **步骤 1：在 invoke_handler 注册 5 个命令**

在 `tauri-agent/src-tauri/src/lib.rs` 的 `tauri::generate_handler![ ... ]` 列表里，`commands::git::get_git_diff,` 之后追加：

```rust
            commands::knowledge::kb_stats,
            commands::knowledge::kb_sources,
            commands::knowledge::kb_chunks,
            commands::memory::mem_stats,
            commands::memory::mem_list,
```

- [ ] **步骤 2：编译验证（Rust 端集成）**

运行：`cd tauri-agent/src-tauri && cargo build`
预期：编译通过（命令已注册，无 unused warning 阻断）。

- [ ] **步骤 3：前端加类型 + binding**

在 `tauri-agent/src/lib/pi.ts` 的 `export const pi = {` 之前插入类型：

```ts
export interface KbStats {
  chunks: number;
  sources: number;
  model: string | null;
}
export interface KbSource {
  source: string;
  chunks: number;
}
export interface KbChunk {
  id: string;
  text: string;
}
export interface MemStats {
  project: number;
  global: number;
}
export interface MemItem {
  id: string;
  text: string;
  category: string | null;
  createdAt: number;
  scope: 'project' | 'global';
}
```

在 `pi` 对象里 `getCommands: ...,` 之后追加 5 个 binding：

```ts
  kbStats: (workspace: string) => invoke<KbStats>('kb_stats', { workspace }),
  kbSources: (workspace: string) => invoke<KbSource[]>('kb_sources', { workspace }),
  kbChunks: (workspace: string, source: string) =>
    invoke<KbChunk[]>('kb_chunks', { workspace, source }),
  memStats: (workspace: string) => invoke<MemStats>('mem_stats', { workspace }),
  memList: (workspace: string) => invoke<MemItem[]>('mem_list', { workspace }),
```

- [ ] **步骤 4：前端类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/lib.rs tauri-agent/src/lib/pi.ts
git commit -m "feat(grenagent): register kb/memory commands + frontend bindings (phase3)"
```

---

## 任务 4：ManagerLayout 通用三栏骨架

**文件：**
- 创建：`tauri-agent/src/features/common/ManagerLayout.tsx`
- 测试：`tauri-agent/src/features/common/ManagerLayout.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/common/ManagerLayout.test.tsx`：

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagerLayout } from './ManagerLayout';

afterEach(() => {
  cleanup();
});

describe('ManagerLayout', () => {
  it('renders header, list and detail slots', () => {
    render(
      <ManagerLayout
        header={<div>HEADER</div>}
        list={<div>LIST</div>}
        detail={<div>DETAIL</div>}
      />,
    );
    expect(screen.getByText('HEADER')).toBeTruthy();
    expect(screen.getByText('LIST')).toBeTruthy();
    expect(screen.getByText('DETAIL')).toBeTruthy();
  });

  it('uses the provided testId on the root', () => {
    render(<ManagerLayout testId="knowledge-panel" header={null} list={null} detail={null} />);
    expect(screen.getByTestId('knowledge-panel')).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/common/ManagerLayout.test.tsx`
预期：FAIL，"Cannot find module './ManagerLayout'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/features/common/ManagerLayout.tsx`：

```tsx
import { Flexbox } from '@lobehub/ui';
import type { ReactNode } from 'react';

interface ManagerLayoutProps {
  header: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  testId?: string;
}

const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

export function ManagerLayout({ header, list, detail, testId }: ManagerLayoutProps) {
  return (
    <Flexbox data-testid={testId ?? 'manager-layout'} style={{ height: '100%', minHeight: 0 }}>
      <div style={{ padding: '10px 14px', borderBottom: border, flex: '0 0 auto' }}>{header}</div>
      <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
        <div
          style={{
            width: 260,
            flex: '0 0 auto',
            height: '100%',
            overflowY: 'auto',
            borderRight: border,
          }}
        >
          {list}
        </div>
        <div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto', padding: 14 }}>
          {detail}
        </div>
      </Flexbox>
    </Flexbox>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/common/ManagerLayout.test.tsx`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/common/ManagerLayout.tsx tauri-agent/src/features/common/ManagerLayout.test.tsx
git commit -m "feat(grenagent): add ManagerLayout shared three-pane scaffold (phase3)"
```

---

## 任务 5：KnowledgePanel

**文件：**
- 创建：`tauri-agent/src/features/knowledge/KnowledgePanel.tsx`
- 测试：`tauri-agent/src/features/knowledge/KnowledgePanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/knowledge/KnowledgePanel.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

const kbStats = vi.fn(() => Promise.resolve({ chunks: 3, sources: 2, model: 'text-embed' }));
const kbSources = vi.fn(() =>
  Promise.resolve([
    { source: 'a.md', chunks: 2 },
    { source: 'b.md', chunks: 1 },
  ]),
);
const kbChunks = vi.fn(() => Promise.resolve([{ id: 'c1', text: 'hello chunk' }]));
vi.mock('../../lib/pi', () => ({ pi: { kbStats, kbSources, kbChunks } }));

import { KnowledgePanel } from './KnowledgePanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('KnowledgePanel', () => {
  it('shows stats and source list', async () => {
    render(<KnowledgePanel />);
    await waitFor(() => expect(screen.getByTestId('kb-header').textContent).toContain('3'));
    expect(screen.getByTestId('kb-header').textContent).toContain('2');
    expect(screen.getByTestId('kb-source-a.md')).toBeTruthy();
    expect(screen.getByTestId('kb-source-b.md')).toBeTruthy();
  });

  it('loads chunks when a source is clicked', async () => {
    render(<KnowledgePanel />);
    await waitFor(() => expect(screen.getByTestId('kb-source-a.md')).toBeTruthy());
    fireEvent.click(screen.getByTestId('kb-source-a.md'));
    await waitFor(() => expect(kbChunks).toHaveBeenCalledWith('/ws', 'a.md'));
    await waitFor(() => expect(screen.getByTestId('kb-detail').textContent).toContain('hello chunk'));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/knowledge/KnowledgePanel.test.tsx`
预期：FAIL，"Cannot find module './KnowledgePanel'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/features/knowledge/KnowledgePanel.tsx`：

```tsx
import { Flexbox } from '@lobehub/ui';
import { useEffect, useState } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type KbChunk, type KbSource, type KbStats } from '../../lib/pi';
import { ManagerLayout } from '../common/ManagerLayout';
import { LazyMarkdown } from '../chat/LazyMarkdown';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

export function KnowledgePanel() {
  const { workspace } = useAgentStoreContext();
  const [stats, setStats] = useState<KbStats | null>(null);
  const [sources, setSources] = useState<KbSource[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [chunks, setChunks] = useState<KbChunk[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    void Promise.all([pi.kbStats(workspace), pi.kbSources(workspace)])
      .then(([s, src]) => {
        if (!alive) return;
        setStats(s);
        setSources(src);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  useEffect(() => {
    if (!selected) {
      setChunks([]);
      return;
    }
    let alive = true;
    void pi
      .kbChunks(workspace, selected)
      .then((c) => {
        if (alive) setChunks(c);
      })
      .catch(() => {
        if (alive) setChunks([]);
      });
    return () => {
      alive = false;
    };
  }, [workspace, selected]);

  const header = (
    <Flexbox horizontal align="center" gap={12} data-testid="kb-header" style={{ fontSize: 13 }}>
      <span>{stats ? `${stats.chunks} 块 · ${stats.sources} 文档` : '加载中…'}</span>
      <span style={{ color: muted }}>{stats?.model ? `embedding: ${stats.model}` : 'keyword 模式'}</span>
    </Flexbox>
  );

  let list: React.ReactNode;
  if (error) {
    list = <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>;
  } else if (sources.length === 0) {
    list = (
      <div data-testid="kb-empty" style={{ padding: 14, fontSize: 12, color: muted }}>
        知识库为空
      </div>
    );
  } else {
    list = (
      <Flexbox>
        {sources.map((s) => {
          const active = s.source === selected;
          return (
            <button
              key={s.source}
              data-testid={`kb-source-${s.source}`}
              onClick={() => setSelected(s.source)}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                border: 'none',
                borderBottom: border,
                cursor: 'pointer',
                textAlign: 'left',
                background: active ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent',
                color: active ? 'var(--gren-fg, inherit)' : 'inherit',
                fontSize: 12,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.source}
              </span>
              <span style={{ color: muted, flex: '0 0 auto' }}>{s.chunks}</span>
            </button>
          );
        })}
      </Flexbox>
    );
  }

  const detail = selected ? (
    <Flexbox gap={10} data-testid="kb-detail">
      {chunks.map((c) => (
        <div key={c.id} style={{ border, borderRadius: 8, padding: 10, fontSize: 13 }}>
          <LazyMarkdown>{c.text}</LazyMarkdown>
        </div>
      ))}
    </Flexbox>
  ) : (
    <div style={{ color: muted, fontSize: 13 }}>选择左侧文档查看片段</div>
  );

  return <ManagerLayout testId="knowledge-panel" header={header} list={list} detail={detail} />;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/knowledge/KnowledgePanel.test.tsx`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/knowledge/KnowledgePanel.tsx tauri-agent/src/features/knowledge/KnowledgePanel.test.tsx
git commit -m "feat(grenagent): add KnowledgePanel (phase3)"
```

---

## 任务 6：MemoryPanel

**文件：**
- 创建：`tauri-agent/src/features/memory/MemoryPanel.tsx`
- 测试：`tauri-agent/src/features/memory/MemoryPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/memory/MemoryPanel.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

const memStats = vi.fn(() => Promise.resolve({ project: 1, global: 1 }));
const memList = vi.fn(() =>
  Promise.resolve([
    { id: 'g1', text: 'global fact', category: null, createdAt: 200, scope: 'global' },
    { id: 'p1', text: 'project pref', category: 'preference', createdAt: 100, scope: 'project' },
  ]),
);
vi.mock('../../lib/pi', () => ({ pi: { memStats, memList } }));

import { MemoryPanel } from './MemoryPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MemoryPanel', () => {
  it('shows stats and both scopes by default', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-header').textContent).toContain('项目 1'));
    expect(screen.getByTestId('mem-header').textContent).toContain('全局 1');
    expect(screen.getByTestId('mem-item-global-g1')).toBeTruthy();
    expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy();
  });

  it('filters by scope', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-filter-project'));
    expect(screen.queryByTestId('mem-item-global-g1')).toBeNull();
    expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy();
  });

  it('shows detail when an item is clicked', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-item-project-p1'));
    expect(screen.getByTestId('mem-detail').textContent).toContain('project pref');
    expect(screen.getByTestId('mem-detail').textContent).toContain('preference');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/memory/MemoryPanel.test.tsx`
预期：FAIL，"Cannot find module './MemoryPanel'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/features/memory/MemoryPanel.tsx`：

```tsx
import { Flexbox } from '@lobehub/ui';
import { useEffect, useMemo, useState } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type MemItem, type MemStats } from '../../lib/pi';
import { ManagerLayout } from '../common/ManagerLayout';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

type ScopeFilter = 'all' | 'project' | 'global';
const FILTERS: { id: ScopeFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'project', label: '项目' },
  { id: 'global', label: '全局' },
];

function formatTime(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function MemoryPanel() {
  const { workspace } = useAgentStoreContext();
  const [stats, setStats] = useState<MemStats | null>(null);
  const [items, setItems] = useState<MemItem[]>([]);
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    void Promise.all([pi.memStats(workspace), pi.memList(workspace)])
      .then(([s, list]) => {
        if (!alive) return;
        setStats(s);
        setItems(list);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((m) => m.scope === filter)),
    [items, filter],
  );
  const selected = useMemo(
    () => filtered.find((m) => `${m.scope}:${m.id}` === selectedKey) ?? null,
    [filtered, selectedKey],
  );

  const header = (
    <Flexbox horizontal align="center" gap={12} data-testid="mem-header" style={{ fontSize: 13 }}>
      <span>{stats ? `项目 ${stats.project} · 全局 ${stats.global}` : '加载中…'}</span>
      <Flexbox horizontal gap={4}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            data-testid={`mem-filter-${f.id}`}
            onClick={() => setFilter(f.id)}
            style={{
              padding: '2px 10px',
              borderRadius: 6,
              border,
              cursor: 'pointer',
              fontSize: 12,
              background: filter === f.id ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent',
              color: filter === f.id ? 'var(--gren-fg, inherit)' : muted,
            }}
          >
            {f.label}
          </button>
        ))}
      </Flexbox>
    </Flexbox>
  );

  let list: React.ReactNode;
  if (error) {
    list = <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>;
  } else if (filtered.length === 0) {
    list = (
      <div data-testid="mem-empty" style={{ padding: 14, fontSize: 12, color: muted }}>
        暂无记忆
      </div>
    );
  } else {
    list = (
      <Flexbox>
        {filtered.map((m) => {
          const key = `${m.scope}:${m.id}`;
          const active = key === selectedKey;
          return (
            <button
              key={key}
              data-testid={`mem-item-${m.scope}-${m.id}`}
              onClick={() => setSelectedKey(key)}
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
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.text}
              </span>
              <span style={{ color: muted, fontSize: 11 }}>
                {m.scope === 'global' ? '全局' : '项目'}
                {m.category ? ` · ${m.category}` : ''}
              </span>
            </button>
          );
        })}
      </Flexbox>
    );
  }

  const detail = selected ? (
    <Flexbox gap={10} data-testid="mem-detail">
      <div style={{ fontSize: 14, lineHeight: 1.6 }}>{selected.text}</div>
      <Flexbox gap={4} style={{ fontSize: 12, color: muted }}>
        <span>scope：{selected.scope === 'global' ? '全局' : '项目'}</span>
        <span>category：{selected.category ?? '（无）'}</span>
        <span>时间：{formatTime(selected.createdAt)}</span>
      </Flexbox>
    </Flexbox>
  ) : (
    <div style={{ color: muted, fontSize: 13 }}>选择左侧记忆查看详情</div>
  );

  return <ManagerLayout testId="memory-panel" header={header} list={list} detail={detail} />;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/memory/MemoryPanel.test.tsx`
预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/memory/MemoryPanel.tsx tauri-agent/src/features/memory/MemoryPanel.test.tsx
git commit -m "feat(grenagent): add MemoryPanel with scope filter (phase3)"
```

---

## 任务 7：ModuleContainer 接入两面板

**文件：**
- 修改：`tauri-agent/src/features/workspace/ModuleContainer.tsx`
- 修改：`tauri-agent/src/features/workspace/ModuleContainer.test.tsx`

- [ ] **步骤 1：更新测试（先改测试，体现新分派契约）**

把 `tauri-agent/src/features/workspace/ModuleContainer.test.tsx` 整体替换为：

```tsx
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { ModuleContainer } from './ModuleContainer';
import { useModuleStore } from '../../stores/moduleStore';

vi.mock('../knowledge/KnowledgePanel', () => ({ KnowledgePanel: () => <div>KB_PANEL</div> }));
vi.mock('../memory/MemoryPanel', () => ({ MemoryPanel: () => <div>MEM_PANEL</div> }));

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
});

afterEach(() => {
  cleanup();
});

describe('ModuleContainer', () => {
  it('renders chat content when chat module is active', () => {
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('CHAT_CONTENT')).toBeTruthy();
  });

  it('renders KnowledgePanel for knowledge module', () => {
    useModuleStore.setState({ activeModule: 'knowledge' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('KB_PANEL')).toBeTruthy();
    expect(screen.queryByText('CHAT_CONTENT')).toBeNull();
  });

  it('renders MemoryPanel for memory module', () => {
    useModuleStore.setState({ activeModule: 'memory' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('MEM_PANEL')).toBeTruthy();
  });

  it('renders placeholder with module title for not-yet-built modules', () => {
    useModuleStore.setState({ activeModule: 'review' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    const panel = screen.getByTestId('placeholder-panel');
    expect(panel.textContent).toContain('审查');
    expect(screen.queryByText('CHAT_CONTENT')).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/workspace/ModuleContainer.test.tsx`
预期：FAIL —— knowledge/memory 用例找不到 `KB_PANEL`/`MEM_PANEL`（当前仍渲染 placeholder）。

- [ ] **步骤 3：修改 ModuleContainer 分派**

把 `tauri-agent/src/features/workspace/ModuleContainer.tsx` 整体替换为：

```tsx
import type { ReactNode } from 'react';
import { type ModuleId, useModuleStore } from '../../stores/moduleStore';
import { PlaceholderPanel } from './PlaceholderPanel';
import { KnowledgePanel } from '../knowledge/KnowledgePanel';
import { MemoryPanel } from '../memory/MemoryPanel';

const MODULE_TITLES: Record<Exclude<ModuleId, 'chat'>, string> = {
  knowledge: '知识库',
  memory: '记忆',
  review: '审查',
  create: '创作',
  connections: '连接',
  settings: '设置',
};

export function ModuleContainer({ chat }: { chat: ReactNode }) {
  const activeModule = useModuleStore((s) => s.activeModule);
  if (activeModule === 'chat') return <>{chat}</>;
  if (activeModule === 'knowledge') return <KnowledgePanel />;
  if (activeModule === 'memory') return <MemoryPanel />;
  return <PlaceholderPanel title={MODULE_TITLES[activeModule]} />;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/workspace/ModuleContainer.test.tsx`
预期：PASS（4 passed）。

- [ ] **步骤 5：类型检查 + 全量前端测试**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

运行：`cd tauri-agent && npx vitest run`
预期：全部 PASS，无回归（含 phase1/2 既有测试 + 本期新增）。

- [ ] **步骤 6：手动验证（Tauri GUI）**

运行：`cd tauri-agent && npm run tauri dev`，在应用里：
1. 准备数据：在某项目对话里让 agent 调 `kb_add` 索引一个文件、`memory_save` 存一条记忆（或确保 `.pi/knowledge/default.db`、`.pi/memory/memory.db` 已有数据）。
2. 点模块栏「知识库」：顶部显示 chunks/文档数与模式；左列表显示文档（source + chunk 数）；点文档右侧显示片段。
3. 点模块栏「记忆」：顶部显示项目/全局计数；左列表显示记忆；点「项目/全局」筛选生效；点条目右侧显示详情（text/category/scope/时间）。
4. 点回「对话」：聊天界面照常。

- [ ] **步骤 7：Commit**

```bash
git add tauri-agent/src/features/workspace/ModuleContainer.tsx tauri-agent/src/features/workspace/ModuleContainer.test.tsx
git commit -m "feat(grenagent): wire Knowledge/Memory panels into ModuleContainer (phase3)"
```

---

## 自检

**1. 规格覆盖度（对应设计 §3、§4.2、§4.3、§7、§10 第 3 期）：**
- 管理视图统一范式「顶部状态+操作 / 左列表 / 右详情」（§3、§4.5 范式）→ 任务 4 `ManagerLayout`，任务 5/6 复用 ✓
- 知识库面板：状态（chunks/文档/模式）+ 文档列表（source+chunk 数）+ 片段详情（§4.2）→ 任务 5 ✓（写操作「添加/重索引/清空」、「测试检索」框列为非本期，见下）
- 记忆面板：状态（项目 N/全局 M）+ scope 筛选 + 列表（text/category/scope）+ 详情（§4.3）→ 任务 6 ✓（写操作「编辑/删除/提升全局」列为非本期）
- 数据来源 `.pi/knowledge/default.db`、项目/全局 `memory` db（§4.2/§4.3/§8）→ 任务 1/2 Rust 直读 ✓
- 数据读路径采用「Rust 直读 sqlite」（§8 推荐读路径，用户已确认）→ 任务 1/2/3 ✓
- 模块容器把 knowledge/memory 接真实面板（§7）→ 任务 7 ✓
- 全程无 emoji、图标用 lucide / 纯文本（§9.1）→ 本期面板用文本标签 + 既有 lucide 模块图标，无 emoji ✓

**2. 占位符扫描：** 无 TODO/待定/「类似任务 N」。每步含完整代码、精确命令、预期输出。`PlaceholderPanel`（review/create/connections/settings）是产品占位，非计划占位。

**3. 类型一致性：**
- Rust `open_readonly`（任务 1 `pub(crate)`）被任务 2 `memory.rs` 复用，签名 `(&Path)->Result<Option<Connection>,String>` 一致。
- Rust 结构体 `#[serde(rename_all="camelCase")]` → 前端类型字段：`MemItem.created_at`→`createdAt`、`MemStats{project,global}`、`KbStats{chunks,sources,model}` 与任务 3 `lib/pi.ts` 接口一致；命令名 `kb_stats/kb_sources/kb_chunks/mem_stats/mem_list` 在 Rust `#[tauri::command]`、`lib.rs` 注册、`pi.ts` `invoke<>(...)` 三处一致。
- 前端 `pi.kbStats/kbSources/kbChunks/memStats/memList` 签名（任务 3）与任务 5/6 调用、各自 `.test` 的 mock 一致。
- `ManagerLayout` props `{header,list,detail,testId}`（任务 4）与任务 5/6 调用一致。
- `MemItem.scope: 'project'|'global'`（任务 3）与任务 6 筛选/详情、`mem-item-${scope}-${id}` testid 一致。
- `ModuleContainer` 对 `knowledge`→`KnowledgePanel`、`memory`→`MemoryPanel`（任务 7）与任务 5/6 导出名一致；`MODULE_TITLES` 仍覆盖 `Exclude<ModuleId,'chat'>` 全部键（含已接真实面板的 knowledge/memory，保证类型完整，运行时不会命中）。

## 备注

- **命令用同步 `fn`**（非 `async`）：rusqlite 是阻塞 API，Tauri 对同步命令自动在线程池执行，避免阻塞 async 运行时；现有 `agent_*` 是 async（走 PiManager 异步通道），二者混用无碍。
- **只读打开**（`SQLITE_OPEN_READ_ONLY`）：面板永不写库，杜绝与 extension 的写竞争；db 不存在返回空/零，首次未建库的项目面板显示空态而非报错。
- **写操作（非本期）**：添加文档/重索引/清空/删除记忆/提升全局，按设计 §8「写经 extension 保证一致」，应通过触发对应工具（`kb_add`/`memory_save`）或新增 extension 命令实现，避免 Rust 直写造成与 node:sqlite 端 schema/embedding 不一致；留待后续期或单独增强。
- **知识库「测试检索」框（非本期）**：检索需 embedding/keyword 打分（现 score 仅在 extension `search()` 内计算），接入需复用 `kb_search` 工具或在 Rust 侧重实现打分，单列后续。
- **embedding BLOB 列**：读命令一律不 SELECT/不解析，列表与详情无需向量。
- **全局记忆路径**：以 `long-term-memory/index.ts` 代码为准（`~/.pi/agent/long-term-memory.db`，`MEMORY_GLOBAL_DB` 可覆盖）；其源码顶部注释写的 `memory.db` 是笔误，已据代码修正。
- **CSS 变量 `--gren-*`** 为占位回退，可后续对接 `themeStore`，不影响功能与测试。
- **Cargo.lock**：任务 1 新增 rusqlite 后 `Cargo.lock` 会变更，已包含在该任务 commit。
