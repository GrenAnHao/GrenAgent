# 「对话 / 项目」双模式 实现计划

> **面向 AI 代理的工作者：** 用 `superpowers:executing-plans` 逐任务内联实现（本仓库**禁止子代理**）。步骤用复选框 `- [ ]` 跟踪。每完成一个任务 commit 一次。

**目标：** 在 `tauri-agent` 引入「对话」（`~/.pi/agent/works/<uuid>` 临时工作目录）与「项目」（自选目录）双入口，支持删除对话 / 移除项目 / 对话标题自动生成。

**架构：** 复用 pi 的 `(cwd, session)` 机制；区分模式的唯一判据是 *cwd 是否在 `~/.pi/agent/works/` 下*；标题用临时 print-mode sidecar 生成，不改 pi。

**技术栈：** Tauri（Rust）+ React/TS（zustand + @lobehub/ui + antd-style）。规格见 `docs/superpowers/specs/2026-06-14-conversation-vs-project-design.md`。

**命令约定（按项目实际包管理替换）：**
- 后端测试：`cd tauri-agent/src-tauri && cargo test <name>`
- 后端编译检查：`cd tauri-agent/src-tauri && cargo check`
- 前端测试：`cd tauri-agent && npx vitest run <file>`
- 前端类型：`cd tauri-agent && npx tsc --noEmit`

---

## 文件结构

**Rust（`tauri-agent/src-tauri/src`）**
- `commands/workspaces.rs`（新）— 对话/项目的创建销毁 + 标题生成：`create_conversation / get_works_dir / delete_conversation / remove_project / auto_title_session` 及私有辅助 `works_dir / delete_sessions_for_cwd / pick_title_model / clean_title / extract_first_user_text / run_pi_print_title`
- `commands/sessions.rs`（改）— 把 `sessions_dir / collect_session_files / read_first_line / paths_equivalent` 提为 `pub(crate)` 供复用
- `commands/mod.rs`（改）— `pub mod workspaces;` + 重导出
- `pi/sidecar.rs`（改）— `pi_package_dir` 提为 `pub(crate)`
- `state/app_state.rs`（改）— `forget_workspace`
- `lib.rs`（改）— 注册命令 + dialog 插件
- `capabilities/default.json`（改）— dialog 权限
- `Cargo.toml`（改）— `tauri-plugin-dialog`

**前端（`tauri-agent/src`）**
- `lib/pathUtils.ts`（改）— `isUnder`
- `lib/dialog.ts`（新）— `pickDirectory`
- `lib/pi.ts`（改）— 5 个封装
- `store/session.ts`（改）— `worksDir`
- `features/sessions/useConversations.ts`（新）
- `features/sessions/useProjectGroups.ts`（改）— worksDir 过滤
- `features/sessions/Sidebar.tsx`（改）— 对话区 + 项目区 header/菜单
- `features/sessions/SidebarActions.tsx`（改）— 入口调整
- `features/sessions/ProjectItem.tsx`（改）— 移除项目
- `App.tsx`（改）— 接线 + 启动默认 + Ctrl+Alt+N + agent_end 自动标题
- 设置面板 — `titleModel` 项

---

## 任务 T1：works 目录基础 + `get_works_dir` + `create_conversation`

**文件：**
- 创建：`tauri-agent/src-tauri/src/commands/workspaces.rs`
- 修改：`tauri-agent/src-tauri/src/commands/mod.rs`
- 修改：`tauri-agent/src-tauri/src/lib.rs`（注册）

- [ ] **步骤 1：新建 `workspaces.rs` 骨架与命令**

```rust
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::pi::PiManager;
use crate::state::AppStateStore;

/// works 根目录：~/.pi/agent/works（与 sessions 同源）。
fn works_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".pi").join("agent").join("works"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationInfo {
    pub cwd: String,
}

/// FR-1：在 ~/.pi/agent/works/<uuid> 下创建目录，返回 canonical 路径。
#[tauri::command]
pub async fn create_conversation() -> Result<ConversationInfo, String> {
    let base = works_dir().ok_or("works directory unavailable")?;
    std::fs::create_dir_all(&base).map_err(|e| format!("create works dir failed: {e}"))?;
    let dir = base.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| format!("create conversation dir failed: {e}"))?;
    let cwd = std::fs::canonicalize(&dir).map_err(|e| format!("canonicalize failed: {e}"))?;
    Ok(ConversationInfo {
        cwd: cwd.to_string_lossy().to_string(),
    })
}

/// 供前端做"是否对话"前缀判断：返回 ~/.pi/agent/works 的 canonical 路径。
#[tauri::command]
pub async fn get_works_dir() -> Result<String, String> {
    let base = works_dir().ok_or("works directory unavailable")?;
    std::fs::create_dir_all(&base).map_err(|e| format!("create works dir failed: {e}"))?;
    let canon = std::fs::canonicalize(&base).map_err(|e| format!("canonicalize failed: {e}"))?;
    Ok(canon.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn works_dir_under_pi_agent() {
        let d = works_dir().unwrap();
        assert!(d.ends_with("works"));
        assert!(d.to_string_lossy().replace('\\', "/").contains(".pi/agent/works"));
    }
}
```

- [ ] **步骤 2：在 `commands/mod.rs` 注册模块**

在 `commands/mod.rs` 顶部加 `pub mod workspaces;`，并按现有 `pub use` 风格重导出（参考其它 `pub use xxx::*;` 或具名导出）。

- [ ] **步骤 3：在 `lib.rs` 注册命令**

`invoke_handler` 列表中加入：

```rust
commands::workspaces::create_conversation,
commands::workspaces::get_works_dir,
```

