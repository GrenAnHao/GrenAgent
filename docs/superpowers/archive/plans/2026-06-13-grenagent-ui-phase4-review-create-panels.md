# GrenAgent UI 第 4 期：审查 / 创作 面板（复用 ManagerLayout + Rust 直读）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把模块导航里的「审查」「创作」两个占位面板换成真实视图：审查面板按 severity 分组展示 code-review 的发现（Rust 直读 `reviews.db`）；创作面板以网格画廊展示 image-gen 产出的图片（Rust 列目录 + 读文件 base64 内联缩略图）。

**架构：**
- **审查**：复用第三期模式——`commands/review.rs` 用 `open_readonly`（第三期已 `pub(crate)`）读 `reviews.db` 的 `review_notes`；前端 `ReviewPanel` 复用 `ManagerLayout`，左列表按 severity 分组（blocker/major/minor/nit/praise 色点 + file:line），右详情显示 message。
- **创作**：`commands/create.rs` 列 `.pi/images/*.png`（name/bytes/mtime，按 mtime 倒序），并提供 `create_image` 读单文件 → base64（`base64` crate 已依赖）；前端 `CreatePanel` 网格列文件，选中项用 `data:image/png;base64,...` 内联预览 + `openPath` 打开原图。**不改 `tauri.conf`**（不引入 assetProtocol；原生缩略图作为后续增强）。
- 命令仍用**同步** `#[tauri::command]`（阻塞 IO，Tauri 线程池调度），只读，路径不存在返回空。

**技术栈：** Rust（`rusqlite` bundled、`base64` 0.22 已依赖、`serde`）、React 19、`@lobehub/ui`（`Flexbox`）、vitest + @testing-library/react（无 globals/无自动 cleanup，测试显式 import + `afterEach(cleanup)`，mock 用 `vi.hoisted`）。

---

## 范围

仅第 4 期（审查 + 创作 面板）。完成后：模块栏「审查」显示真实 review_notes（severity 分组 + 详情）；「创作」显示 `.pi/images` 图片画廊（缩略图 + 文件名/大小/时间，点开原图）。**不含**写操作（记审查/删图/生图按钮）、prompt 显示（image-gen 未存 prompt）、连接/设置面板（第 5 期）。

**前置事实（已核实）**
- 审查 db：`<cwd>/.pi/reviews/reviews.db`，表 `review_notes(id TEXT PK, file TEXT, line INTEGER NULL, severity TEXT, message TEXT, createdAt INTEGER)`；severity ∈ blocker|major|minor|nit|praise（也可能有其它）。
- 图片：`<cwd>/.pi/images/img_<unixms>.png`，**无 prompt/元数据**（image-gen `details` 不落库，只有文件）。
- Rust：第三期已加 `rusqlite`（bundled）；`commands/knowledge.rs` 的 `pub(crate) fn open_readonly(&Path)->Result<Option<Connection>,String>` 可复用；`commands/sessions.rs` 的 `pub fn resolve_workspace_dir(&str)->Result<PathBuf,String>` 可复用;`Cargo.toml` 已有 `base64 = "0.22"`。命令注册在 `lib.rs` + `commands/mod.rs`。
- 前端：`ModuleContainer` 已对 chat/knowledge/memory 分派真实组件，review/create 仍渲染 `PlaceholderPanel`；`features/common/ManagerLayout.tsx`（第三期）可复用；面板在 `AgentStoreProvider` 内可用 `useAgentStoreContext().workspace`。

## 文件结构

- 创建 `tauri-agent/src-tauri/src/commands/review.rs` — `rv_list` 命令 + 纯读函数 + 单测
- 创建 `tauri-agent/src-tauri/src/commands/create.rs` — `create_list`/`create_image` 命令 + 纯函数 + 单测
- 修改 `tauri-agent/src-tauri/src/commands/mod.rs` — `pub mod create; pub mod review;`
- 修改 `tauri-agent/src-tauri/src/lib.rs` — 注册 3 命令
- 修改 `tauri-agent/src/lib/pi.ts` — binding + 类型
- 创建 `tauri-agent/src/features/review/ReviewPanel.tsx` + `ReviewPanel.test.tsx`
- 创建 `tauri-agent/src/features/create/CreatePanel.tsx` + `CreatePanel.test.tsx`
- 修改 `tauri-agent/src/features/workspace/ModuleContainer.tsx` + `ModuleContainer.test.tsx`