- [ ] **步骤 4：运行测试与编译检查**

运行：`cd tauri-agent/src-tauri && cargo test workspaces:: && cargo check`
预期：测试 PASS；编译通过。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/workspaces.rs tauri-agent/src-tauri/src/commands/mod.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(tauri): add works dir + create_conversation/get_works_dir commands"
```

---

## 任务 T2：`AppState::forget_workspace` + 共享会话辅助 + `delete_sessions_for_cwd`

**文件：**
- 修改：`tauri-agent/src-tauri/src/state/app_state.rs`
- 修改：`tauri-agent/src-tauri/src/commands/sessions.rs`（辅助提 `pub(crate)`）
- 修改：`tauri-agent/src-tauri/src/commands/workspaces.rs`

- [ ] **步骤 1：`app_state.rs` 写失败测试**

在 `app_state.rs` 的 `mod tests` 内追加：

```rust
#[test]
fn forget_workspace_removes_recent_and_last_session() {
    let mut st = AppState::default();
    st.touch_workspace("/ws/a");
    st.set_last_session("/ws/a", "/sessions/a.jsonl");
    st.forget_workspace("/ws/a");
    assert!(!st.recent_workspaces.iter().any(|w| w == "/ws/a"));
    assert!(st.last_session("/ws/a").is_none());
}
```

- [ ] **步骤 2：运行验证失败**

运行：`cd tauri-agent/src-tauri && cargo test forget_workspace_removes`
预期：FAIL，`forget_workspace` 未定义。

- [ ] **步骤 3：实现 `forget_workspace`**

在 `app_state.rs` `impl AppState` 内加：

```rust
/// 从 recent_workspaces + last_sessions 中彻底移除一个 workspace。
pub fn forget_workspace(&mut self, ws: &str) {
    self.recent_workspaces.retain(|w| w != ws);
    self.last_sessions.remove(ws);
}
```

- [ ] **步骤 4：运行验证通过**

运行：`cd tauri-agent/src-tauri && cargo test forget_workspace_removes`
预期：PASS。

- [ ] **步骤 5：把 `sessions.rs` 辅助提为 `pub(crate)`**

将 `sessions.rs` 中以下函数签名的 `fn` 改为 `pub(crate) fn`（保持实现不变）：`sessions_dir`、`collect_session_files`、`read_first_line`、`paths_equivalent`。（`parse_session_header` 已是 `pub`。）

- [ ] **步骤 6：在 `workspaces.rs` 实现 `delete_sessions_for_cwd` + 测试**

```rust
use crate::commands::sessions::{
    collect_session_files, paths_equivalent, parse_session_header, read_first_line, sessions_dir,
};