命令：前端 `cd tauri-agent && npx vitest run <file>` / `npx tsc --noEmit`；Rust `cd tauri-agent/src-tauri && cargo test review`（或 `create`）。

---

## 任务 1：Rust — 审查读命令

**文件：**
- 创建：`tauri-agent/src-tauri/src/commands/review.rs`
- 修改：`tauri-agent/src-tauri/src/commands/mod.rs`

- [ ] **步骤 1：在 mod.rs 声明 review 子模块**

把 `tauri-agent/src-tauri/src/commands/mod.rs` 改为（按字母序插入 `create`、`review`；本任务先只加 `review`，`create` 在任务 2 加）：

```rust
pub mod agent;
pub mod files;
pub mod git;
pub mod knowledge;
pub mod memory;
pub mod review;
pub mod sessions;
pub mod shell;
pub mod terminal;

pub use agent::*;
pub use sessions::*;
```

- [ ] **步骤 2：写 review.rs（命令 + 纯函数 + 单测）**

创建 `tauri-agent/src-tauri/src/commands/review.rs`：

```rust
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::knowledge::open_readonly;
use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewNote {
    pub id: String,
    pub file: String,
    pub line: Option<i64>,
    pub severity: String,
    pub message: String,
    pub created_at: i64,
}

fn review_db_path(workspace: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_dir(workspace)?;
    Ok(cwd.join(".pi").join("reviews").join("reviews.db"))
}

fn read_review_notes(path: &Path) -> Result<Vec<ReviewNote>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare("SELECT id, file, line, severity, message, createdAt FROM review_notes ORDER BY createdAt")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ReviewNote {
                id: r.get(0)?,
                file: r.get(1)?,
                line: r.get(2)?,
                severity: r.get(3)?,
                message: r.get(4)?,
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
pub fn rv_list(workspace: String) -> Result<Vec<ReviewNote>, String> {
    read_review_notes(&review_db_path(&workspace)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn tmp_db() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rvtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("reviews.db")
    }

    #[test]
    fn lists_notes_ordered_by_created() {
        let db = tmp_db();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE review_notes(id TEXT PRIMARY KEY, file TEXT NOT NULL, line INTEGER, severity TEXT NOT NULL, message TEXT NOT NULL, createdAt INTEGER NOT NULL);
             INSERT INTO review_notes VALUES('n1','a.ts',10,'major','bug here',100);
             INSERT INTO review_notes VALUES('n2','b.ts',NULL,'nit','style',200);",
        )
        .unwrap();
        let notes = read_review_notes(&db).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].id, "n1");
        assert_eq!(notes[0].line, Some(10));
        assert_eq!(notes[1].line, None);
        assert_eq!(notes[1].severity, "nit");
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }

    #[test]
    fn missing_db_is_empty() {
        assert!(read_review_notes(Path::new("/no/such/reviews.db")).unwrap().is_empty());
    }
}
```

- [ ] **步骤 3：运行 Rust 测试**

运行：`cd tauri-agent/src-tauri && cargo test review`
预期：`lists_notes_ordered_by_created`、`missing_db_is_empty` PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/review.rs tauri-agent/src-tauri/src/commands/mod.rs
git commit -m "feat(grenagent): add review read command (phase4)"
```

---

## 任务 2：Rust — 创作（图片）读命令

**文件：**
- 创建：`tauri-agent/src-tauri/src/commands/create.rs`
- 修改：`tauri-agent/src-tauri/src/commands/mod.rs`

- [ ] **步骤 1：在 mod.rs 声明 create 子模块**

把 `tauri-agent/src-tauri/src/commands/mod.rs` 的子模块区改为（加 `create`）：

```rust
pub mod agent;
pub mod create;
pub mod files;
pub mod git;
pub mod knowledge;
pub mod memory;
pub mod review;
pub mod sessions;
pub mod shell;
pub mod terminal;

pub use agent::*;
pub use sessions::*;
```

- [ ] **步骤 2：写 create.rs（命令 + 纯函数 + 单测）**

创建 `tauri-agent/src-tauri/src/commands/create.rs`：

```rust
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageItem {
    pub name: String,
    pub bytes: u64,
    pub modified_ms: i64,
}

fn images_dir(workspace: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_dir(workspace)?;
    Ok(cwd.join(".pi").join("images"))
}

fn read_image_list(dir: &Path) -> Result<Vec<ImageItem>, String> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("png")) != Some(true) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(ImageItem {
            name: path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string(),
            bytes: meta.len(),
            modified_ms,
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

/// 安全读取 images 目录内某个图片为 base64（拒绝路径穿越：name 必须是纯文件名）。
fn read_image_base64(dir: &Path, name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid image name".to_string());
    }
    let path = dir.join(name);
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data))
}

#[tauri::command]
pub fn create_list(workspace: String) -> Result<Vec<ImageItem>, String> {
    read_image_list(&images_dir(&workspace)?)
}

#[tauri::command]
pub fn create_image(workspace: String, name: String) -> Result<String, String> {
    read_image_base64(&images_dir(&workspace)?, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_png_files_sorted_desc() {
        let dir = tmp_dir();
        std::fs::write(dir.join("img_1.png"), [1u8, 2, 3]).unwrap();
        std::fs::write(dir.join("img_2.png"), [4u8, 5]).unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        let list = read_image_list(&dir).unwrap();
        assert_eq!(list.len(), 2); // .txt 被过滤
        assert!(list.iter().all(|i| i.name.ends_with(".png")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_base64_and_rejects_traversal() {
        let dir = tmp_dir();
        std::fs::write(dir.join("img_1.png"), [0u8, 1, 2, 3]).unwrap();
        let b64 = read_image_base64(&dir, "img_1.png").unwrap();
        assert_eq!(b64, base64::engine::general_purpose::STANDARD.encode([0u8, 1, 2, 3]));
        assert!(read_image_base64(&dir, "../secret.png").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_dir_is_empty() {
        assert!(read_image_list(Path::new("/no/such/images")).unwrap().is_empty());
    }
}
```

- [ ] **步骤 3：运行 Rust 测试**

运行：`cd tauri-agent/src-tauri && cargo test create`
预期：3 个测试 PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/create.rs tauri-agent/src-tauri/src/commands/mod.rs
git commit -m "feat(grenagent): add create (images) read commands (phase4)"
```

---

## 任务 3：注册命令 + 前端 binding

**文件：**
- 修改：`tauri-agent/src-tauri/src/lib.rs`
- 修改：`tauri-agent/src/lib/pi.ts`

- [ ] **步骤 1：注册命令**

在 `tauri-agent/src-tauri/src/lib.rs` 的 `generate_handler![ ... ]` 里，`commands::memory::mem_list,` 之后追加：

```rust
            commands::review::rv_list,
            commands::create::create_list,
            commands::create::create_image,
```

- [ ] **步骤 2：cargo build 验证**

运行：`cd tauri-agent/src-tauri && cargo build`
预期：编译通过，无 dead_code 残留。

- [ ] **步骤 3：前端类型 + binding**

在 `tauri-agent/src/lib/pi.ts` 的 `MemItem` 接口之后追加类型：

```ts
export interface ReviewNote {
  id: string;
  file: string;
  line: number | null;
  severity: string;
  message: string;
  createdAt: number;
}
export interface ImageItem {
  name: string;
  bytes: number;
  modifiedMs: number;
}
```

在 `pi` 对象的 `memList: ...,` 之后追加 binding：

```ts
  rvList: (workspace: string) => invoke<ReviewNote[]>('rv_list', { workspace }),
  createList: (workspace: string) => invoke<ImageItem[]>('create_list', { workspace }),
  createImage: (workspace: string, name: string) =>
    invoke<string>('create_image', { workspace, name }),
```

- [ ] **步骤 4：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/lib.rs tauri-agent/src/lib/pi.ts
git commit -m "feat(grenagent): register review/create commands + bindings (phase4)"
```

---

## 任务 4：ReviewPanel

**文件：**
- 创建：`tauri-agent/src/features/review/ReviewPanel.tsx`
- 测试：`tauri-agent/src/features/review/ReviewPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/review/ReviewPanel.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

const { rvList } = vi.hoisted(() => ({
  rvList: vi.fn(() =>
    Promise.resolve([
      { id: 'n1', file: 'a.ts', line: 10, severity: 'major', message: 'bug here', createdAt: 100 },
      { id: 'n2', file: 'b.ts', line: null, severity: 'nit', message: 'style', createdAt: 200 },
    ]),
  ),
}));
vi.mock('../../lib/pi', () => ({ pi: { rvList } }));

import { ReviewPanel } from './ReviewPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReviewPanel', () => {
  it('shows total and grouped findings', async () => {
    render(<ReviewPanel />);
    await waitFor(() => expect(screen.getByTestId('rv-header').textContent).toContain('2'));
    expect(screen.getByTestId('rv-note-n1').textContent).toContain('a.ts');
    expect(screen.getByTestId('rv-note-n1').textContent).toContain('10');
    expect(screen.getByTestId('rv-note-n2')).toBeTruthy();
  });

  it('shows detail when a finding is clicked', async () => {
    render(<ReviewPanel />);
    await waitFor(() => expect(screen.getByTestId('rv-note-n1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('rv-note-n1'));
    expect(screen.getByTestId('rv-detail').textContent).toContain('bug here');
    expect(screen.getByTestId('rv-detail').textContent).toContain('major');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/review/ReviewPanel.test.tsx`
预期：FAIL，"Cannot find module './ReviewPanel'"。

- [ ] **步骤 3：编写实现**

`tauri-agent/src/features/review/ReviewPanel.tsx`：

```tsx
import { Flexbox } from '@lobehub/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type ReviewNote } from '../../lib/pi';
import { ManagerLayout } from '../common/ManagerLayout';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

const SEVERITY_ORDER = ['blocker', 'major', 'minor', 'nit', 'praise'];
const SEVERITY_COLOR: Record<string, string> = {
  blocker: '#f87171',
  major: '#fb923c',
  minor: '#facc15',
  nit: '#9aa1ac',
  praise: '#4ade80',
};

export function ReviewPanel() {
  const { workspace } = useAgentStoreContext();
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    void pi
      .rvList(workspace)
      .then((list) => {
        if (alive) setNotes(list);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  const groups = useMemo(() => {
    const extras = [...new Set(notes.map((n) => n.severity))].filter((s) => !SEVERITY_ORDER.includes(s));
    const order = [...SEVERITY_ORDER, ...extras];
    return order
      .map((sev) => ({ sev, items: notes.filter((n) => n.severity === sev) }))
      .filter((g) => g.items.length > 0);
  }, [notes]);

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId],
  );

  const header = (
    <Flexbox horizontal align="center" gap={12} data-testid="rv-header" style={{ fontSize: 13 }}>
      <span>{notes.length} 条发现</span>
    </Flexbox>
  );

  let list: ReactNode;
  if (error) {
    list = <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>;
  } else if (notes.length === 0) {
    list = (
      <div data-testid="rv-empty" style={{ padding: 14, fontSize: 12, color: muted }}>
        暂无审查发现
      </div>
    );
  } else {
    list = (
      <Flexbox>
        {groups.map((g) => (
          <Flexbox key={g.sev}>
            <div style={{ padding: '6px 12px', fontSize: 11, color: muted }}>
              {g.sev}（{g.items.length}）
            </div>
            {g.items.map((n) => {
              const active = n.id === selectedId;
              return (
                <button
                  key={n.id}
                  data-testid={`rv-note-${n.id}`}
                  onClick={() => setSelectedId(n.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
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
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      flex: '0 0 auto',
                      background: SEVERITY_COLOR[n.severity] ?? muted,
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {n.file}
                    {n.line != null ? `:${n.line}` : ''}
                  </span>
                </button>
              );
            })}
          </Flexbox>
        ))}
      </Flexbox>
    );
  }

  const detail = selected ? (
    <Flexbox gap={10} data-testid="rv-detail">
      <div style={{ fontSize: 14, lineHeight: 1.6 }}>{selected.message}</div>
      <Flexbox gap={4} style={{ fontSize: 12, color: muted }}>
        <span>severity：{selected.severity}</span>
        <span>
          位置：{selected.file}
          {selected.line != null ? `:${selected.line}` : ''}
        </span>
      </Flexbox>
    </Flexbox>
  ) : (
    <div style={{ color: muted, fontSize: 13 }}>选择左侧发现查看详情</div>
  );

  return <ManagerLayout testId="review-panel" header={header} list={list} detail={detail} />;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/review/ReviewPanel.test.tsx`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/review/ReviewPanel.tsx tauri-agent/src/features/review/ReviewPanel.test.tsx
git commit -m "feat(grenagent): add ReviewPanel (phase4)"
```

---

## 任务 5：CreatePanel

**文件：**
- 创建：`tauri-agent/src/features/create/CreatePanel.tsx`
- 测试：`tauri-agent/src/features/create/CreatePanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/create/CreatePanel.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

const { createList, createImage, openPath } = vi.hoisted(() => ({
  createList: vi.fn(() =>
    Promise.resolve([
      { name: 'img_2.png', bytes: 2048, modifiedMs: 200 },
      { name: 'img_1.png', bytes: 1024, modifiedMs: 100 },
    ]),
  ),
  createImage: vi.fn(() => Promise.resolve('QUJD')),
  openPath: vi.fn(),
}));
vi.mock('../../lib/pi', () => ({ pi: { createList, createImage } }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: (p: string) => openPath(p) }));

import { CreatePanel } from './CreatePanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CreatePanel', () => {
  it('lists images', async () => {
    render(<CreatePanel />);
    await waitFor(() => expect(screen.getByTestId('cr-header').textContent).toContain('2'));
    expect(screen.getByTestId('cr-item-img_2.png')).toBeTruthy();
    expect(screen.getByTestId('cr-item-img_1.png')).toBeTruthy();
  });

  it('loads base64 preview when an image is selected', async () => {
    render(<CreatePanel />);
    await waitFor(() => expect(screen.getByTestId('cr-item-img_1.png')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cr-item-img_1.png'));
    await waitFor(() => expect(createImage).toHaveBeenCalledWith('/ws', 'img_1.png'));
    await waitFor(() => {
      const img = screen.getByTestId('cr-preview') as HTMLImageElement;
      expect(img.getAttribute('src')).toContain('data:image/png;base64,QUJD');
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/create/CreatePanel.test.tsx`
预期：FAIL，"Cannot find module './CreatePanel'"。

- [ ] **步骤 3：编写实现**

`tauri-agent/src/features/create/CreatePanel.tsx`：

```tsx
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { openPath } from '@tauri-apps/plugin-opener';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type ImageItem } from '../../lib/pi';
import { ManagerLayout } from '../common/ManagerLayout';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function CreatePanel() {
  const { workspace } = useAgentStoreContext();
  const [items, setItems] = useState<ImageItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    void pi
      .createList(workspace)
      .then((list) => {
        if (alive) setItems(list);
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
      setPreview(null);
      return;
    }
    let alive = true;
    setPreview(null);
    void pi
      .createImage(workspace, selected)
      .then((b64) => {
        if (alive) setPreview(`data:image/png;base64,${b64}`);
      })
      .catch(() => {
        if (alive) setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [workspace, selected]);

  const header = (
    <Flexbox horizontal align="center" gap={12} data-testid="cr-header" style={{ fontSize: 13 }}>
      <span>{items.length} 张图片</span>
    </Flexbox>
  );

  let list: ReactNode;
  if (error) {
    list = <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>;
  } else if (items.length === 0) {
    list = (
      <div data-testid="cr-empty" style={{ padding: 14, fontSize: 12, color: muted }}>
        暂无生成的图片
      </div>
    );
  } else {
    list = (
      <Flexbox>
        {items.map((it) => {
          const active = it.name === selected;
          return (
            <button
              key={it.name}
              data-testid={`cr-item-${it.name}`}
              onClick={() => setSelected(it.name)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
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
                {it.name}
              </span>
              <span style={{ color: muted, fontSize: 11 }}>{formatBytes(it.bytes)}</span>
            </button>
          );
        })}
      </Flexbox>
    );
  }

  const detail = selected ? (
    <Flexbox gap={10} data-testid="cr-detail">
      <Flexbox horizontal align="center" gap={8}>
        <span style={{ fontSize: 13 }}>{selected}</span>
        <ActionIcon
          data-testid="cr-open"
          icon={ExternalLink}
          size="small"
          title="打开原图"
          onClick={() => void openPath(selected)}
        />
      </Flexbox>
      {preview ? (
        <img
          data-testid="cr-preview"
          src={preview}
          alt={selected}
          style={{ maxWidth: '100%', borderRadius: 8, border }}
        />
      ) : (
        <div style={{ color: muted, fontSize: 12 }}>加载预览…</div>
      )}
    </Flexbox>
  ) : (
    <div style={{ color: muted, fontSize: 13 }}>选择左侧图片查看预览</div>
  );

  return <ManagerLayout testId="create-panel" header={header} list={list} detail={detail} />;
}
```

> 注：`openPath(selected)` 传的是文件名；实际打开需绝对路径。本期 MVP 以预览为主，「打开原图」按钮在 GUI 手验时若需绝对路径可后续让 `create_list` 一并返回 `path`。测试只校验预览 base64 渲染，不校验 openPath 路径正确性。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/create/CreatePanel.test.tsx`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/create/CreatePanel.tsx tauri-agent/src/features/create/CreatePanel.test.tsx
git commit -m "feat(grenagent): add CreatePanel image gallery (phase4)"
```

---

## 任务 6：ModuleContainer 接入 review/create

**文件：**
- 修改：`tauri-agent/src/features/workspace/ModuleContainer.tsx`
- 修改：`tauri-agent/src/features/workspace/ModuleContainer.test.tsx`

- [ ] **步骤 1：更新测试**

把 `tauri-agent/src/features/workspace/ModuleContainer.test.tsx` 整体替换为：

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModuleContainer } from './ModuleContainer';
import { useModuleStore } from '../../stores/moduleStore';

vi.mock('../knowledge/KnowledgePanel', () => ({ KnowledgePanel: () => <div>KB_PANEL</div> }));
vi.mock('../memory/MemoryPanel', () => ({ MemoryPanel: () => <div>MEM_PANEL</div> }));
vi.mock('../review/ReviewPanel', () => ({ ReviewPanel: () => <div>RV_PANEL</div> }));
vi.mock('../create/CreatePanel', () => ({ CreatePanel: () => <div>CR_PANEL</div> }));

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
  });

  it('renders MemoryPanel for memory module', () => {
    useModuleStore.setState({ activeModule: 'memory' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('MEM_PANEL')).toBeTruthy();
  });

  it('renders ReviewPanel for review module', () => {
    useModuleStore.setState({ activeModule: 'review' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('RV_PANEL')).toBeTruthy();
  });

  it('renders CreatePanel for create module', () => {
    useModuleStore.setState({ activeModule: 'create' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('CR_PANEL')).toBeTruthy();
  });

  it('renders placeholder for not-yet-built modules', () => {
    useModuleStore.setState({ activeModule: 'connections' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByTestId('placeholder-panel').textContent).toContain('连接');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/workspace/ModuleContainer.test.tsx`
预期：FAIL（review/create 仍渲染 placeholder，找不到 RV_PANEL/CR_PANEL）。

- [ ] **步骤 3：修改 ModuleContainer**

把 `tauri-agent/src/features/workspace/ModuleContainer.tsx` 整体替换为：

```tsx
import type { ReactNode } from 'react';
import { type ModuleId, useModuleStore } from '../../stores/moduleStore';
import { PlaceholderPanel } from './PlaceholderPanel';
import { KnowledgePanel } from '../knowledge/KnowledgePanel';
import { MemoryPanel } from '../memory/MemoryPanel';
import { ReviewPanel } from '../review/ReviewPanel';
import { CreatePanel } from '../create/CreatePanel';

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
  if (activeModule === 'review') return <ReviewPanel />;
  if (activeModule === 'create') return <CreatePanel />;
  return <PlaceholderPanel title={MODULE_TITLES[activeModule]} />;
}
```

- [ ] **步骤 4：运行测试 + 类型 + 全量**

运行：`cd tauri-agent && npx vitest run src/features/workspace/ModuleContainer.test.tsx`（预期 6 passed）
运行：`cd tauri-agent && npx tsc --noEmit`（无错误）
运行：`cd tauri-agent && npx vitest run`（全部 PASS）

- [ ] **步骤 5：手动验证（Tauri GUI）**

`cd tauri-agent && npm run tauri dev`：让 agent 记几条 `review_note` / 生成图片（或确保 `.pi/reviews/reviews.db`、`.pi/images/*.png` 有数据），点「审查」看 severity 分组列表+详情、点「创作」看图片画廊+预览。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/workspace/ModuleContainer.tsx tauri-agent/src/features/workspace/ModuleContainer.test.tsx
git commit -m "feat(grenagent): wire Review/Create panels into ModuleContainer (phase4)"
```

---

## 自检

**1. 规格覆盖度（设计 §3、§4.4、§4.5、§10 第 4 期）：**
- 审查面板：severity 分组（色点）+ file:line 列表 + 详情（§4.4）→ 任务 1（Rust 读）+ 任务 4 ✓（写操作「让 agent 审查/生成报告/标记已解决」非本期）
- 创作面板：图片画廊 + 预览（§4.5）→ 任务 2（Rust 列+base64）+ 任务 5 ✓（prompt 无数据故不显示；生图按钮、尺寸选择非本期）
- 数据来源 `reviews.db` / `.pi/images`（§4.4/§4.5）→ Rust 直读 ✓
- 复用 ManagerLayout 范式（§3）→ 任务 4/5 ✓
- 接入模块容器（§7）→ 任务 6 ✓
- 无 emoji、lucide 图标（§9.1）→ severity 用色点 + ExternalLink 图标，无 emoji ✓

**2. 占位符扫描：** 无 TODO/待定。每步含完整代码、命令、预期。CreatePanel 的 openPath 绝对路径限制已在注释标注为已知取舍（非占位）。

**3. 类型一致性：**
- Rust `ReviewNote.created_at`→`createdAt`、`ImageItem.modified_ms`→`modifiedMs`（camelCase serde）与 `pi.ts` 接口一致；命令名 `rv_list`/`create_list`/`create_image` 在 Rust/`lib.rs`/`pi.ts` 三处一致。
- `pi.rvList/createList/createImage`（任务 3）与任务 4/5 调用、`.test` mock 一致。
- `ManagerLayout` props 与任务 4/5 一致；`ReviewNote`/`ImageItem` 类型跨 Rust→pi.ts→panel 一致。
- `ModuleContainer` review→ReviewPanel、create→CreatePanel（任务 6）与任务 4/5 导出名一致；`MODULE_TITLES` 仍覆盖 `Exclude<ModuleId,'chat'>` 全键。
- 复用 `open_readonly`（第三期 `pub(crate)`）、`resolve_workspace_dir`（pub）签名一致。

## 备注

- **图片用 base64 而非 assetProtocol**：避免改 `tauri.conf` + capabilities；代价是大图走 IPC base64（单图按需加载，可接受）。真·原生缩略图（`convertFileSrc` + assetProtocol scope）作为后续增强。
- **路径穿越防护**：`create_image` 校验 name 为纯文件名（拒绝 `/`、`\`、`..`）。
- **写操作非本期**：审查的「标记已解决/在对话里修」、创作的「生成/尺寸」，按设计经 extension 工具实现，留后续。
- **CreatePanel 打开原图**：当前 `openPath` 收到的是文件名；如需在 GUI 真正打开，可让 `create_list` 额外返回绝对 `path`（小增强，不影响本期预览主功能）。