/// 删除 sessions/ 下所有 header.cwd 等价于 `cwd` 的 .jsonl，返回删除条数。
/// 仅在 sessions 根内操作，跳过符号链接/非 jsonl。
fn delete_sessions_for_cwd(cwd: &str) -> Result<usize, String> {
    let sessions_root = sessions_dir().ok_or("sessions directory unavailable")?;
    let canonical_sessions = match std::fs::canonicalize(&sessions_root) {
        Ok(c) => c,
        Err(_) => return Ok(0), // 目录不存在 → 无会话可删
    };
    let mut files = Vec::new();
    collect_session_files(&canonical_sessions, &mut files);
    let mut count = 0usize;
    for path in files {
        let first = match read_first_line(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let path_str = path.to_string_lossy().to_string();
        let info = match parse_session_header(&first, &path_str) {
            Some(i) => i,
            None => continue,
        };
        let matches = info
            .cwd
            .as_deref()
            .map(|c| paths_equivalent(c, cwd))
            .unwrap_or(false);
        if !matches {
            continue;
        }
        let canon = match std::fs::canonicalize(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !canon.starts_with(&canonical_sessions) {
            continue;
        }
        if canon.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if std::fs::symlink_metadata(&path)
            .map(|m| m.is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            count += 1;
        }
    }
    Ok(count)
}
```

测试（追加到 `workspaces.rs` 的 `mod tests`，构造临时 sessions 根需要可注入路径——这里仅测纯匹配判据，I/O 删除留待手动验证）：

```rust
#[test]
fn delete_matcher_uses_paths_equivalent() {
    // 验证 header.cwd 与目标 cwd 的等价判断（Windows 分隔符/大小写）
    let with = "{\"type\":\"session\",\"id\":\"a\",\"cwd\":\"C:/ws/a\",\"timestamp\":\"t\"}\n";
    let info = parse_session_header(with, "/tmp/a.jsonl").unwrap();
    assert!(paths_equivalent(info.cwd.as_deref().unwrap(), "C:\\ws\\a"));
}
```

- [ ] **步骤 7：编译检查 + Commit**

运行：`cd tauri-agent/src-tauri && cargo test workspaces:: forget_workspace && cargo check`
预期：PASS + 编译通过。

```bash
git add tauri-agent/src-tauri/src/state/app_state.rs tauri-agent/src-tauri/src/commands/sessions.rs tauri-agent/src-tauri/src/commands/workspaces.rs
git commit -m "feat(tauri): add forget_workspace + delete_sessions_for_cwd helpers"
```

---

## 任务 T3：`delete_conversation` 命令

**文件：** 修改 `tauri-agent/src-tauri/src/commands/workspaces.rs`、`lib.rs`

- [ ] **步骤 1：实现 `delete_conversation`**

```rust
/// FR-4：删除一个对话（works/<uuid> 整个目录 + 其会话文件 + 应用记录）。
#[tauri::command]
pub async fn delete_conversation(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<(), String> {
    let works_root = works_dir().ok_or("works directory unavailable")?;
    let canonical_works =
        std::fs::canonicalize(&works_root).map_err(|e| format!("invalid works root: {e}"))?;

    // 目录可能已被外部删除 → 幂等成功（仍清理记录）
    if let Ok(target) = std::fs::canonicalize(&workspace) {
        if !target.starts_with(&canonical_works) {
            return Err("not a conversation directory".into());
        }
        if std::fs::symlink_metadata(&workspace)
            .map(|m| m.is_symlink())
            .unwrap_or(false)
        {
            return Err("cannot delete symlinks".into());
        }
        mgr.close(&workspace).await;
        let _ = delete_sessions_for_cwd(&workspace);
        std::fs::remove_dir_all(&target).map_err(|e| format!("delete failed: {e}"))?;
    } else {
        mgr.close(&workspace).await;
        let _ = delete_sessions_for_cwd(&workspace);
    }

    let ws = workspace.clone();
    store.update(|st| st.forget_workspace(&ws)).await;
    Ok(())
}
```

- [ ] **步骤 2：`lib.rs` 注册**

`invoke_handler` 加 `commands::workspaces::delete_conversation,`

- [ ] **步骤 3：编译检查**

运行：`cd tauri-agent/src-tauri && cargo check`
预期：通过。

- [ ] **步骤 4：手动验证（执行时）**

启动应用 → 新建对话 → 删除对话 → 确认 `~/.pi/agent/works/<uuid>` 已删除、该会话从侧栏消失、对应 `sessions/` jsonl 已删。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/workspaces.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(tauri): add delete_conversation command"
```

---

## 任务 T4：`remove_project` 命令

**文件：** 修改 `tauri-agent/src-tauri/src/commands/workspaces.rs`、`lib.rs`

- [ ] **步骤 1：实现 `remove_project`**

```rust
/// FR-5：移除一个项目——仅清空其会话与应用记录，绝不删除真实目录。
#[tauri::command]
pub async fn remove_project(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<(), String> {
    mgr.close(&workspace).await;
    delete_sessions_for_cwd(&workspace)?;
    let ws = workspace.clone();
    store.update(|st| st.forget_workspace(&ws)).await;
    Ok(())
}
```

- [ ] **步骤 2：`lib.rs` 注册**

加 `commands::workspaces::remove_project,`

- [ ] **步骤 3：编译检查 + 手动验证**

运行：`cd tauri-agent/src-tauri && cargo check`（通过）。
手动：打开一个真实项目目录、产生若干会话 → 移除项目 → 确认**真实目录仍在**、其会话从侧栏消失、`sessions/` 内对应 jsonl 被删。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/workspaces.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(tauri): add remove_project command (keeps real dir)"
```

---

## 任务 T5：标题小模型启发式 + 标题清洗（纯函数 + 测试）

**文件：** 修改 `tauri-agent/src-tauri/src/commands/workspaces.rs`

- [ ] **步骤 1：写失败测试**

在 `workspaces.rs` `mod tests` 追加：

```rust
#[test]
fn pick_title_model_prefers_same_provider_lite_nonreasoning() {
    let models = vec![
        ("anthropic".to_string(), "claude-sonnet-4".to_string(), true),
        ("anthropic".to_string(), "claude-haiku-4".to_string(), false),
        ("openai".to_string(), "gpt-5-mini".to_string(), false),
    ];
    let got = pick_title_model(&models, Some("anthropic"), Some(("anthropic", "claude-sonnet-4")));
    assert_eq!(got, Some(("anthropic".to_string(), "claude-haiku-4".to_string())));
}

#[test]
fn pick_title_model_falls_back_to_current_when_no_lite() {
    let models = vec![("x".to_string(), "big-model".to_string(), true)];
    let got = pick_title_model(&models, Some("x"), Some(("x", "big-model")));
    assert_eq!(got, Some(("x".to_string(), "big-model".to_string())));
}

#[test]
fn clean_title_strips_think_and_truncates() {
    assert_eq!(clean_title("<think>hmm</think>\n  Refactor auth  \n"), Some("Refactor auth".to_string()));
    let long = "a".repeat(120);
    let t = clean_title(&long).unwrap();
    assert_eq!(t.chars().count(), 100);
    assert!(t.ends_with("..."));
    assert_eq!(clean_title("   \n  "), None);
}
```

- [ ] **步骤 2：运行验证失败**

运行：`cd tauri-agent/src-tauri && cargo test pick_title_model clean_title_strips`
预期：FAIL，函数未定义。

- [ ] **步骤 3：实现纯函数**

```rust
const LITE_KEYWORDS: &[&str] = &[
    "haiku", "mini", "flash", "lite", "small", "nano", "air", "8b", "7b", "4b", "1b",
];

fn is_lite(id: &str) -> bool {
    let l = id.to_lowercase();
    LITE_KEYWORDS.iter().any(|k| l.contains(k))
}

/// 三级 fallback 的「启发式」与「兜底」部分（设置项在 auto_title_session 内先行处理）。
/// models: (provider, id, reasoning)。返回 (provider, id)。
fn pick_title_model(
    models: &[(String, String, bool)],
    current_provider: Option<&str>,
    current_model: Option<(&str, &str)>,
) -> Option<(String, String)> {
    let same = |p: &str| current_provider.map(|cp| cp == p).unwrap_or(false);
    // 1) 同 provider + lite + 非 reasoning
    // 2) 同 provider + lite
    // 3) 任意 + lite + 非 reasoning
    // 4) 任意 + lite
    let candidates: [Box<dyn Fn(&(String, String, bool)) -> bool>; 4] = [
        Box::new(move |m| same(&m.0) && is_lite(&m.1) && !m.2),
        Box::new(move |m| same(&m.0) && is_lite(&m.1)),
        Box::new(|m| is_lite(&m.1) && !m.2),
        Box::new(|m| is_lite(&m.1)),
    ];
    for pred in candidates.iter() {
        if let Some(m) = models.iter().find(|m| pred(m)) {
            return Some((m.0.clone(), m.1.clone()));
        }
    }
    // 5) 兜底当前模型
    current_model.map(|(p, id)| (p.to_string(), id.to_string()))
}

/// 清洗 LLM 标题输出：去 <think> 段、取首个非空行、>100 字符截断为 97+"..."。
fn clean_title(raw: &str) -> Option<String> {
    let mut s = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find("<think>") {
        s.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => rest = &rest[start + end + "</think>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    s.push_str(rest);
    let line = s.lines().map(|l| l.trim()).find(|l| !l.is_empty())?;
    if line.is_empty() {
        return None;
    }
    if line.chars().count() > 100 {
        let truncated: String = line.chars().take(97).collect();
        Some(format!("{truncated}..."))
    } else {
        Some(line.to_string())
    }
}
```

- [ ] **步骤 4：运行验证通过**

运行：`cd tauri-agent/src-tauri && cargo test pick_title_model clean_title_strips`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/workspaces.rs
git commit -m "feat(tauri): add title model heuristic + title cleaning"
```

---

## 任务 T6：`auto_title_session` 命令（临时 print-mode sidecar）

**文件：** 修改 `tauri-agent/src-tauri/src/commands/workspaces.rs`、`pi/sidecar.rs`（`pi_package_dir` 提 `pub(crate)`）、`lib.rs`

- [ ] **步骤 1：把 `pi_package_dir` 提为 `pub(crate)`**

`pi/sidecar.rs` 中 `fn pi_package_dir()` → `pub(crate) fn pi_package_dir()`。

- [ ] **步骤 2：实现辅助 + 命令**

```rust
use serde_json::Value;
use tauri_plugin_shell::ShellExt;

use crate::pi::types::PiOutbound;

/// 从 get_messages 的 data 里取第一条 user 文本。
fn extract_first_user_text(data: Option<Value>) -> Option<String> {
    let msgs = data?.get("messages")?.as_array()?.clone();
    for m in msgs {
        if m.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        // content 可能是字符串或数组（含 {type:"text", text}）
        if let Some(s) = m.get("content").and_then(|c| c.as_str()) {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        }
        if let Some(arr) = m.get("content").and_then(|c| c.as_array()) {
            let text: String = arr
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// (provider, id) from RpcSessionState.model
fn extract_provider_model(state: &Value) -> (Option<String>, Option<String>) {
    let m = state.get("model");
    let p = m
        .and_then(|m| m.get("provider"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let id = m
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    (p, id)
}

/// 起临时 print-mode sidecar 生成标题（一次性，不写会话/不用工具）。
async fn run_pi_print_title(
    app: &tauri::AppHandle,
    cwd: &str,
    provider: &str,
    model: &str,
    prompt: &str,
    env: std::collections::HashMap<String, String>,
) -> Result<String, String> {
    let package_dir = crate::pi::sidecar::pi_package_dir();
    let output = app
        .shell()
        .sidecar("pi")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .args([
            "-p",
            "--no-session",
            "--no-tools",
            "--provider",
            provider,
            "--model",
            model,
            prompt,
        ])
        .env("PI_PACKAGE_DIR", &package_dir)
        .envs(env)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("title sidecar failed: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// FR-7：为对话生成并写回标题；失败静默返回 None。
#[tauri::command]
pub async fn auto_title_session(
    workspace: String,
    app: tauri::AppHandle,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<Option<String>, String> {
    let client = match mgr.get(&workspace).await {
        Some(c) => c,
        None => return Ok(None),
    };

    // 1) 首条 user 消息
    let msgs = client
        .send(PiOutbound::GetMessages { id: None })
        .await
        .map_err(|e| e.to_string())?;
    if !msgs.success {
        return Ok(None);
    }
    let first_user = match extract_first_user_text(msgs.data) {
        Some(t) => t,
        None => return Ok(None),
    };

    // 2) 当前 provider/model
    let state = client
        .send(PiOutbound::GetState { id: None })
        .await
        .ok()
        .and_then(|r| r.data);
    let (cur_provider, cur_model) = match &state {
        Some(s) => extract_provider_model(s),
        None => (None, None),
    };

    // 3) 选模型：设置项 → 启发式 → 兜底当前
    let settings = store.settings_all().await;
    let (provider, model) = if let Some(tm) = settings
        .get("titleModel")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        match tm.split_once('/') {
            Some((p, m)) => (p.to_string(), m.to_string()),
            None => return Ok(None),
        }
    } else {
        let avail = client
            .send(PiOutbound::GetAvailableModels { id: None })
            .await
            .ok()
            .and_then(|r| r.data);
        let list: Vec<(String, String, bool)> = avail
            .and_then(|d| d.get("models").and_then(|m| m.as_array()).cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| {
                Some((
                    m.get("provider")?.as_str()?.to_string(),
                    m.get("id")?.as_str()?.to_string(),
                    m.get("reasoning").and_then(|r| r.as_bool()).unwrap_or(false),
                ))
            })
            .collect();
        match pick_title_model(
            &list,
            cur_provider.as_deref(),
            cur_model.as_deref().and_then(|m| cur_provider.as_deref().map(|p| (p, m))),
        ) {
            Some(pm) => pm,
            None => return Ok(None),
        }
    };

    // 4) 临时 sidecar 生成
    let prompt = format!("Generate a title for this conversation:\n{first_user}");
    let env = store.settings_env().await;
    let raw = match run_pi_print_title(&app, &workspace, &provider, &model, &prompt, env).await {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let title = match clean_title(&raw) {
        Some(t) => t,
        None => return Ok(None),
    };

    // 5) 写回 set_session_name
    let resp = client
        .send(PiOutbound::SetSessionName {
            id: None,
            name: title.clone(),
        })
        .await
        .map_err(|e| e.to_string())?;
    if !resp.success {
        return Ok(None);
    }
    Ok(Some(title))
}
```

> 注：步骤 3 中 `cur_model` 与 `cur_provider` 组合传入 `pick_title_model` 的 `current_model`；执行时若借用冲突，改用中间变量绑定 `let cur = match (&cur_provider,&cur_model){ (Some(p),Some(m))=>Some((p.as_str(),m.as_str())), _=>None };`。

- [ ] **步骤 3：`lib.rs` 注册**

加 `commands::workspaces::auto_title_session,`

- [ ] **步骤 4：编译检查 + 手动验证**

运行：`cd tauri-agent/src-tauri && cargo check`（通过）。
手动：新建对话 → 发首条消息 → 等首轮结束 → 侧栏该对话标题被自动生成的摘要替换。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/workspaces.rs tauri-agent/src-tauri/src/pi/sidecar.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(tauri): add auto_title_session via ephemeral print sidecar"
```

---

## 任务 T7：dialog 插件依赖 + capabilities

**文件：** `tauri-agent/src-tauri/Cargo.toml`、`lib.rs`、`capabilities/default.json`、`package.json`

- [ ] **步骤 1：加 Rust 依赖**

`Cargo.toml` `[dependencies]` 加（版本对齐现有 tauri 2.x 插件）：

```toml
tauri-plugin-dialog = "2"
```

- [ ] **步骤 2：注册插件**

`lib.rs` 在其它 `.plugin(...)` 旁加：

```rust
.plugin(tauri_plugin_dialog::init())
```

- [ ] **步骤 3：capabilities 放行**

`capabilities/default.json` 的 `permissions` 数组加：

```json
"dialog:allow-open"
```

- [ ] **步骤 4：前端依赖**

运行：`cd tauri-agent && npm install @tauri-apps/plugin-dialog`

- [ ] **步骤 5：编译检查 + Commit**

运行：`cd tauri-agent/src-tauri && cargo check`（通过）。

```bash
git add tauri-agent/src-tauri/Cargo.toml tauri-agent/src-tauri/src/lib.rs tauri-agent/src-tauri/capabilities/default.json tauri-agent/package.json tauri-agent/package-lock.json
git commit -m "feat(tauri): add dialog plugin for directory picker"
```

---

## 任务 T8：`isUnder` 工具 + `pickDirectory`

**文件：** 修改 `tauri-agent/src/lib/pathUtils.ts`；新增 `tauri-agent/src/lib/dialog.ts`；新增 `tauri-agent/src/lib/pathUtils.test.ts`（若已存在则追加）

- [ ] **步骤 1：写失败测试**

`pathUtils.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { isUnder } from './pathUtils';

describe('isUnder', () => {
  it('matches prefix dir and self', () => {
    expect(isUnder('/a/b/c', '/a/b')).toBe(true);
    expect(isUnder('/a/b', '/a/b')).toBe(true);
  });
  it('rejects sibling sharing string prefix', () => {
    expect(isUnder('/a/bc', '/a/b')).toBe(false);
  });
  it('windows: case-insensitive + separators', () => {
    expect(isUnder('C:\\U\\x\\.pi\\agent\\works\\u1', 'c:/U/x/.pi/agent/works')).toBe(true);
  });
  it('empty inputs are false', () => {
    expect(isUnder('', '/a')).toBe(false);
    expect(isUnder('/a', '')).toBe(false);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd tauri-agent && npx vitest run src/lib/pathUtils.test.ts`
预期：FAIL，`isUnder` 未导出。

- [ ] **步骤 3：实现 `isUnder`**

在 `pathUtils.ts` 追加：

```typescript
export function isUnder(cwd: string, root: string): boolean {
  if (!cwd || !root) return false;
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  let c = norm(cwd);
  let r = norm(root);
  if (/^[a-zA-Z]:/.test(c) || /^[a-zA-Z]:/.test(r)) {
    c = c.toLowerCase();
    r = r.toLowerCase();
  }
  return c === r || c.startsWith(r + '/');
}
```

- [ ] **步骤 4：运行验证通过**

运行：`cd tauri-agent && npx vitest run src/lib/pathUtils.test.ts`
预期：PASS。

- [ ] **步骤 5：新增 `lib/dialog.ts`**

```typescript
import { open } from '@tauri-apps/plugin-dialog';

/** 目录选择器；用户取消返回 null。OS 选择器内可新建文件夹（满足"新建空白项目"）。 */
export async function pickDirectory(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false });
  return typeof result === 'string' ? result : null;
}
```

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/lib/pathUtils.ts tauri-agent/src/lib/pathUtils.test.ts tauri-agent/src/lib/dialog.ts
git commit -m "feat(ui): add isUnder path util + pickDirectory dialog wrapper"
```

---

## 任务 T9：`lib/pi.ts` 封装 + `store/session.ts` worksDir

**文件：** 修改 `tauri-agent/src/lib/pi.ts`、`tauri-agent/src/store/session.ts`

- [ ] **步骤 1：`pi.ts` 增加封装**

在 `export const pi = { ... }` 内加：

```typescript
  createConversation: () => invoke<{ cwd: string }>('create_conversation'),
  getWorksDir: () => invoke<string>('get_works_dir'),
  deleteConversation: (workspace: string) =>
    invoke<void>('delete_conversation', { workspace }),
  removeProject: (workspace: string) =>
    invoke<void>('remove_project', { workspace }),
  autoTitleSession: (workspace: string) =>
    invoke<string | null>('auto_title_session', { workspace }),
```

- [ ] **步骤 2：`store/session.ts` 增加 worksDir**

接口加 `worksDir: string;` 与 `setWorksDir: (dir: string) => void;`；初值 `worksDir: ''`；实现 `setWorksDir: (worksDir) => set({ worksDir }),`。

- [ ] **步骤 3：类型检查 + Commit**

运行：`cd tauri-agent && npx tsc --noEmit`（通过）。

```bash
git add tauri-agent/src/lib/pi.ts tauri-agent/src/store/session.ts
git commit -m "feat(ui): add conversation/project pi bindings + worksDir state"
```

---

## 任务 T10：`useConversations` + `useProjectGroups` worksDir 过滤

**文件：** 新增 `tauri-agent/src/features/sessions/useConversations.ts`（+ `.test.ts`）；修改 `useProjectGroups.ts`（+ 现有 `.test.ts` 若有）

- [ ] **步骤 1：`useProjectGroups.ts` 加 worksDir 过滤（先改纯函数）**

`BuildParams` 加 `worksDir: string;`；`buildProjectGroups` 分组循环顶部加过滤：

```typescript
  for (const s of sessions) {
    if (!s.cwd) continue;
    if (params.worksDir && isUnder(s.cwd, params.worksDir)) continue; // 排除对话
    if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
    byCwd.get(s.cwd)!.push(s);
  }
```

文件顶部 `import { isUnder } from '../../lib/pathUtils';`；`useProjectGroups()` 内从 store 读 `worksDir` 并传入；依赖数组加 `worksDir`。

- [ ] **步骤 2：`buildProjectGroups` 过滤测试**

在 `useProjectGroups.test.ts`（无则新建）：

```typescript
import { describe, it, expect } from 'vitest';
import { buildProjectGroups } from './useProjectGroups';
import type { SessionInfo } from '../../lib/pi';

const s = (cwd: string, ts: string): SessionInfo => ({ id: cwd+ts, path: cwd+'/'+ts+'.jsonl', cwd, timestamp: ts, name: null });

describe('buildProjectGroups worksDir filter', () => {
  it('excludes sessions under worksDir', () => {
    const sessions = [s('/home/.pi/agent/works/u1', 't1'), s('/proj/a', 't2')];
    const groups = buildProjectGroups(sessions, {
      current: '', pinnedProjects: [], hiddenProjects: [], aliases: {}, keyword: '',
      worksDir: '/home/.pi/agent/works',
    });
    expect(groups.map((g) => g.cwd)).toEqual(['/proj/a']);
  });
});
```

运行：`cd tauri-agent && npx vitest run src/features/sessions/useProjectGroups.test.ts`（PASS）。

- [ ] **步骤 3：新增 `useConversations.ts`**

```typescript
import { useMemo } from 'react';
import type { SessionInfo } from '../../lib/pi';
import { useSessionStore } from '../../store/session';
import { isUnder } from '../../lib/pathUtils';

export interface ConversationItem {
  cwd: string;
  sessionPath: string;
  name: string;
  timestamp: string;
  isCurrent: boolean;
}

export function friendlyTime(ts: string | null): string {
  if (!ts) return '新对话';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '新对话';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())} 对话`;
}

export function buildConversations(
  all: SessionInfo[],
  worksDir: string,
  current: string,
  keyword: string,
): ConversationItem[] {
  if (!worksDir) return [];
  const byCwd = new Map<string, SessionInfo[]>();
  for (const s of all) {
    if (!s.cwd || !isUnder(s.cwd, worksDir)) continue;
    if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
    byCwd.get(s.cwd)!.push(s);
  }
  let items: ConversationItem[] = [];
  for (const [cwd, list] of byCwd) {
    const sorted = [...list].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    const rep = sorted[0];
    items.push({
      cwd,
      sessionPath: rep.path,
      name: rep.name || friendlyTime(rep.timestamp),
      timestamp: rep.timestamp ?? '',
      isCurrent: cwd === current,
    });
  }
  const kw = keyword.trim().toLowerCase();
  if (kw) items = items.filter((c) => c.name.toLowerCase().includes(kw));
  items.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  return items;
}

export function useConversations(): ConversationItem[] {
  const all = useSessionStore((s) => s.allSessions);
  const worksDir = useSessionStore((s) => s.worksDir);
  const current = useSessionStore((s) => s.activeWorkspace);
  const keyword = useSessionStore((s) => s.searchKeyword);
  return useMemo(
    () => buildConversations(all, worksDir, current, keyword),
    [all, worksDir, current, keyword],
  );
}
```

- [ ] **步骤 4：`useConversations` 测试**

`useConversations.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { buildConversations } from './useConversations';
import type { SessionInfo } from '../../lib/pi';

const mk = (cwd: string, ts: string, name: string | null): SessionInfo => ({ id: cwd+ts, path: `${cwd}/${ts}.jsonl`, cwd, timestamp: ts, name });

describe('buildConversations', () => {
  it('folds each works cwd to one item, latest first, name fallback', () => {
    const all = [
      mk('/w/works/u1', '2026-01-01T00:00:00Z', null),
      mk('/w/works/u1', '2026-01-02T00:00:00Z', 'Renamed'),
      mk('/proj/a', '2026-01-03T00:00:00Z', 'proj'),
    ];
    const items = buildConversations(all, '/w/works', '/w/works/u1', '');
    expect(items).toHaveLength(1);
    expect(items[0].cwd).toBe('/w/works/u1');
    expect(items[0].name).toBe('Renamed');
    expect(items[0].isCurrent).toBe(true);
  });
});
```

运行：`cd tauri-agent && npx vitest run src/features/sessions/useConversations.test.ts`（PASS）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/sessions/useConversations.ts tauri-agent/src/features/sessions/useConversations.test.ts tauri-agent/src/features/sessions/useProjectGroups.ts tauri-agent/src/features/sessions/useProjectGroups.test.ts
git commit -m "feat(ui): conversations derivation + exclude works from project groups"
```

---

## 任务 T11：侧栏 UI（对话区 + 项目区 header/菜单 + 移除项目）

**文件：** 修改 `Sidebar.tsx`、`SidebarActions.tsx`、`ProjectItem.tsx`

> 现有大组件遵循其模式做增量改动，不整体重写。

- [ ] **步骤 1：`Sidebar` props 扩展**

`SidebarProps` 增加：

```typescript
  onNewConversation: () => void;
  onOpenProject: () => void;
  onDeleteConversation: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
```

- [ ] **步骤 2：`Sidebar` 渲染「对话」区（置于「项目」之上）**

在 `Sidebar` 内用 `useConversations()` 取列表，新增分区（section header「对话」+ 右上「新建对话」`ActionIcon icon={MessageSquarePlus} title="新建对话 (Ctrl+Alt+N)" onClick={props.onNewConversation}`），下方用现有 `SessionItem` 平铺：

```tsx
{conversations.length > 0 && <div className={styles.sec}>对话</div>}
{conversations.map((c) => (
  <SessionItem
    key={c.cwd}
    title={c.name}
    active={activeSessionPath === c.sessionPath}
    running={props.runningSessionPath === c.sessionPath}
    pinned={false}
    editing={renamingPath === c.sessionPath}
    onClick={() => props.onOpenSession(c.cwd, c.sessionPath)}
    onPinToggle={() => {}}
    onRequestRename={() => setRenamingPath(c.sessionPath)}
    onRename={(name) => handleSubmitRename(c.cwd, c.sessionPath, name)}
    onDelete={() => props.onDeleteConversation(c.cwd)}
  />
))}
```

- [ ] **步骤 3：「项目」区 header 增加「新建项目」菜单**

在「项目」section header 右侧加一个下拉（`@lobehub/ui` 的 `Dropdown` 或 `base-ui` `DropdownMenu`），两项均调 `props.onOpenProject`：

```tsx
// 菜单项：{ key: 'blank', label: '新建空白项目' }, { key: 'existing', label: '使用现有文件夹' }
// onClick: () => props.onOpenProject()
```

> 两项行为一致（都开目录选择器），仅文案区分；"新建空白项目"引导用户在选择器内新建文件夹。

- [ ] **步骤 4：`SidebarActions` 调整**

移除全局「新建会话」（其职责由对话区「新建对话」+ 项目区「新建项目」承担），保留「搜索会话」。`App.tsx` 不再用 `SidebarActions onNew`（或将 `onNew` 改为可选并停用）。

- [ ] **步骤 5：`ProjectItem` 增加「移除项目」**

`ProjectItem` props 加 `onRemove: () => void;`，在其菜单（reveal/rename/hide 同处）加一项「移除项目」（红色/危险样式），`ProjectGroup` 透传 `onRemoveProject(g.cwd)`，`Sidebar` 的 `GroupList` 再透传到 `ProjectGroup`。

- [ ] **步骤 6：类型检查 + 手动验证 + Commit**

运行：`cd tauri-agent && npx tsc --noEmit`（通过）。
手动：侧栏出现「对话」区（带新建对话按钮）与「项目」区（带新建项目菜单 + 项目项「移除项目」）。

```bash
git add tauri-agent/src/features/sessions/Sidebar.tsx tauri-agent/src/features/sessions/SidebarActions.tsx tauri-agent/src/features/sessions/ProjectItem.tsx
git commit -m "feat(ui): sidebar conversation section + project new-menu + remove project"
```

---

## 任务 T12：`App.tsx` 接线（handlers + 启动默认 + 快捷键 + 自动标题）

**文件：** 修改 `tauri-agent/src/App.tsx`

- [ ] **步骤 1：启动时加载 worksDir + 启动默认 workspace**

在 `App` 的初始化 `useEffect`（现设 `INITIAL_WORKSPACE` 处）改为：

```typescript
useEffect(() => {
  void (async () => {
    try {
      const wd = await pi.getWorksDir();
      useSessionStore.getState().setWorksDir(wd);
    } catch { /* ignore */ }
    let ws: string;
    try {
      const all = await pi.listAllSessions();
      ws = all[0]?.cwd ?? (await pi.createConversation()).cwd;
    } catch {
      ws = (await pi.createConversation()).cwd;
    }
    useSessionStore.getState().setActiveWorkspace(ws);
  })();
  return () => { void pi.closeWorkspace(useSessionStore.getState().activeWorkspace); };
}, []);
```

> 同时把 `activeWorkspace` 初值由 `'.'` 改为 `''`（store 默认），并让 `AgentStoreProvider`/`Workspace` 在 `activeWorkspace === ''` 时显示 `FullscreenLoading`，避免空 workspace 触发 openWorkspace。

- [ ] **步骤 2：在 `Workspace` 增加 handlers**

按规格 §5.5 加入 `handleNewConversation / handleOpenProject / handleDeleteConversation / handleRemoveProject / goToSafeWorkspace`（代码见规格），并：
- `import { pickDirectory } from './lib/dialog';`
- `import { isUnder } from './lib/pathUtils';`

`goToSafeWorkspace`：

```typescript
const goToSafeWorkspace = useCallback(async () => {
  await refreshAllSessions(true);
  const all = useSessionStore.getState().allSessions;
  const next = all[0]?.cwd;
  const st = useSessionStore.getState();
  st.setActiveSession('');
  if (next) st.setActiveWorkspace(next);
  else { const { cwd } = await pi.createConversation(); st.setActiveWorkspace(cwd); }
}, []);
```

- [ ] **步骤 3：Ctrl+Alt+N 快捷键**

```typescript
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.altKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      void handleNewConversation();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [handleNewConversation]);
```

- [ ] **步骤 4：agent_end → 自动标题**

```typescript
useEffect(() => {
  let un: undefined | (() => void);
  void onPiEvent((e) => {
    if ((e.event as { type?: string })?.type !== 'agent_end') return;
    const ws = e.workspace;
    if (!isUnder(ws, useSessionStore.getState().worksDir)) return;
    void (async () => {
      const title = await pi.autoTitleSession(ws);
      if (title) { invalidateAllSessionsCache(); void refreshAllSessions(true); }
    })();
  }).then((f) => { un = f; });
  return () => un?.();
}, []);
```

`import { onPiEvent } from './lib/pi';`（若已导入则复用）。

- [ ] **步骤 5：把新 handlers 透传到 `SidebarPanel` → `Sidebar`**

`SidebarPanel` props 与 `Sidebar` 调用补齐 `onNewConversation / onOpenProject / onDeleteConversation / onRemoveProject`。

- [ ] **步骤 6：类型检查 + 手动验证 + Commit**

运行：`cd tauri-agent && npx tsc --noEmit`（通过）。
手动：启动恢复最近会话或新建对话；Ctrl+Alt+N 新建对话；打开项目；删除对话/移除项目后自动切到安全 workspace；对话首轮后标题刷新。

```bash
git add tauri-agent/src/App.tsx
git commit -m "feat(ui): wire conversation/project handlers, startup default, hotkey, auto-title"
```

---

## 任务 T13：设置项 `titleModel` + 不注入 sidecar env

**文件：** 修改设置面板（`features/settings/*`）、`state/app_state.rs`

- [ ] **步骤 1：`settings_env` 过滤 `titleModel`（后端）**

`app_state.rs` 的 `settings_env`：

```rust
pub fn settings_env(&self) -> HashMap<String, String> {
    self.settings
        .iter()
        .filter(|(k, v)| k.as_str() != "titleModel" && !v.trim().is_empty())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}
```

并在 `mod tests` 加断言：含 `titleModel` 的设置不出现在 `settings_env()`。

运行：`cd tauri-agent/src-tauri && cargo test settings`（PASS）。

- [ ] **步骤 2：设置面板新增「对话标题模型（可选）」字段**

按 `features/settings/settingsSchema.ts` 现有字段模式，加一项 key=`titleModel`，placeholder `provider/model（留空自动选择）`。提交仍走现有 `pi.setSettings`（整表替换）。

- [ ] **步骤 3：类型检查 + Commit**

运行：`cd tauri-agent && npx tsc --noEmit`（通过）；`cd tauri-agent/src-tauri && cargo check`（通过）。

```bash
git add tauri-agent/src/features/settings tauri-agent/src-tauri/src/state/app_state.rs
git commit -m "feat: add optional titleModel setting (excluded from sidecar env)"
```

---

## 自检（规格覆盖度对照）

| 规格 FR | 实现任务 |
|---|---|
| FR-1 新建对话 | T1（create_conversation）+ T11（按钮）+ T12（handler/hotkey） |
| FR-2 新建项目（空白/现有文件夹） | T7（dialog）+ T8（pickDirectory）+ T11（菜单）+ T12（handleOpenProject） |
| FR-3 对话列表 | T10（useConversations）+ T11（对话区渲染） |
| FR-4 删除对话 | T3（delete_conversation）+ T11/T12（入口/handler） |
| FR-5 移除项目 | T4（remove_project）+ T11/T12（入口/handler） |
| FR-6 模式隔离 | T10（works 过滤 + 对话仅 works） |
| FR-7 自动标题 | T5（启发式/清洗）+ T6（auto_title_session）+ T12（agent_end 触发） |
| FR-8 启动默认 | T12（pickStartupWorkspace） |
| 安全边界 | T2/T3/T4（边界校验、真实目录保护、进程清理）+ T13（titleModel 不入 env） |

**类型一致性检查：** 命令名 `create_conversation/get_works_dir/delete_conversation/remove_project/auto_title_session` 在 Rust（T1/T3/T4/T6）、`lib.rs` 注册、`pi.ts` 封装（T9）、调用点（T12）四处一致；`isUnder`（T8）被 T10/T12 复用；`worksDir`（T9）被 T10/T12 读取；`forget_workspace`（T2）被 T3/T4 调用；`pick_title_model/clean_title`（T5）被 T6 调用；`pi_package_dir`（T6 提 pub(crate)）被 `run_pi_print_title` 复用。

**占位符扫描：** 无 TODO/待定；每个代码步骤含完整代码或明确的现有模式引用。T6 步骤 2 的借用注记为执行提示，非占位。

## 执行交接

计划完成并保存到 `docs/superpowers/plans/2026-06-14-conversation-vs-project-plan.md`。

因本仓库**禁止子代理**，采用 **`superpowers:executing-plans` 内联执行**：按 T1→T13 顺序，每个任务跑测试/编译 → 手动验证 → commit；后端先行（T1–T7）保证命令就绪，再前端（T8–T13）接入。

